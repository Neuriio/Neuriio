// Turns one block's Launchpad / router / pair logs into live trade messages for the charts.
// Pure (no I/O). Mirrors supabase/functions/_shared/indexer.ts, which stores the same trades a minute later.
// Amounts and prices are in the world's quote token (USDC, 6 decimals; the old HYPE world: WHYPE, 18), per whole
// token; the message keys keep their old names (`hype`, `priceHype`).
//   curve trade: Launchpad.Trade; price after = virtual quote / virtual token. Made through the NeuriioRouter, the
//                pad names the router as trader: the router's CurveTraded (same tx, same token) names the real one
//   pool trade:  the pair's Swap; price after = the pair's Sync just before it (quote reserve / token reserve);
//                trader from our router's Swapped in the same tx, else null (aggregators; the indexer uses tx.from)
import { formatUnits, parseAbi } from "viem";

export const watchEvents = parseAbi([
  "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 hypeAmount, uint256 tokenAmount, uint256 fee, uint256 virtualHype, uint256 virtualToken)",
  "event Graduated(address indexed token, address indexed pair, uint256 hype, uint256 tokens, uint256 liquidityBurned)",
  "event Swapped(address indexed token, address indexed trader, address to, bool isBuy, uint256 hypeAmount, uint256 tokenAmount)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "event CurveTraded(address indexed token, address indexed trader, bool isBuy, uint256 quoteAmount, uint256 tokenAmount)",
]);

const lc = (a) => a.toLowerCase();
/** quote per whole token from raw amounts (tokens have 18 decimals), as a JS number (enough for charts). */
export const priceOf = (quoteRaw, tokenRaw, decimals) =>
  tokenRaw === 0n ? null : Number(formatUnits((quoteRaw * 10n ** BigInt(18 - decimals) * 10n ** 36n) / tokenRaw, 36));

/**
 * @param logs     decoded viem logs (eventName, args, address, transactionHash, logIndex, blockNumber), any order
 * @param ctx      { launchpads: Set, routers: Set, quote, decimals, pairToken: Map<pair, token> } (lowercase addresses;
 *                 every Launchpad version in the LaunchRegistry and every router we ever deployed; `quote` = the
 *                 world's quote token (`whype` is accepted for the old world), `decimals` its decimals, default 18)
 * @param ts       block timestamp in ms
 * @returns { trades: LiveTrade[], graduated: {token, pair, trader, tx, ts}[] }  (trader = who made the graduating buy)
 */
export function liveTrades(logs, { launchpads, routers, quote: quoteToken, whype, decimals = 18, pairToken }, ts) {
  const quote = lc(quoteToken ?? whype);
  const amount = (v) => Number(formatUnits(v, decimals));
  const tokens = (v) => Number(formatUnits(v, 18));
  const sorted = [...logs].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber),
  );
  const trades = [];
  const graduated = [];
  const base = (l) => ({ tx: l.transactionHash, logIndex: l.logIndex, block: Number(l.blockNumber), ts });
  /** the real trader of a pad Trade: the router's CurveTraded for the same token in the same tx, if the router traded */
  const traderOf = (t) => {
    const named = lc(t.args.trader);
    if (!routers.has(named)) return named;
    const ct = sorted.find((s) => s.eventName === "CurveTraded" && lc(s.address) === named && s.transactionHash === t.transactionHash && lc(s.args.token) === lc(t.args.token));
    return ct ? lc(ct.args.trader) : named;
  };

  for (const l of sorted) {
    const at = lc(l.address);
    if (launchpads.has(at) && l.eventName === "Trade") {
      const a = l.args;
      trades.push({
        ...base(l),
        token: lc(a.token),
        venue: "curve",
        side: a.isBuy ? "buy" : "sell",
        trader: traderOf(l),
        hype: amount(a.hypeAmount),
        tokens: tokens(a.tokenAmount),
        priceHype: priceOf(a.virtualHype, a.virtualToken, decimals),
      });
    } else if (launchpads.has(at) && l.eventName === "Graduated") {
      const buy = sorted.find((s) => s.eventName === "Trade" && lc(s.address) === at && s.transactionHash === l.transactionHash);
      graduated.push({ token: lc(l.args.token), pair: lc(l.args.pair), trader: buy ? traderOf(buy) : null, tx: l.transactionHash, ts });
    } else if (l.eventName === "Swap" && pairToken.has(at)) {
      const token = pairToken.get(at);
      const tokenIs0 = token < quote;
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
        hype: amount(isBuy ? hypeIn : hypeOut),
        tokens: tokens(isBuy ? tokOut : tokIn),
        priceHype: sync
          ? tokenIs0
            ? priceOf(sync.args.reserve1, sync.args.reserve0, decimals)
            : priceOf(sync.args.reserve0, sync.args.reserve1, decimals)
          : null,
      });
    }
  }
  return { trades, graduated };
}
