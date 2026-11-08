// Trading tokens launched by other teams (Ascend's top tokens; also Montra's) through NeuriioSwap (src/trade/NeuriioSwap.sol, user
// 2026-11-07), in the token's own Uniswap v4 pool, with our 0.5% on top (0.5% of what you pay on a buy, of what you get on a sell).
// A token is tradable here only once NeuriioSwap's owner approved its pool. Its pair decides what you pay with:
//  - native HYPE or WHYPE pairs (all of Ascend's top tokens): plain HYPE in and out (NeuriioSwap wraps / unwraps WHYPE)
//  - any other ERC-20 pair (e.g. USDC): that token in and out (approved to NeuriioSwap once)
// Quotes come from Uniswap's V4Quoter on that pool (it runs the pool's hook, so Ascend's / Montra's fee is inside), minus our 0.5%.
import { erc20Abi, maxUint256, parseAbi, zeroAddress, type Address, type EIP1193Provider } from "viem";
import { ASCEND, NEURIIO_SWAP } from "./config";
import { pub } from "./launch";
import { recordTrade } from "./recordTrade";
import { confirmed, nonceAfter, walletClientFor } from "./tx";
import type { PoolKey, Side } from "./trade";

export const OUR_FEE_BPS = 50n; // 0.5%: NeuriioSwap.FEE_BPS
export const HYPE_SLIPPAGE_BPS = 100n; // 1%

const swapAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function approved(address token) view returns (bool)",
  "function poolOf(address token) view returns (PoolKey)",
  "function quoteOf(address token) view returns (address)",
  "function whype() view returns (address)",
  "function paused() view returns (bool)",
  "function buy(address token, uint256 amountIn, uint256 minOut, address to, uint256 deadline) payable returns (uint256)",
  "function sell(address token, uint256 amountIn, uint256 minOut, address to, uint256 deadline) returns (uint256)",
]);
const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

/** A token's approved pool and what it trades against. `inHype`: paid and received in plain HYPE (native or WHYPE pair). */
export type SwapPool = { key: PoolKey; quote: Address; inHype: boolean; symbol: string; decimals: number };

/** The approved pool for `token`, or null when NeuriioSwap isn't set, is paused or doesn't trade it (kept a minute per token). */
const pools = new Map<string, { at: number; p: Promise<SwapPool | null> }>();
export function swapPoolOf(token: Address): Promise<SwapPool | null> {
  if (!NEURIIO_SWAP) return Promise.resolve(null);
  const k = token.toLowerCase();
  const hit = pools.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const swap = NEURIIO_SWAP;
  const p = (async () => {
    const [ok, paused] = await Promise.all([
      pub.readContract({ address: swap, abi: swapAbi, functionName: "approved", args: [token] }),
      pub.readContract({ address: swap, abi: swapAbi, functionName: "paused" }),
    ]);
    if (!ok || paused) return null;
    const [key, quote, whype] = await Promise.all([
      pub.readContract({ address: swap, abi: swapAbi, functionName: "poolOf", args: [token] }),
      pub.readContract({ address: swap, abi: swapAbi, functionName: "quoteOf", args: [token] }),
      pub.readContract({ address: swap, abi: swapAbi, functionName: "whype" }),
    ]);
    const inHype = quote === zeroAddress || quote.toLowerCase() === whype.toLowerCase();
    if (inHype) return { key: key as PoolKey, quote, inHype, symbol: "HYPE", decimals: 18 };
    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address: quote, abi: erc20Abi, functionName: "symbol" }),
      pub.readContract({ address: quote, abi: erc20Abi, functionName: "decimals" }),
    ]);
    return { key: key as PoolKey, quote, inHype, symbol, decimals };
  })().catch(() => null);
  pools.set(k, { at: Date.now(), p });
  return p;
}

const ourFee = (v: bigint) => (v * OUR_FEE_BPS) / 10_000n;

/** What you'd get: tokens for `amountIn` of the pair (buy), or the pair after our fee for `amountIn` tokens (sell). Exact preview. */
export async function hypeQuote(pool: SwapPool, side: Side, amountIn: bigint): Promise<bigint> {
  if (amountIn === 0n) return 0n;
  const pairIsCurrency0 = pool.key.currency0.toLowerCase() === (pool.quote === zeroAddress ? zeroAddress : pool.quote.toLowerCase());
  const exactAmount = side === "buy" ? amountIn - ourFee(amountIn) : amountIn;
  const { result } = await pub.simulateContract({
    address: ASCEND.v4Quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    // buying spends the pair; selling spends the token
    args: [{ poolKey: pool.key, zeroForOne: side === "buy" ? pairIsCurrency0 : !pairIsCurrency0, exactAmount, hookData: "0x" }],
  });
  const out = result[0];
  return side === "buy" ? out : out - ourFee(out);
}

export const hypeMinOut = (out: bigint) => (out * (10_000n - HYPE_SLIPPAGE_BPS)) / 10_000n;

/** What you pay with (HYPE, also the gas, or the pair token) and the token, for the trade box. */
export async function hypeBalances(wallet: Address, token: Address, pool: SwapPool) {
  // paying in HYPE: the gas balance is the same number, so it's read once
  const [gas, tokens, pairBal] = await Promise.all([
    pub.getBalance({ address: wallet }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
    pool.inHype ? Promise.resolve(null) : pub.readContract({ address: pool.quote, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
  ]);
  return { pay: pairBal ?? gas, tokens, gas };
}

/** Approves `spent` to NeuriioSwap (once, unlimited) if it isn't yet; the next nonce to use if it sent one. */
async function approveToSwap(provider: EIP1193Provider, account: Address, spent: Address, atLeast: bigint): Promise<number | undefined> {
  const allowance = await pub.readContract({ address: spent, abi: erc20Abi, functionName: "allowance", args: [account, NEURIIO_SWAP!] });
  if (allowance >= atLeast) return undefined;
  const h = await walletClientFor(provider, account).writeContract({ address: spent, abi: erc20Abi, functionName: "approve", args: [NEURIIO_SWAP!, maxUint256] });
  await confirmed(h);
  return (await nonceAfter(h)) ?? undefined;
}

/** One trade through NeuriioSwap. Paying with HYPE needs no approval; a token (the one sold, or a non-HYPE pair) is approved once. */
export async function hypeTrade(
  provider: EIP1193Provider,
  account: Address,
  pool: SwapPool,
  a: { token: Address; side: Side; amountIn: bigint; minOut: bigint },
) {
  if (!NEURIIO_SWAP) throw new Error("Trading isn't open for this token");
  const wallet = walletClientFor(provider, account);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  if (a.side === "buy") {
    const nonce = pool.inHype ? undefined : await approveToSwap(provider, account, pool.quote, a.amountIn);
    const hash = await wallet.writeContract({
      address: NEURIIO_SWAP,
      abi: swapAbi,
      functionName: "buy",
      args: [a.token, a.amountIn, a.minOut, account, deadline],
      value: pool.inHype ? a.amountIn : 0n,
      nonce,
    });
    await confirmed(hash);
    recordTrade(hash); // on every chart and in Positions in about a second
    return hash;
  }
  const nonce = await approveToSwap(provider, account, a.token, a.amountIn);
  const hash = await wallet.writeContract({ address: NEURIIO_SWAP, abi: swapAbi, functionName: "sell", args: [a.token, a.amountIn, a.minOut, account, deadline], nonce });
  await confirmed(hash);
  recordTrade(hash);
  return hash;
}
