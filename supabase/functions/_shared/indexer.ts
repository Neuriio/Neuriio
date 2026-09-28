// Pure indexer logic (no I/O): turns chain events and Hyperliquid fills into `trades` / `tokens` rows.

import { formatEther, parseAbi } from "npm:viem@2";
import { CATEGORIES } from "./launchPass.ts";

export const launchpadEvents = parseAbi([
  "event Launched(address indexed token, address indexed creator, uint64 indexed xUserId, string handle, uint8 category, bytes32 profileHash, uint256 virtualHype)",
  "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 hypeAmount, uint256 tokenAmount, uint256 fee, uint256 virtualHype, uint256 virtualToken)",
  "event Graduated(address indexed token, address indexed pair, uint256 hype, uint256 tokens, uint256 liquidityBurned)",
]);
export const routerEvents = parseAbi([
  "event Swapped(address indexed token, address indexed trader, address to, bool isBuy, uint256 hypeAmount, uint256 tokenAmount)",
]);
export const pairEvents = parseAbi([
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
]);

export type Venue = "curve" | "pool" | "hl_perp" | "hl_spot" | "hl_outcome";

export type TradeRow = {
  venue: Venue;
  trader: string;
  market: string;
  side: "buy" | "sell";
  size: string;
  quote_amount: string;
  usd_value: number | null;
  fee: string | null;
  tx_hash?: string;
  log_index?: number;
  hl_tid?: number;
  block_number?: number;
  ts: string;
};

type Log<A> = { args: A; transactionHash: `0x${string}`; logIndex: number; blockNumber: bigint };

const lc = (a: string) => a.toLowerCase();
const usd = (hype: string, hypeUsd: number | null) => (hypeUsd == null ? null : Number(hype) * hypeUsd);

export function launchedToToken(
  log: Log<{ token: string; creator: string; xUserId: bigint; handle: string; category: number; profileHash: string }>,
  ts: string,
) {
  const a = log.args;
  return {
    address: lc(a.token),
    x_user_id: a.xUserId.toString(),
    creator: lc(a.creator),
    handle: a.handle,
    symbol: a.handle.toUpperCase(),
    category: CATEGORIES[a.category],
    profile_hash: a.profileHash,
    launch_tx: log.transactionHash,
    launch_block: Number(log.blockNumber),
    launched_at: ts,
  };
}

export function curveTradeToRow(
  log: Log<{ token: string; trader: string; isBuy: boolean; hypeAmount: bigint; tokenAmount: bigint; fee: bigint }>,
  ts: string,
  hypeUsd: number | null,
): TradeRow {
  const a = log.args;
  const quote = formatEther(a.hypeAmount);
  return {
    venue: "curve",
    trader: lc(a.trader),
    market: lc(a.token),
    side: a.isBuy ? "buy" : "sell",
    size: formatEther(a.tokenAmount),
    quote_amount: quote,
    usd_value: usd(quote, hypeUsd),
    fee: formatEther(a.fee),
    tx_hash: log.transactionHash,
    log_index: log.logIndex,
    block_number: Number(log.blockNumber),
    ts,
  };
}

export function routerSwapToRow(
  log: Log<{ token: string; trader: string; isBuy: boolean; hypeAmount: bigint; tokenAmount: bigint }>,
  ts: string,
  hypeUsd: number | null,
): TradeRow {
  const a = log.args;
  const quote = formatEther(a.hypeAmount);
  return {
    venue: "pool",
    trader: lc(a.trader),
    market: lc(a.token),
    side: a.isBuy ? "buy" : "sell",
    size: formatEther(a.tokenAmount),
    quote_amount: quote,
    usd_value: usd(quote, hypeUsd),
    fee: null,
    tx_hash: log.transactionHash,
    log_index: log.logIndex,
    block_number: Number(log.blockNumber),
    ts,
  };
}

/** A pair Swap NOT made through our router (e.g. an aggregator): trader = the tx sender. */
export function pairSwapToRow(
  log: Log<{ amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint }>,
  token: string,
  whype: string,
  txFrom: string,
  ts: string,
  hypeUsd: number | null,
): TradeRow {
  const a = log.args;
  const tokenIs0 = lc(token) < lc(whype);
  const [tokIn, tokOut, hypeIn, hypeOut] = tokenIs0
    ? [a.amount0In, a.amount0Out, a.amount1In, a.amount1Out]
    : [a.amount1In, a.amount1Out, a.amount0In, a.amount0Out];
  const isBuy = hypeIn > 0n;
  const quote = formatEther(isBuy ? hypeIn : hypeOut);
  return {
    venue: "pool",
    trader: lc(txFrom),
    market: lc(token),
    side: isBuy ? "buy" : "sell",
    size: formatEther(isBuy ? tokOut : tokIn),
    quote_amount: quote,
    usd_value: usd(quote, hypeUsd),
    fee: null,
    tx_hash: log.transactionHash,
    log_index: log.logIndex,
    block_number: Number(log.blockNumber),
    ts,
  };
}

/** Hyperliquid coin naming: "#N" outcome, "@N" or "BASE/QUOTE" spot, anything else (incl. "dex:COIN") perp. */
export function hlVenue(coin: string): Venue {
  if (coin.startsWith("#")) return "hl_outcome";
  if (coin.startsWith("@") || coin.includes("/")) return "hl_spot";
  return "hl_perp";
}

export type HlFill = {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  fee: string;
  tid: number;
  builderFee?: string;
};

/** Only fills carrying a builder fee count: that's how we know the order came through Neuriio. */
export function hlFillToRow(fill: HlFill, wallet: string): TradeRow | null {
  if (!fill.builderFee || Number(fill.builderFee) <= 0) return null;
  const notional = Number(fill.px) * Number(fill.sz);
  return {
    venue: hlVenue(fill.coin),
    trader: lc(wallet),
    market: fill.coin,
    side: fill.side === "B" ? "buy" : "sell",
    size: fill.sz,
    quote_amount: String(notional),
    usd_value: notional,
    fee: fill.fee,
    hl_tid: fill.tid,
    ts: new Date(fill.time).toISOString(),
  };
}
