// Gas sponsor: submits users' signed one-click actions and pays the HYPE gas (subscription model).
// Elysium has no ERC-4337 EntryPoint/bundler yet, so this is a plain relayer. It can't hurt users:
// it only forwards what their own keys signed, and NeuriioAccount re-checks every signature and cap.
//
// What it protects is OUR gas: every request is simulated before sending (reverting txs are
// refused), only wallets delegated to our NeuriioAccount are served, and each wallet is rate limited.
// Transactions are signed locally and sent raw (viem's writeContract adds extra RPC calls).
import { decodeErrorResult, decodeEventLog, parseAbi } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { accountAbi, encodeAddSession, encodeBuy, isDelegatedTo } from "./account.mjs";

export class Sponsor {
  /**
   * @param {object} o
   * @param {object} o.pub       viem public client
   * @param {object} o.signer    viem local account that pays gas
   * @param {string} o.delegate  NeuriioAccount implementation
   * @param {object} [o.limits]  { buysPerMinute, setupsPerHour, txPerDay, minBuyUsdc (base units) }
   */
  constructor({ pub, signer, delegate, limits = {}, log = (e) => console.log(JSON.stringify(e)), now = Date.now }) {
    Object.assign(this, { pub, signer, delegate: delegate.toLowerCase(), log, now });
    // minBuyUsdc: HyperCore's $10 minimum order; smaller buys can't trade and would only burn our gas
    this.limits = { buysPerMinute: 6, setupsPerHour: 3, txPerDay: 5_000, minBuyUsdc: 10_000_000n, ...limits };
    this.hits = new Map(); // `${kind}:${wallet}` -> timestamps
    this.day = { n: 0, day: -1 };
    this.queue = Promise.resolve();
    this.nonce = null;
  }

  async init() {
    this.chainId = await this.pub.getChainId();
    this.bridge = await this.pub.readContract({ address: this.delegate, abi: accountAbi, functionName: "bridge" });
    this.usdc = await this.pub.readContract({ address: this.bridge, abi: bridgeViews, functionName: "usdc" });
    return this;
  }

  // ---------------------------------------------------------------- endpoints

  /** One-time: 7702 delegation (if not yet) + AddSession, in one type-4 transaction. */
  async setup({ wallet, authorization, session, signature }) {
    wallet = checkAddress(wallet);
    this._limit("setup", wallet, this.limits.setupsPerHour, 3_600_000);
    const authorizationList = [];
    if (authorization) {
      if (authorization.address.toLowerCase() !== this.delegate) throw new UserError("authorization is not for NeuriioAccount");
      if (Number(authorization.chainId) !== this.chainId) throw new UserError("authorization must be for this chain only");
      const signer = await recoverAuthorizationAddress({ authorization });
      if (signer.toLowerCase() !== wallet.toLowerCase()) throw new UserError("authorization not signed by wallet");
      authorizationList.push(authorization);
    } else if (!(await isDelegatedTo(this.pub, wallet, this.delegate))) {
      throw new UserError("wallet is not delegated; include an authorization");
    }
    const data = encodeAddSession({ session, signature });
    const gas = await this._estimate({ to: wallet, data, authorizationList });
    const rcpt = await this._send({ to: wallet, data, gas, authorizationList });
    this.log({ ev: "setup", wallet, key: session.key, delegated: authorizationList.length > 0, hash: rcpt.transactionHash });
    return { hash: rcpt.transactionHash };
  }

  /** A buy signed by the wallet's session key. Returns the FastBridge deposit id. */
  async buy({ wallet, order, signature }) {
    wallet = checkAddress(wallet);
    if (!(await isDelegatedTo(this.pub, wallet, this.delegate))) throw new UserError("wallet is not set up for one-click");
    this._limit("buy", wallet, this.limits.buysPerMinute, 60_000);
    if ((await this._usdcValue(order)) < this.limits.minBuyUsdc) throw new UserError("buy is below the $10 minimum");
    const data = encodeBuy({ order, signature });
    const gas = await this._estimate({ to: wallet, data });
    const rcpt = await this._send({ to: wallet, data, gas });
    const depositId = boughtId(rcpt, wallet);
    this.log({ ev: "buy", wallet, depositId: String(depositId), hash: rcpt.transactionHash });
    return { hash: rcpt.transactionHash, depositId };
  }

  // ---------------------------------------------------------------- internals

  async _usdcValue({ token, amountIn }) {
    if (token.toLowerCase() === this.usdc.toLowerCase()) return amountIn;
    const pool = await this.pub.readContract({ address: this.bridge, abi: bridgeViews, functionName: "poolFor", args: [token] });
    if (/^0x0+$/.test(pool)) throw new UserError("token not supported");
    try {
      const [out] = await this.pub.readContract({ address: pool, abi: bridgeViews, functionName: "previewSellBase", args: [amountIn] });
      return out;
    } catch (e) {
      throw new UserError(`would revert: ${revertReason(e)}`);
    }
  }

