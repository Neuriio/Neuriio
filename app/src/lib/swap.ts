// The /swap page (user, 2026-11-08): HYPE, USDC and KNTQ through Elysium's Uniswap v4 pools (routes in swapRoute.ts), sent from
// the Neuriio (Privy) wallet through Ascend's Universal Router. No fee of ours for now (user, 2026-11-08). Quotes are exact
// on-chain previews from the V4Quoter, hop by hop (tested on a mainnet fork: every direction got exactly its quote).
import { formatUnits, parseAbi, type Address, type EIP1193Provider } from "viem";
import { ASCEND, ELYSIUM_TOKENS, QUOTE } from "./config";
import { pub } from "./launch";
import { approveForTrading } from "./trade";
import { confirmed, walletClientFor } from "./tx";
import { NATIVE, routeOf, swapCall, type Hop } from "./swapRoute";

export const SWAP_SLIPPAGE_BPS = 100n; // 1%
const KNTQ = ELYSIUM_TOKENS.find((t) => t.symbol === "KNTQ")!.address;
const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const routerAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

/** "native" (the swap card's name for HYPE) -> Uniswap's. */
const cur = (a: Address | "native"): Address => (a === "native" ? NATIVE : a);

export const swapRoute = (pay: Address | "native", receive: Address | "native") => routeOf(cur(pay), cur(receive), { usdc: QUOTE.address, kntq: KNTQ });

async function quoteHops(hops: Hop[], amountIn: bigint) {
  let x = amountIn;
  for (const h of hops) {
    const { result } = await pub.simulateContract({
      address: ASCEND.v4Quoter,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: h.key, zeroForOne: h.zeroForOne, exactAmount: x, hookData: "0x" }],
    });
    x = result[0];
  }
  return x;
}

/** What `amountIn` gets, and the price impact: how much worse its rate is than a 1%-sized swap's (the pools are thin). */
export async function quoteSwap(hops: Hop[], amountIn: bigint, decIn: number, decOut: number) {
  const small = amountIn / 100n;
  const [out, ref] = await Promise.all([quoteHops(hops, amountIn), small > 0n ? quoteHops(hops, small).catch(() => null) : null]);
  const rate = (o: bigint, i: bigint) => Number(formatUnits(o, decOut)) / Number(formatUnits(i, decIn));
  const impact = ref && ref > 0n ? Math.max(0, 1 - rate(out, amountIn) / rate(ref, small)) : null;
  return { out, impact };
}

export const swapMinOut = (out: bigint) => (out * (10_000n - SWAP_SLIPPAGE_BPS)) / 10_000n;

/** Sends the swap and waits for it. An ERC-20 input is pulled through Permit2 (approved first if needed, like a trade). */
export async function sendSwap(provider: EIP1193Provider, account: Address, hops: Hop[], amountIn: bigint, minOut: bigint) {
  const pay = hops[0].from;
  const next = pay === NATIVE ? null : await approveForTrading(provider, account, pay, amountIn);
  const { commands, inputs, value } = swapCall(hops, amountIn, minOut);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const before = await pub.getTransactionCount({ address: account, blockTag: "pending" });
  const nonce = next !== null ? Math.max(before, next) : undefined; // right after an approval the RPC can lag
  const hash = await walletClientFor(provider, account).writeContract({
    address: ASCEND.universalRouter,
    abi: routerAbi,
    functionName: "execute",
    args: [commands, inputs, deadline],
    value,
    nonce,
  });
  await confirmed(hash);
  return hash;
}
