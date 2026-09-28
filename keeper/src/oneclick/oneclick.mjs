// One-click buy: "pay with any Elysium token, get any HyperCore market". What the one-button UI calls.
//
//   const oc = await new OneClick({ pub, hub, sponsor, bridge, inventory }).init();
//   const q = await oc.quote({ user, payToken, amountIn, market: "BTC", leverage: 3 });   // live "est." as they type
//   const r = await oc.buy({ user, device, agent, payToken, amountIn, market: "BTC", leverage: 3,
//                            onStage: (stage, info) => animate(stage) });
//
// Under the hood (hidden from the user):
//   1. device session key signs a Buy -> sponsor submits it (no wallet prompt, no gas)
//      -> NeuriioAccount -> FastBridge (PropAMM converts the token to USDC)
//   2. relayer credits USDC to the user's own HyperCore account (~3-6 s)
//   3. trade agent moves USDC perps -> spot if the market needs it, then places the order
//
// Fast path when the user already has USDC on HyperCore (~1-2 s, only step 3):
//   const q = await oc.quoteFromHl({ user, usd: 50, market: "BTC", leverage: 3 });
//   const r = await oc.buyFromHl({ user, agent, usd: 50, market: "BTC", leverage: 3, quote: q, onStage });
import { parseAbi } from "viem";
import { signBuy } from "./account.mjs";
import { HL_FEES_BPS } from "../trade/orders.mjs";

const erc20Abi = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const bridgeAbi = parseAbi([
  "function usdc() view returns (address)",
  "function poolFor(address) view returns (address)",
  "function config() view returns (uint16 feeBps, uint64 minFee, uint64 maxDeposit, uint32 refundDelay, uint64 maxPayout, uint64 dailyPayoutCap)",
  "function deposits(uint256) view returns (address user, uint64 createdAt, uint8 status, address hlRecipient, uint96 amount, uint96 fee)",
]);
const poolAbi = parseAbi(["function previewSellBase(uint256 baseIn) view returns (uint256 quoteOut, uint256 priceWad)"]);
const FULFILLED = 2;
const REFUNDED = 3;
const ELYSIUM_EVERY = 5; // while watching HyperCore, also read the deposit on Elysium every Nth poll
const CREDIT_SEEN = 0.98; // pool conversion can land a hair under the preview (minUsdcOut bounds it)

/** Identifies what a quote was for, so buy() only reuses a quote for the exact same inputs. */
const quoteKey = ({ payToken, amountIn, market, leverage = 1, slippageBps = 50 }) =>
  [payToken.toLowerCase(), String(amountIn), market, leverage, slippageBps].join("|");
const hlQuoteKey = ({ usd, market, leverage = 1, slippageBps = 50 }) => ["hl", usd, market, leverage, slippageBps].join("|");

/** Stages reported to onStage, in order: drive the loading animation from these. */
export const STAGES = ["quoting", "sending", "bridging", "ordering", "done"];

/**
 * Largest order (USD margin for perps, USD spend for spot/outcomes) that `availUsd` can fund,
 * leaving room for the IOC limit above mid and the taker fee.
 */
export function orderUsdFor(availUsd, kind, leverage = 1, slippageBps = 50) {
  const slip = 1 + slippageBps / 10_000;
  const fee = HL_FEES_BPS[kind].taker / 10_000;
  const usd = kind === "perp" ? availUsd / (slip * (1 + leverage * fee)) : availUsd / (slip * (1 + fee));
  return Math.max(0, Math.floor(usd * 100) / 100);
}

export class OneClick {
  /**
   * @param {object} o
   * @param {object} o.pub        viem public client (Elysium)
   * @param {object} o.hub        initialised TradeHub
   * @param {object} o.sponsor    SponsorClient (or anything with buy({wallet, order, signature}))
   * @param {string} o.bridge     FastBridge address
   * @param {string} o.inventory  relayer's HyperCore account (source of the credit; for the activation-fee check)
   */
  constructor({ pub, hub, sponsor, bridge, inventory, pollMs = 400, bridgeTimeoutMs = 90_000, quoteMaxAgeMs = 10_000 }) {
    Object.assign(this, { pub, hub, sponsor, bridge, inventory, pollMs, bridgeTimeoutMs, quoteMaxAgeMs });
    this.tokens = new Map();
  }

