// Trade hub client: what the app calls to onboard a user and trade on their OWN HyperCore account
// (perps, spot, HIP-4 outcomes). We never hold user funds or take the other side of their trades.
// By default there is no builder fee. The app configures a tiny one (0.1 bp) only to attribute orders to Neuriio
// (points: the indexer counts fills that carry a builder fee), not as revenue.
//
// Signing model (standard for HyperCore front ends):
//   - once, with the user's MAIN wallet: approve an app agent key (plus a builder fee, only if configured)
//   - every trade: signed silently by the agent (it can trade, but can never withdraw)
//
// `wallet` arguments accept anything the Hyperliquid SDK accepts (viem account, browser wallet).
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { ApproveAgentTypes, ApproveBuilderFeeTypes } from "@nktkas/hyperliquid/api/exchange";
import { getWalletChainId, signUserSignedAction } from "@nktkas/hyperliquid/signing";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MarketCatalog, normalizeMarkets } from "./markets.mjs";
import { buildOrderPlan, MAX_BUILDER_FEE, planCollateralMove } from "./orders.mjs";
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
    const usdc = spotMeta.tokens.find((t) => t.name === "USDC");
    this.usdcToken = usdc ? `${usdc.name}:${usdc.tokenId}` : null; // sendAsset token id
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

  /**
   * Like createAgent, but only SIGNS now. HyperCore refuses actions from an account that has never
   * received a deposit, so a brand-new user signs this during setup and the app submits it right
   * after their first bridge-in lands (submitAgentApproval). HyperCore accepts a signed action for
   * about 2 days after its nonce; past that, sign again.
   */
  async signAgentApproval(mainWallet, name = "neuriio") {
    const key = generatePrivateKey();
    const agent = privateKeyToAccount(key);
    const action = {
      type: "approveAgent",
      signatureChainId: await getWalletChainId(mainWallet),
      hyperliquidChain: this.transport.isTestnet ? "Testnet" : "Mainnet",
      agentAddress: agent.address.toLowerCase(),
      agentName: name,
      nonce: Date.now(),
    };
    const signature = await signUserSignedAction({ wallet: mainWallet, action, types: ApproveAgentTypes });
    return { key, address: agent.address, approval: { action, signature, nonce: action.nonce } };
  }

  /**
   * Like approveBuilder, but only SIGNS now (same reason as signAgentApproval: a brand-new HyperCore account
   * refuses actions until its first deposit). Returns null when no builder fee is configured.
   */
  async signBuilderApproval(mainWallet) {
    const rate = this.requiredBuilderRate();
    if (!rate) return null;
    const action = {
      type: "approveBuilderFee",
      signatureChainId: await getWalletChainId(mainWallet),
      hyperliquidChain: this.transport.isTestnet ? "Testnet" : "Mainnet",
      maxFeeRate: rate,
      builder: this.builder.address.toLowerCase(),
      nonce: Date.now(),
    };
    const signature = await signUserSignedAction({ wallet: mainWallet, action, types: ApproveBuilderFeeTypes });
    return { action, signature, nonce: action.nonce };
  }

  /** Submits a pre-signed builder approval. No-op if none is configured or the user already approved enough. */
  async submitBuilderApproval(user, approval) {
    const needed = this._maxBuilderFee();
    if (!approval || !needed) return { skipped: true };
    const approved = await this.info.maxBuilderFee({ user, builder: this.builder.address }).catch(() => 0);
    if (approved >= needed) return { alreadyApproved: true };
    const { action, signature, nonce } = approval;
    const res = await this.transport.request("exchange", { action, signature, nonce });
    if (res?.status !== "ok") throw new Error(`builder approval failed: ${JSON.stringify(res?.response ?? res)}`);
    return { approved: true };
  }

  /** Submits a pre-signed agent approval. Safe to call again: an already-approved agent is a no-op. */
  async submitAgentApproval(user, { action, signature, nonce }) {
    const agents = await this.info.extraAgents({ user }).catch(() => []);
    if (agents.some((a) => a.address.toLowerCase() === action.agentAddress)) return { alreadyApproved: true };
    const res = await this.transport.request("exchange", { action, signature, nonce });
    if (res?.status !== "ok") throw new Error(`agent approval failed: ${JSON.stringify(res?.response ?? res)}`);
    return { approved: true };
  }

  // ---------------------------------------------------------------- trading

  /** Everything the confirm screen shows, without signing anything. */
  preview(marketKey, intent) {
    return buildOrderPlan(this.market(marketKey), intent, { builder: this.builder }).summary;
  }

  /**
   * @param {object} [opts]
   * @param {string} [opts.fundFrom]  the user's address: first move USDC between their perps and spot
   *        balances if this order needs it (agent-signed, no wallet prompt). One-click buys pass it.
   * @param {boolean} [opts.leverageSet]  leverage already set via setLeverage (skip that step)
   */
  async placeOrder(agentWallet, marketKey, intent, { fundFrom, leverageSet = false } = {}) {
    const { actions, summary } = buildOrderPlan(this.market(marketKey), intent, { builder: this.builder });
    const ex = this._exchange(agentWallet);
    const funded = fundFrom ? await this._fund(ex, fundFrom, summary, intent) : null;
    let result;
    for (const a of actions) {
      if (a.type === "updateLeverage") {
        if (!leverageSet) await ex.updateLeverage(a.params);
      } else {
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
    return { summary, funded, statuses: result.response.data.statuses.map(parseStatus) };
  }

  /**
   * Just the leverage step of an order, so it can run ahead of time (e.g. while a one-click
   * deposit is bridging). Returns false when the order needs none (spot/outcome).
   */
  async setLeverage(agentWallet, marketKey, intent) {
    const lev = buildOrderPlan(this.market(marketKey), intent, { builder: this.builder }).actions.filter((a) => a.type === "updateLeverage");
    for (const a of lev) await this._exchange(agentWallet).updateLeverage(a.params);
    return lev.length > 0;
  }

  /** Free USDC in each of the user's HyperCore balances. */
  async usdcBalances(user) {
    const [perp, spot] = await Promise.all([
      this.info.clearinghouseState({ user }),
      this.info.spotClearinghouseState({ user }),
    ]);
    const s = spot.balances.find((b) => b.coin === "USDC");
    return { perp: Number(perp.withdrawable), spot: s ? Number(s.total) - Number(s.hold) : 0 };
  }

  async _fund(ex, user, summary, intent) {
    const move = planCollateralMove(summary, await this.usdcBalances(user), intent);
    if (!move) return null;
    if (!this.usdcToken) throw new Error("USDC token id unknown (call init first)");
    await ex.agentSendAsset({ destination: user, token: this.usdcToken, ...move });
    return move;
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
