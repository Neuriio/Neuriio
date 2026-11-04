// The one place the fee router reads Ascend's contracts. PLACEHOLDER (2026-11-01): Ascend hasn't shared its contracts, so
// this assumes standard Uniswap v4: one PoolManager emitting this Swap event, whose `id` is the pool's id. When their
// contracts arrive, confirm or change this file, then set ASCEND_SWAP_CONFIRMED=1 (the router won't send money without it).
import { parseAbi, parseEventLogs } from "viem";

export const swapAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

/** The swaps in a transaction's logs, in log order: [{ pool, logIndex }]. */
export function swapsInLogs(logs, poolManager) {
  const fromManager = logs.filter((l) => l.address.toLowerCase() === poolManager.toLowerCase());
  return parseEventLogs({ abi: swapAbi, logs: fromManager, eventName: "Swap" })
    .map((l) => ({ pool: l.args.id.toLowerCase(), logIndex: l.logIndex }))
    .sort((a, b) => a.logIndex - b.logIndex);
}
