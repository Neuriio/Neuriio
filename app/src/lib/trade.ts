// Buying/selling launched tokens from Explore with the Neuriio (Privy) wallet, in USDC, in the token's Ascend pool (Uniswap v4,
// user 2026-11-04; Ascend's docs, Integration guide). Quotes are exact on-chain previews from Ascend's V4Quoter (they run the
// hook, so the 1.5% fee is inside); the spot price is the pool's, from StateView. A trade is one V4_SWAP through Ascend's
// Universal Router, which pulls the input through Permit2 (never approve the router directly).
// One click = one transaction (user, 2026-10-18): the one-time approvals (the token -> Permit2, unlimited; Permit2 -> the
// router, unlimited for 30 days) are sent silently in the background as soon as the trade box opens (`prepareTrading`). If
// one is still missing when you click, it goes first, then the trade, with the next nonce.
import { recordTrade } from "./recordTrade";
import { encodeAbiParameters, encodePacked, erc20Abi, keccak256, maxUint256, parseAbi, type Address, type EIP1193Provider } from "viem";
import { confirmed, nonceAfter, walletClientFor } from "./tx";
import { ASCEND, QUOTE } from "./config";
import { pub } from "./launch";

export const SLIPPAGE_BPS = 100n; // 1%
export const FEE_BPS = 150; // 1.5% on every trade: Ascend's 1% + our 0.5% builder fee (the quotes already include it)

const DYNAMIC_FEE_FLAG = 0x800000;
const TICK_SPACING = 200;
const MAX_UINT160 = (1n << 160n) - 1n;
const PERMIT_DAYS = 30;

export type Side = "buy" | "sell";
export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

const poolKeyType = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

/** Ascend's pool for a token's USDC pair, and its id (keccak256 of the encoded key). */
export function poolKeyOf(token: Address): PoolKey {
  const tokenFirst = token.toLowerCase() < QUOTE.address.toLowerCase();
  return {
    currency0: tokenFirst ? token : QUOTE.address,
    currency1: tokenFirst ? QUOTE.address : token,
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: TICK_SPACING,
    hooks: ASCEND.launchpad,
  };
}
export const poolIdOf = (key: PoolKey) => keccak256(encodeAbiParameters([{ type: "tuple", components: poolKeyType }], [key]));

const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const stateViewAbi = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"]);
const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const routerAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

/** Kept for the order card: Ascend has no bonding curve, so nothing graduates. */
export const padOf = (launchpad: string | null | undefined) => (launchpad ?? ASCEND.launchpad) as Address;

// refund: always 0 here (kept for the order card); spot: USDC per token right before the trade, read on-chain with the quote
export type Quote = { out: bigint; refund: bigint; spot: number | null };

/** Spot price (USDC per whole token) of the token's pool, from its sqrtPriceX96. */
export async function spotNow(token: Address): Promise<number | null> {
  const key = poolKeyOf(token);
  const [sqrtPriceX96] = await pub.readContract({ address: ASCEND.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolIdOf(key)] });
  if (sqrtPriceX96 === 0n) return null;
  const raw = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // currency1 base units per currency0 base unit
  const decimals = 10 ** (18 - QUOTE.decimals);
  return key.currency0.toLowerCase() === token.toLowerCase() ? raw * decimals : decimals / raw;
}

/** Nothing graduates on Ascend (the order card still asks). */
export async function buyGraduates(..._args: unknown[]): Promise<boolean> {
  return false;
}

/** Exact amount out for `amountIn` (USDC base units to buy, token wei to sell), fee included. */
export async function quote(token: Address, _graduated: boolean, side: Side, amountIn: bigint, _launchpad?: string | null): Promise<Quote> {
  if (amountIn === 0n) return { out: 0n, refund: 0n, spot: null };
  const spot = spotNow(token).catch(() => null);
  const key = poolKeyOf(token);
  const payToken = side === "buy" ? QUOTE.address : token;
  const { result } = await pub.simulateContract({
    address: ASCEND.v4Quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: key, zeroForOne: key.currency0.toLowerCase() === payToken.toLowerCase(), exactAmount: amountIn, hookData: "0x" }],
  });
  return { out: result[0], refund: 0n, spot: await spot };
}

