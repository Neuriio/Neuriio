// Turns one block's Launchpad / SwapRouter / pair logs into live trade messages for the charts.
// Pure (no I/O). Mirrors supabase/functions/_shared/indexer.ts, which stores the same trades a minute later.
//   curve trade: Launchpad.Trade; price after = virtualHype / virtualToken
//   pool trade:  the pair's Swap; price after = the pair's Sync just before it (WHYPE reserve / token reserve);
//                trader from our router's Swapped in the same tx, else null (aggregators; the indexer uses tx.from)
import { formatEther, formatUnits, parseAbi } from "viem";

export const watchEvents = parseAbi([
  "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 hypeAmount, uint256 tokenAmount, uint256 fee, uint256 virtualHype, uint256 virtualToken)",
  "event Graduated(address indexed token, address indexed pair, uint256 hype, uint256 tokens, uint256 liquidityBurned)",
  "event Swapped(address indexed token, address indexed trader, address to, bool isBuy, uint256 hypeAmount, uint256 tokenAmount)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
]);

const lc = (a) => a.toLowerCase();
/** num / den as a 36-decimal string, then a JS number (enough for charts; the DB keeps exact values). */
const ratio = (num, den) => (den === 0n ? null : Number(formatUnits((num * 10n ** 36n) / den, 36)));

/**
 * @param logs     decoded viem logs (eventName, args, address, transactionHash, logIndex, blockNumber), any order
 * @param ctx      { launchpads: Set, routers: Set, whype, pairToken: Map<pair, token> } (lowercase addresses; every
 *                 Launchpad version in the LaunchRegistry and every router we ever deployed)
 * @param ts       block timestamp in ms
 * @returns { trades: LiveTrade[], graduated: {token, pair, trader, tx, ts}[] }  (trader = who made the graduating buy)
 */
export function liveTrades(logs, { launchpads, routers, whype, pairToken }, ts) {
  const sorted = [...logs].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber),
  );
  const trades = [];
  const graduated = [];
  const base = (l) => ({ tx: l.transactionHash, logIndex: l.logIndex, block: Number(l.blockNumber), ts });

  for (const l of sorted) {
    const at = lc(l.address);
    if (launchpads.has(at) && l.eventName === "Trade") {
      const a = l.args;
      trades.push({
        ...base(l),
        token: lc(a.token),
        venue: "curve",
        side: a.isBuy ? "buy" : "sell",
        trader: lc(a.trader),
        hype: Number(formatEther(a.hypeAmount)),
        tokens: Number(formatEther(a.tokenAmount)),
        priceHype: ratio(a.virtualHype, a.virtualToken),
      });
    } else if (launchpads.has(at) && l.eventName === "Graduated") {
      const buy = sorted.find((s) => s.eventName === "Trade" && lc(s.address) === at && s.transactionHash === l.transactionHash);
      graduated.push({ token: lc(l.args.token), pair: lc(l.args.pair), trader: buy ? lc(buy.args.trader) : null, tx: l.transactionHash, ts });
    } else if (l.eventName === "Swap" && pairToken.has(at)) {
      const token = pairToken.get(at);
      const tokenIs0 = token < whype;
      const a = l.args;
      const [tokIn, tokOut, hypeIn, hypeOut] = tokenIs0
        ? [a.amount0In, a.amount0Out, a.amount1In, a.amount1Out]
        : [a.amount1In, a.amount1Out, a.amount0In, a.amount0Out];
      const isBuy = hypeIn > 0n;
      // reserves after this swap: the pair's last Sync before it in the same tx
      const sync = sorted.findLast(
        (s) => s.eventName === "Sync" && lc(s.address) === at && s.transactionHash === l.transactionHash && s.logIndex < l.logIndex,
      );
      // who traded: our router's Swapped for this token later in the same tx
      const viaRouter = routers.has(lc(a.sender))
        ? sorted.find((s) => s.eventName === "Swapped" && lc(s.address) === lc(a.sender) && s.transactionHash === l.transactionHash && lc(s.args.token) === token)
        : undefined;
      trades.push({
        ...base(l),
        // same id the indexer stores: a router trade is stored from the router's Swapped log, others from the pair Swap
        ...(viaRouter ? { logIndex: viaRouter.logIndex } : {}),
        token,
        venue: "pool",
        side: isBuy ? "buy" : "sell",
        trader: viaRouter ? lc(viaRouter.args.trader) : null,
        hype: Number(formatEther(isBuy ? hypeIn : hypeOut)),
        tokens: Number(formatEther(isBuy ? tokOut : tokIn)),
        priceHype: sync
          ? tokenIs0
            ? ratio(sync.args.reserve1, sync.args.reserve0)
            : ratio(sync.args.reserve0, sync.args.reserve1)
          : null,
      });
    }
  }
  return { trades, graduated };
}