  _limit(kind, wallet, max, windowMs) {
    const t = this.now();
    const key = `${kind}:${wallet.toLowerCase()}`;
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= max) throw new UserError(`too many ${kind} requests, slow down`);
    const today = Math.floor(t / 86_400_000);
    if (this.day.day !== today) this.day = { n: 0, day: today };
    if (this.day.n >= this.limits.txPerDay) throw new UserError("sponsor daily budget reached");
    recent.push(t);
    this.hits.set(key, recent);
  }

  /**
   * Simulates; a revert becomes a readable error and nothing is sent (no gas spent).
   * Elysium's eth_call/eth_estimateGas ignore `authorizationList` (verified 2026-09-25: the call
   * runs as if the wallet had no code), so a not-yet-delegated wallet is simulated with a state
   * override that installs the 7702 designator, and the authorization's own intrinsic cost
   * (25,000 gas each, EIP-7702 PER_EMPTY_ACCOUNT_COST) is added on top.
   */
  async _estimate({ to, data, authorizationList }) {
    const auths = authorizationList?.length ?? 0;
    for (let attempt = 1; ; attempt++) {
      try {
        const gas = await this.pub.estimateGas({
          account: this.signer.address,
          to,
          data,
          ...(auths ? { stateOverride: [{ address: to, code: `0xef0100${this.delegate.slice(2)}` }] } : {}),
        });
        return (gas * 13n) / 10n + 25_000n * BigInt(auths);
      } catch (e) {
        // a real revert is final; a flaky RPC answer (rate limit, timeout) gets two more tries
        if (!isRevert(e) && attempt < 3) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
        throw new UserError(isRevert(e) ? `would revert: ${revertReason(e)}` : `network busy, try again (${revertReason(e)})`);
      }
    }
  }

  /** Serialized so nonces never clash; resyncs the nonce after any failure. */
  _send(tx) {
    const run = async () => {
      if (this.nonce === null) {
        this.nonce = await this.pub.getTransactionCount({ address: this.signer.address, blockTag: "pending" });
      }
      const gasPrice = await this.pub.getGasPrice();
      const signed = await this.signer.signTransaction({
        chainId: this.chainId,
        type: tx.authorizationList?.length ? "eip7702" : "eip1559",
        to: tx.to,
        data: tx.data,
        gas: tx.gas,
        nonce: this.nonce,
        maxFeePerGas: gasPrice * 2n,
        maxPriorityFeePerGas: 0n,
        ...(tx.authorizationList?.length ? { authorizationList: tx.authorizationList } : {}),
      });
      let hash;
      try {
        hash = await this.pub.sendRawTransaction({ serializedTransaction: signed });
        this.nonce++;
        this.day.n++;
      } catch (e) {
        this.nonce = null;
        throw e;
      }
      const rcpt = await this.pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
      if (rcpt.status !== "success") throw new Error(`reverted on-chain: ${hash}`);
      return rcpt;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

export class UserError extends Error {}

function checkAddress(a) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a ?? "")) throw new UserError("bad wallet address");
  return a;
}

function boughtId(rcpt, wallet) {
  for (const l of rcpt.logs) {
    if (l.address.toLowerCase() !== wallet.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: accountAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Bought") return ev.args.depositId;
    } catch {}
  }
  throw new Error(`no Bought event in ${rcpt.transactionHash}`);
}

function revertData(e) {
  for (let x = e; x; x = x.cause) {
    const d = typeof x.data === "string" ? x.data : x.data?.data;
    if (typeof d === "string" && d.startsWith("0x")) return d;
  }
  return null;
}

const isRevert = (e) => revertData(e) !== null || /revert/i.test(`${e.details ?? ""} ${e.shortMessage ?? ""} ${e.message}`);

/** Best-effort decode of a revert into the contract's error name (StaleByTime -> "market paused" in the UI). */
export function revertReason(e) {
  const data = revertData(e);
  if (data && data !== "0x") {
    try {
      const r = decodeErrorResult({ abi: knownErrors, data });
      return `${r.errorName}(${(r.args ?? []).join(", ")})`;
    } catch {
      return `unknown error ${data.slice(0, 10)}`;
    }
  }
  return [e.shortMessage ?? e.message, e.details].filter(Boolean).join(": ");
}

const bridgeViews = parseAbi([
  "function usdc() view returns (address)",
  "function poolFor(address) view returns (address)",
  "function previewSellBase(uint256 baseIn) view returns (uint256 quoteOut, uint256 priceWad)",
]);

const knownErrors = [
  ...accountAbi.filter((x) => x.type === "error"),
  ...parseAbi([
    // FastBridge
    "error UnsupportedToken(address token)",
    "error AmountTooSmall(uint256 gross, uint256 fee)",
    "error DepositTooLarge(uint256 amount, uint256 max)",
    "error InsufficientCredit(uint256 amount, uint256 credit)",
    "error TransferAmountMismatch(uint256 received, uint256 expected)",
    "error EnforcedPause()",
    // PropAMM / oracle
    "error Slippage(uint256 out, uint256 minOut)",
    "error TradeTooLarge(uint256 tradeValue, uint256 maxValue)",
    "error ExceedsCoreDepth(uint256 baseWad, uint256 maxBaseWad)",
    "error InsufficientReserve(uint256 out, uint256 reserve)",
    "error StaleByTime(uint32 spotIndex, uint256 ageMs, uint256 maxAgeMs)",
    "error StaleByBlocks(uint32 spotIndex, uint256 lag, uint256 maxLag)",
    "error SpreadTooWide(uint32 spotIndex, uint256 spreadBps, uint256 maxSpreadBps)",
    "error NoData(uint32 spotIndex)",
    // ERC-20
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  ]),
];