  async init() {
    const [chainId, usdc, config] = await Promise.all([
      this.pub.getChainId(),
      this._read(this.bridge, bridgeAbi, "usdc"),
      this._read(this.bridge, bridgeAbi, "config"),
    ]);
    Object.assign(this, { chainId, usdc, feeBps: BigInt(config[0]), minFee: BigInt(config[1]) });
    return this;
  }

  /** Token metadata + the pool that converts it (null for USDC). */
  async token(address) {
    const k = address.toLowerCase();
    if (!this.tokens.has(k)) {
      const [decimals, symbol, pool] = await Promise.all([
        this._read(address, erc20Abi, "decimals"),
        this._read(address, erc20Abi, "symbol"),
        k === this.usdc.toLowerCase() ? null : this._read(this.bridge, bridgeAbi, "poolFor", [address]),
      ]);
      if (pool && /^0x0+$/.test(pool)) throw new Error(`${symbol} can't be used to pay yet`);
      this.tokens.set(k, { address, decimals, symbol, pool });
    }
    return this.tokens.get(k);
  }

  /**
   * Everything the button shows: est. amount received plus the breakdown behind it.
   * @param {bigint} amountIn  pay token base units
   */
  async quote({ user, payToken, amountIn, market, leverage = 1, slippageBps = 50, refreshPrices = true }) {
    const t = await this.token(payToken);
    const m = this.hub.market(market);
    const [gross, activation] = await Promise.all([
      t.pool ? this._read(t.pool, poolAbi, "previewSellBase", [amountIn]).then((r) => r[0]) : amountIn,
      this._activationFee(user),
      refreshPrices ? this.hub.refreshPrices() : null,
    ]);
    const pct = (gross * this.feeBps + 9_999n) / 10_000n;
    const bridgeFee = pct > this.minFee ? pct : this.minFee;
    const arrives = gross > bridgeFee ? gross - bridgeFee : 0n;
    const spendable = Number(arrives) / 1e6 - activation;
    const orderUsd = orderUsdFor(spendable, m.kind, leverage, slippageBps);
    const base = {
      at: Date.now(),
      key: quoteKey({ payToken, amountIn, market, leverage, slippageBps }),
      pay: { symbol: t.symbol, amount: amountIn, decimals: t.decimals },
      usdc: Number(gross) / 1e6,
      fees: { bridgeUsd: Number(bridgeFee) / 1e6, hyperliquidActivationUsd: activation },
      orderUsd,
      minUsdcOut: (gross * BigInt(10_000 - slippageBps)) / 10_000n,
    };
    try {
      const p = this.hub.preview(market, { side: "buy", usd: orderUsd, leverage });
      return { ...base, ok: true, est: { amount: Number(p.size), symbol: m.symbol, kind: m.kind, price: Number(p.price), leverage, notionalUsd: p.notionalUsd }, fees: { ...base.fees, tradeUsd: p.fees.hyperliquidUsd } };
    } catch (e) {
      return { ...base, ok: false, error: e.message }; // e.g. below the $10 minimum: show it on the button
    }
  }

