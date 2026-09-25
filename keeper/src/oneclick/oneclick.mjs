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
  constructor({ pub, hub, sponsor, bridge, inventory, pollMs = 1000, bridgeTimeoutMs = 90_000 }) {
    Object.assign(this, { pub, hub, sponsor, bridge, inventory, pollMs, bridgeTimeoutMs });
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
   */
  async buy({ user, device, agent, agentApproval, payToken, amountIn, market, leverage = 1, slippageBps = 50, onStage = () => {} }) {
    onStage("quoting");
    const q = await this.quote({ user, payToken, amountIn, market, leverage, slippageBps });
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
    await this._awaitCredit(sent.depositId);

    onStage("ordering");
    if (agentApproval) await this.hub.submitAgentApproval(user, agentApproval);
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await this.hub.placeOrder(agent, market, { side: "buy", usd: q.orderUsd, leverage, slippageBps }, { fundFrom: user });
        break;
      } catch (e) {
        // HyperCore balance can trail the relayer's credit by a moment
        if (attempt < 4 && /not enough USDC/.test(e.message)) {
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

  async _awaitCredit(id) {
    const t0 = Date.now();
    for (;;) {
      const d = await this._read(this.bridge, bridgeAbi, "deposits", [id]);
      if (d[2] === FULFILLED) return;
      if (d[2] === REFUNDED) throw new Error(`deposit ${id} was refunded`);
      if (Date.now() - t0 > this.bridgeTimeoutMs) {
        throw Object.assign(new Error(`deposit ${id} is taking longer than usual; a refund unlocks after the bridge's refund delay`), { depositId: id });
      }
      await sleep(this.pollMs);
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