/** What the trade box needs: USDC to buy with, the token to sell, and HYPE for gas. */
export async function balances(wallet: Address, token: Address) {
  const [usdc, tokens, gas] = await Promise.all([
    pub.readContract({ address: QUOTE.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
    pub.getBalance({ address: wallet }),
  ]);
  return { usdc, tokens, gas };
}

export const minOut = (out: bigint) => (out * (10_000n - SLIPPAGE_BPS)) / 10_000n;

/** Approvals in flight, per wallet + token: the trade waits for one instead of sending a second. */
const approving = new Map<string, Promise<number | null>>();

/** Makes sure Ascend's router can take `spent` (USDC or a token) from `account` through Permit2: the token approves Permit2
 *  (unlimited, once), Permit2 allows the router (unlimited, renewed when under a day is left). Sends what's missing.
 *  Resolves to the nonce for the next transaction when it sent one (see nonceAfter), else null. */
export function approveForTrading(provider: EIP1193Provider, account: Address, spent: Address, atLeast: bigint): Promise<number | null> {
  const key = `${account}:${spent}`.toLowerCase();
  const inFlight = approving.get(key);
  if (inFlight) return inFlight;
  const run = (async () => {
    const wallet = walletClientFor(provider, account);
    let next: number | null = null;
    const toPermit2 = await pub.readContract({ address: spent, abi: erc20Abi, functionName: "allowance", args: [account, ASCEND.permit2] });
    if (toPermit2 < atLeast) {
      const hash = await wallet.writeContract({ address: spent, abi: erc20Abi, functionName: "approve", args: [ASCEND.permit2, maxUint256] });
      await confirmed(hash);
      next = await nonceAfter(hash);
    }
    const [amount, expiration] = await pub.readContract({
      address: ASCEND.permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [account, spent, ASCEND.universalRouter],
    });
    const now = Math.floor(Date.now() / 1000);
    if (amount < atLeast || expiration < now + 86_400) {
      const hash = await wallet.writeContract({
        address: ASCEND.permit2,
        abi: permit2Abi,
        functionName: "approve",
        args: [spent, ASCEND.universalRouter, MAX_UINT160, now + PERMIT_DAYS * 86_400],
        nonce: next ?? undefined,
      });
      await confirmed(hash);
      next = await nonceAfter(hash);
    }
    return next;
  })().finally(() => approving.delete(key));
  approving.set(key, run);
  return run;
}

/** Background, when the trade box opens: the approvals for USDC (if the wallet holds some) and for the token (if it holds
 *  some), so the next buy or sell is one transaction. Silent: any failure just leaves it to the trade. */
export function prepareTrading(provider: () => Promise<EIP1193Provider>, account: Address, token: Address, held: { usdc: bigint; tokens: bigint; gas: bigint }) {
  if (held.gas === 0n) return;
  for (const [spent, amount] of [[QUOTE.address, held.usdc], [token, held.tokens]] as const) {
    if (amount > 0n) provider().then((p) => approveForTrading(p, account, spent, amount)).catch(() => {});
  }
}

/** One exact-input V4_SWAP (SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL) for Universal Router 2.2.0. */
export function swapCall(token: Address, side: Side, amountIn: bigint, minAmountOut: bigint) {
  const key = poolKeyOf(token);
  const payToken = side === "buy" ? QUOTE.address : token;
  const getToken = side === "buy" ? token : QUOTE.address;
  const swap = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "poolKey", type: "tuple", components: poolKeyType },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "minHopPriceX36", type: "uint256" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [{ poolKey: key, zeroForOne: key.currency0.toLowerCase() === payToken.toLowerCase(), amountIn, amountOutMinimum: minAmountOut, minHopPriceX36: 0n, hookData: "0x" }],
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [payToken, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [getToken, minAmountOut]);
  const actions = encodePacked(["uint8", "uint8", "uint8"], [0x06, 0x0c, 0x0f]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swap, settle, take]]);
  return { commands: "0x10" as const, inputs: [input] };
}

/** Sends the trade and waits for it: one transaction (the approvals go first only if `prepareTrading` hasn't sent them yet).
 *  A send the RPC rejects is tried again, at most twice, and only if nothing went out (the wallet's transaction count didn't
 *  move), so a trade is never sent twice. */
export async function trade(
  provider: EIP1193Provider,
  account: Address,
  args: { token: Address; side: Side; amountIn: bigint; minOut: bigint },
) {
  const wallet = walletClientFor(provider, account);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const { token, side, amountIn } = args;
  const next = await approveForTrading(provider, account, side === "buy" ? QUOTE.address : token, amountIn);
  const { commands, inputs } = swapCall(token, side, amountIn, args.minOut);
  for (let attempt = 0; ; attempt++) {
    const before = await pub.getTransactionCount({ address: account, blockTag: "pending" });
    // right after an approval, the RPC may still count without it: use the next nonce ourselves
    const nonce = next !== null ? Math.max(before, next) : undefined;
    try {
      const hash = await wallet.writeContract({ address: ASCEND.universalRouter, abi: routerAbi, functionName: "execute", args: [commands, inputs, deadline], nonce });
      await confirmed(hash);
      recordTrade(hash); // on every chart and in Positions in about a second
      return hash;
    } catch (e) {
      const m = (e as Error).message;
      const retryable = /RPC Request failed|HTTP request failed|nonce|replacement|timed? ?out|429|rate limit|fetch/i.test(m) && !/rejected|denied|reverted|Slippage|TooLittle|Expired|Deadline/i.test(m);
      if (!retryable || attempt === 2) throw e;
      const sentAt = nonce ?? before; // the nonce this trade used
      const after = await pub.getTransactionCount({ address: account, blockTag: "pending" }).catch(() => sentAt + 1);
      if (after > sentAt) throw e; // something went out with that nonce: never send the trade twice
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

/** Readable errors for the common failures. */
export function friendlyTradeError(message: string) {
  if (/Slippage|TooLittleReceived|V4TooLittleReceived|MinimumAmount/i.test(message)) return "Price moved more than 1%. Try again.";
  if (/insufficient funds/i.test(message)) return "Not enough HYPE for gas.";
  if (/RPC Request failed|HTTP request failed|429|rate limit|fetch/i.test(message)) return "The network didn't answer. Try again.";
  if (/exceeds balance|InsufficientBalance|TRANSFER_FROM_FAILED/i.test(message)) return "Not enough balance.";
  if (/rejected|denied/i.test(message)) return "Cancelled.";
  if (/Expired|Deadline/i.test(message)) return "Took too long. Try again.";
  return message.split("\n")[0].slice(0, 140);
}