  /**
   * The whole flow behind the Buy button. Signs nothing with the user's main wallet.
   * @param {object} o.device  session key account (viem local account, from setup)
   * @param {object} o.agent   HyperCore trade agent account
   * @param {object} [o.agentApproval]  pre-signed approval (hub.signAgentApproval) for a brand-new
   *        HyperCore account: submitted once the first deposit lands, before the order
   * @param {object} [o.builderApproval]  pre-signed builder-fee approval (hub.signBuilderApproval), same timing
   * @param {object} [o.quote]  the quote the button is showing: reused if it is for these exact
   *        inputs and under `quoteMaxAgeMs` old (saves a round of reads on click)
   */
  async buy({ user, device, agent, agentApproval, builderApproval, payToken, amountIn, market, leverage = 1, slippageBps = 50, quote, onStage = () => {} }) {
    onStage("quoting");
    const fresh = quote?.ok && quote.key === quoteKey({ payToken, amountIn, market, leverage, slippageBps }) && Date.now() - quote.at < this.quoteMaxAgeMs;
    const [q, before] = await Promise.all([
      fresh ? quote : this.quote({ user, payToken, amountIn, market, leverage, slippageBps }),
      this.hub.usdcBalances(user).catch(() => null), // baseline, to spot the credit on HyperCore
    ]);
    if (!q.ok) throw new Error(q.error);

    onStage("sending", { quote: q });
    const t = await this.token(payToken);
    let sent;
    for (let attempt = 1; ; attempt++) {
      const signed = await signBuy({ device, wallet: user, chainId: this.chainId, order: { token: t.address, amountIn, minUsdcOut: q.minUsdcOut } });
      try {
        sent = await this.sponsor.buy(signed);
        break;
      } catch (e) {
        // the oracle can be a few seconds behind: retry once, then report "market paused"
        if (attempt < 2 && /StaleBy/.test(e.message)) continue;
        throw new Error(/StaleBy/.test(e.message) ? "market paused, try again shortly" : e.message);
      }
    }

    onStage("bridging", { depositId: sent.depositId, hash: sent.hash });
    const intent = { side: "buy", usd: q.orderUsd, leverage, slippageBps };
    // An existing HyperCore account can take the agent approval + leverage now, while the deposit
    // bridges. A brand-new one refuses every action until its first deposit lands, so it waits.
    const exists = q.fees.hyperliquidActivationUsd === 0;
    const done = { approved: !agentApproval && !builderApproval, leverageSet: false };
    const prep = exists
      ? (async () => {
          await this._submitApprovals(user, { agentApproval, builderApproval });
          done.approved = true;
          done.leverageSet = await this.hub.setLeverage(agent, market, intent);
        })().catch(() => {}) // not fatal: the order path below redoes whatever didn't happen
      : Promise.resolve();
    const minCreditUsd = Math.max(0, q.usdc - q.fees.bridgeUsd - q.fees.hyperliquidActivationUsd) * CREDIT_SEEN;
    await Promise.all([this._awaitCredit(sent.depositId, { user, before, minCreditUsd }), this.hub.refreshPrices().catch(() => {})]);

    onStage("ordering");
    await prep;
    if (!done.approved) await this._submitApprovals(user, { agentApproval, builderApproval });
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await this.hub.placeOrder(agent, market, intent, { fundFrom: user, leverageSet: done.leverageSet });
        break;
      } catch (e) {
        // HyperCore balance can trail the relayer's credit by a moment
        if (attempt < 8 && /not enough USDC/.test(e.message)) {
          await sleep(this.pollMs);
          continue;
        }
        throw e;
      }
    }
    const fill = res.statuses[0];
    const out = { depositId: sent.depositId, hash: sent.hash, quote: q, order: res.summary, funded: res.funded, fill };
    onStage("done", out);
    return out;
  }

  // ---------------------------------------------------------------- fast path: pay from HyperCore

  /**
   * The button when paying with USDC already on the user's HyperCore account (profits, closed
   * positions). `usd` is margin for perps, spend for spot/outcomes, like `orderUsd` above.
   */
  async quoteFromHl({ user, usd, market, leverage = 1, slippageBps = 50, refreshPrices = true }) {
    const m = this.hub.market(market);
    const [bal] = await Promise.all([this.hub.usdcBalances(user), refreshPrices ? this.hub.refreshPrices() : null]);
    const availableUsd = bal.perp + bal.spot;
    const maxUsd = orderUsdFor(availableUsd, m.kind, leverage, slippageBps);
    const base = {
      at: Date.now(),
      key: hlQuoteKey({ usd, market, leverage, slippageBps }),
      payFrom: "hyperliquid",
      availableUsd,
      maxUsd,
      orderUsd: usd,
      fees: { bridgeUsd: 0, hyperliquidActivationUsd: 0 },
    };
    if (usd > maxUsd) return { ...base, ok: false, error: `only $${maxUsd.toFixed(2)} available on Hyperliquid` };
    try {
      const p = this.hub.preview(market, { side: "buy", usd, leverage });
      return { ...base, ok: true, est: { amount: Number(p.size), symbol: m.symbol, kind: m.kind, price: Number(p.price), leverage, notionalUsd: p.notionalUsd }, fees: { ...base.fees, tradeUsd: p.fees.hyperliquidUsd } };
    } catch (e) {
      return { ...base, ok: false, error: e.message };
    }
  }

  /**
   * Buy with USDC already on HyperCore: no bridge, no sponsor, no Elysium tx, no gas. Just the
   * order, signed by the trade agent (~1-2 s). Stages: quoting -> ordering -> done.
   *
   * The device session caps do NOT apply here: they are enforced by NeuriioAccount on Elysium,
   * and this path never touches Elysium. Same model as Hyperliquid's own app: the agent key can
   * trade the HyperCore balance but can never withdraw it.
   */
  async buyFromHl({ user, agent, agentApproval, builderApproval, usd, market, leverage = 1, slippageBps = 50, quote, onStage = () => {} }) {
    onStage("quoting");
    const fresh = quote?.ok && quote.key === hlQuoteKey({ usd, market, leverage, slippageBps }) && Date.now() - quote.at < this.quoteMaxAgeMs;
    const q = fresh ? quote : await this.quoteFromHl({ user, usd, market, leverage, slippageBps });
    if (!q.ok) throw new Error(q.error);

    onStage("ordering", { quote: q });
    await this._submitApprovals(user, { agentApproval, builderApproval }); // no-op once approved
    const res = await this.hub.placeOrder(agent, market, { side: "buy", usd, leverage, slippageBps }, { fundFrom: user });
    const out = { quote: q, order: res.summary, funded: res.funded, fill: res.statuses[0] };
    onStage("done", out);
    return out;
  }

  /** Agent + builder-fee approvals signed at setup; each is a no-op once HyperCore has it. */
  async _submitApprovals(user, { agentApproval, builderApproval }) {
    if (agentApproval) await this.hub.submitAgentApproval(user, agentApproval);
    if (builderApproval) await this.hub.submitBuilderApproval(user, builderApproval);
  }

  /**
   * Resolves once the deposit's USDC is usable on HyperCore. The relayer credits HyperCore first
   * and marks the deposit on Elysium a tx later, so watching the user's HyperCore balance (free
   * API, no Elysium RPC) saves that extra block. Elysium is still checked every few polls for a
   * refund, and as a fallback when no baseline balance is known.
   */
  async _awaitCredit(id, { user, before, minCreditUsd = 0 } = {}) {
    const t0 = Date.now();
    for (let i = 0; ; i++) {
      // the deposit is already on-chain: a failed read (public RPC rate limit) is not a failed
      // buy, so keep polling until the timeout
      if (user && before) {
        const now = await this.hub.usdcBalances(user).catch(() => null);
        if (now && now.perp + now.spot - (before.perp + before.spot) >= minCreditUsd) return;
      }
      if (!before || i % ELYSIUM_EVERY === 0) {
        const d = await this._read(this.bridge, bridgeAbi, "deposits", [id]).catch(() => null);
        if (d?.[2] === FULFILLED) return;
        if (d?.[2] === REFUNDED) throw new Error(`deposit ${id} was refunded`);
      }
      if (Date.now() - t0 > this.bridgeTimeoutMs) {
        throw Object.assign(new Error(`deposit ${id} is taking longer than usual; a refund unlocks after the bridge's refund delay`), { depositId: id });
      }
      // Elysium-only polling (no baseline) stays at <= 1 read/s: the public RPC rate-limits
      await sleep(before ? this.pollMs : Math.max(this.pollMs, 1000));
    }
  }

  /** HyperCore's one-time fee when USDC first reaches a brand-new account ($1 today). */
  async _activationFee(user) {
    if (!this.inventory) return 0;
    const r = await this.hub.info.preTransferCheck({ user, source: this.inventory });
    return r.userExists ? 0 : Number(r.fee);
  }

  _read(address, abi, functionName, args = []) {
    return this.pub.readContract({ address, abi, functionName, args });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
