// Trade hub client: what the app calls to onboard a user and trade on their OWN HyperCore account
// (perps, spot, HIP-4 outcomes). We never hold user funds or take the other side of their trades.
// Revenue model is a subscription, so by default there is no builder fee: users pay only
// HyperCore's own trading fees. (A builder can still be configured if that ever changes.)
//
// Signing model (standard for HyperCore front ends):
//   - once, with the user's MAIN wallet: approve an app agent key (plus a builder fee, only if configured)
//   - every trade: signed silently by the agent (it can trade, but can never withdraw)
//
// `wallet` arguments accept anything the Hyperliquid SDK accepts (viem account, browser wallet).
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MarketCatalog, normalizeMarkets } from "./markets.mjs";
import { buildOrderPlan, MAX_BUILDER_FEE } from "./orders.mjs";
import { summarizePortfolio } from "./portfolio.mjs";

export class TradeHub {
  /**
   * @param {object} o
   * @param {boolean} [o.testnet]
   * @param {{address: string, fees: {perp: number, spot: number, outcome: number}}} [o.builder]
   *        optional; fees in tenths of a bp (50 = 0.05%). Omit for no builder fee.
   */
  constructor({ testnet = false, builder = null, transport }) {
    this.transport = transport ?? new HttpTransport({ isTestnet: testnet });
    this.info = new InfoClient({ transport: this.transport });
    this.builder = builder;
    this.catalog = null;
  }

  async init() {
    const [meta, spotMeta, outcomeMeta, mids] = await Promise.all([
      this.info.meta(),
      this.info.spotMeta(),
      this.info.outcomeMeta().catch(() => null), // network without HIP-4
      this.info.allMids(),
    ]);
    this.catalog = new MarketCatalog(normalizeMarkets({ meta, spotMeta, outcomeMeta, mids }));
    return this;
  }

  async refreshPrices() {
    this.catalog.updateMids(await this.info.allMids());
  }

  market(key) {
    return this.catalog.get(key);
  }

  // ---------------------------------------------------------------- onboarding

  /** Highest builder fee we charge, in tenths of a bp (0 = no builder fee). */
  _maxBuilderFee() {
    return this.builder ? Math.max(0, ...Object.values(this.builder.fees)) : 0;
  }

  /** Builder fee rate the user must approve, or null when we charge none. */
  requiredBuilderRate() {
    const f = this._maxBuilderFee();
    return f > 0 ? `${f / 1000}%` : null;
  }

  async onboardingStatus(user) {
    const needed = this._maxBuilderFee();
    const [approved, agents] = await Promise.all([
      needed > 0 ? this.info.maxBuilderFee({ user, builder: this.builder.address }) : 0,
      this.info.extraAgents({ user }).catch(() => []),
    ]);
    return {
      builderFeeRequired: needed > 0,
      builderApproved: approved >= needed,
      approvedBuilderFee: approved, // tenths of a bp
      agents: agents.map((a) => ({ name: a.name, address: a.address, validUntil: a.validUntil })),
    };
  }

  /** One-time, signed by the user's MAIN wallet. No-op when we charge no builder fee. */
  async approveBuilder(mainWallet) {
    const rate = this.requiredBuilderRate();
    if (!rate) return null;
    return this._exchange(mainWallet).approveBuilderFee({ builder: this.builder.address, maxFeeRate: rate });
  }

  /**
   * One-time, signed by the user's MAIN wallet: creates a trade-only agent key for the app.
   * Store the returned key only on the user's device.
   */
  async createAgent(mainWallet, name = "elysium") {
    const key = generatePrivateKey();
    const agent = privateKeyToAccount(key);
    await this._exchange(mainWallet).approveAgent({ agentAddress: agent.address, agentName: name });
    return { key, address: agent.address };
  }

  // ---------------------------------------------------------------- trading

  /** Everything the confirm screen shows, without signing anything. */
  preview(marketKey, intent) {
    return buildOrderPlan(this.market(marketKey), intent, { builder: this.builder }).summary;
  }

  async placeOrder(agentWallet, marketKey, intent) {
    const { actions, summary } = buildOrderPlan(this.market(marketKey), intent, { builder: this.builder });
    const ex = this._exchange(agentWallet);
    let result;
    for (const a of actions) {
      if (a.type === "updateLeverage") await ex.updateLeverage(a.params);
      else {
        try {
          result = await ex.order(a.params);
        } catch (e) {
          // The SDK throws when any order status is an error (e.g. an IOC with nothing to match);
          // those are normal trading outcomes, so return them like any other status.
          if (!e.response?.response?.data?.statuses) throw e;
          result = e.response;
        }
      }
    }
    return { summary, statuses: result.response.data.statuses.map(parseStatus) };
  }

  /** Market-close an entire perp position. */
  async closePosition(agentWallet, user, marketKey) {
    const m = this.market(marketKey);
    const st = await this.info.clearinghouseState({ user });
    const pos = st.assetPositions.find((p) => p.position.coin === m.coin);
    if (!pos) throw new Error(`no open ${m.symbol} position`);
    const size = Number(pos.position.szi);
    return this.placeOrder(agentWallet, marketKey, { side: size > 0 ? "sell" : "buy", size: Math.abs(size), reduceOnly: true });
  }

  async cancel(agentWallet, marketKey, oid) {
    return this._exchange(agentWallet).cancel({ cancels: [{ a: this.market(marketKey).id, o: oid }] });
  }

  async openOrders(user) {
    return this.info.frontendOpenOrders({ user });
  }

  // ---------------------------------------------------------------- portfolio & revenue

  async portfolio(user) {
    const [perpState, spotState, mids] = await Promise.all([
      this.info.clearinghouseState({ user }),
      this.info.spotClearinghouseState({ user }),
      this.info.allMids(),
    ]);
    this.catalog.updateMids(mids);
    return summarizePortfolio({ perpState, spotState, catalog: this.catalog });
  }

  /** Builder-fee revenue, if a builder is configured (accrues on HyperCore to the builder account). */
  async builderRevenue() {
    if (!this.builder) return { builderRewards: 0, unclaimed: 0 };
    const r = await this.info.referral({ user: this.builder.address });
    return { builderRewards: Number(r.builderRewards), unclaimed: Number(r.unclaimedRewards) };
  }

  _exchange(wallet) {
    return new ExchangeClient({ transport: this.transport, wallet });
  }
}

function parseStatus(s) {
  if (s.filled) return { status: "filled", oid: s.filled.oid, size: Number(s.filled.totalSz), avgPx: Number(s.filled.avgPx) };
  if (s.resting) return { status: "resting", oid: s.resting.oid };
  if (s === "waitingForTrigger" || s === "waitingForFill") return { status: s };
  return { status: "error", error: s.error ?? JSON.stringify(s) };
}

export { MAX_BUILDER_FEE };
