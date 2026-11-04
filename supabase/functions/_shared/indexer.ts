// Pure indexer logic (no I/O): turns chain events and Hyperliquid fills into `trades` / `tokens` rows.
// Works for any "world" (registry + its quote token): the old HYPE world (WHYPE, 18 decimals, USD from HYPE's price)
// and the USDC world (6 decimals, 1 USDC = $1). The tables keep their old names (`price_hype`, `virtual_hype`,
// `quote_amount`): they hold amounts and prices in the world's quote token.

import { formatEther, formatUnits, parseAbi } from "npm:viem@2";
import { CATEGORIES } from "./launchPass.ts";

export const launchpadEvents = parseAbi([
  "event Launched(address indexed token, address indexed creator, uint64 indexed xUserId, string handle, uint8 category, bytes32 profileHash, uint256 virtualHype)",
  "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 hypeAmount, uint256 tokenAmount, uint256 fee, uint256 virtualHype, uint256 virtualToken)",
  "event Graduated(address indexed token, address indexed pair, uint256 hype, uint256 tokens, uint256 liquidityBurned)",
  "event FtfLaunched(address indexed token, address indexed founder, string name, string ticker, uint64[4] memberXIds, address[4] members, bytes32 profileHash, uint256 virtualHype)",
]);
export const routerEvents = parseAbi([
  "event Swapped(address indexed token, address indexed trader, address to, bool isBuy, uint256 hypeAmount, uint256 tokenAmount)",
  // NeuriioRouter (USDC world): a curve trade made through it; the NeuriioPad's Trade then names the router as trader
  "event CurveTraded(address indexed token, address indexed trader, bool isBuy, uint256 quoteAmount, uint256 tokenAmount)",
]);

/** A world's quote token: address, decimals, and USD per whole token (USDC: 1; HYPE: its price, or null). */
export type Quote = { address: string; decimals: number; usd: number | null };
export const pairEvents = parseAbi([
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)", // emitted right before Swap: reserves after the trade
]);

/** NeuriioPad.sol: virtual token reserve at launch (1.073B); tokens sold from the curve = this - virtualToken. */
const VIRTUAL_TOKENS = 1_073_000_000n * 10n ** 18n;

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
  price_hype?: string | null; // curve/pool: spot HYPE per token right after the trade (chart, market cap)
  curve_sold?: string | null; // curve: tokens sold from the curve after the trade (progress to graduation)
};

type Log<A> = { args: A; address: string; transactionHash: `0x${string}`; logIndex: number; blockNumber: bigint };

const lc = (a: string) => a.toLowerCase();
const usd = (amount: string, q: Quote) => (q.usd == null ? null : Number(amount) * q.usd);
const amt = (v: bigint, q: Quote) => formatUnits(v, q.decimals);
/** Quote per whole token from raw amounts (token has 18 decimals), as a 36-decimal string (launched-token prices
 *  are tiny: 18 decimals would keep ~11 digits). */
const price = (quoteRaw: bigint, tokenRaw: bigint, q: Quote) =>
  tokenRaw === 0n ? null : formatUnits((quoteRaw * 10n ** BigInt(18 - q.decimals) * 10n ** 36n) / tokenRaw, 36);

/** Pool spot price (quote per token) from a pair's Sync reserves. */
export function poolPrice(reserve0: bigint, reserve1: bigint, token: string, q: Quote): string | null {
  const tokenIs0 = lc(token) < lc(q.address);
  return tokenIs0 ? price(reserve1, reserve0, q) : price(reserve0, reserve1, q);
}

export function launchedToToken(
  log: Log<{ token: string; creator: string; xUserId: bigint; handle: string; category: number; profileHash: string; virtualHype: bigint }>,
  ts: string,
  q: Quote,
) {
  const a = log.args;
  return {
    address: lc(a.token),
    launchpad: lc(log.address), // the Launchpad version that launched it (its curve lives there)
    kind: "individual",
    name: null,
    member_x_user_ids: null,
    x_user_id: a.xUserId.toString(),
    creator: lc(a.creator),
    handle: a.handle,
    symbol: a.handle.toUpperCase(),
    category: CATEGORIES[a.category],
    profile_hash: a.profileHash,
    launch_tx: log.transactionHash,
    launch_block: Number(log.blockNumber),
    launched_at: ts,
    virtual_hype: amt(a.virtualHype, q), // in the quote token; opening price = virtual_hype / 1.073B
  };
}

/** An FTF launch (4 members, one token) -> tokens row. `handle` holds the lower-case ticker (search matches it). */
export function ftfLaunchedToToken(
  log: Log<{
    token: string;
    founder: string;
    name: string;
    ticker: string;
    memberXIds: readonly bigint[];
    profileHash: string;
    virtualHype: bigint;
  }>,
  ts: string,
  q: Quote,
) {
  const a = log.args;
  return {
    address: lc(a.token),
    launchpad: lc(log.address),
    kind: "ftf",
    name: a.name,
    x_user_id: null,
    member_x_user_ids: a.memberXIds.map((x) => x.toString()),
    creator: lc(a.founder),
    handle: a.ticker.toLowerCase(),
    symbol: a.ticker,
    category: null,
    profile_hash: a.profileHash,
    launch_tx: log.transactionHash,
    launch_block: Number(log.blockNumber),
    launched_at: ts,
    virtual_hype: amt(a.virtualHype, q),
  };
}

export function curveTradeToRow(
  log: Log<{
    token: string;
    trader: string;
    isBuy: boolean;
    hypeAmount: bigint;
    tokenAmount: bigint;
    fee: bigint;
    virtualHype: bigint;
    virtualToken: bigint;
  }>,
  ts: string,
  q: Quote,
  trader?: string, // the real trader when the trade came through our router (the pad only sees the router)
): TradeRow {
  const a = log.args;
  const quote = amt(a.hypeAmount, q);
  return {
    venue: "curve",
    trader: lc(trader ?? a.trader),
    market: lc(a.token),
    side: a.isBuy ? "buy" : "sell",
    size: formatEther(a.tokenAmount),
    quote_amount: quote,
    usd_value: usd(quote, q),
    fee: amt(a.fee, q),
    tx_hash: log.transactionHash,
    log_index: log.logIndex,
    block_number: Number(log.blockNumber),
    ts,
    price_hype: price(a.virtualHype, a.virtualToken, q),
    curve_sold: formatEther(VIRTUAL_TOKENS - a.virtualToken),
  };
}

export function routerSwapToRow(
  log: Log<{ token: string; trader: string; isBuy: boolean; hypeAmount: bigint; tokenAmount: bigint }>,
  ts: string,
  q: Quote,
  priceAfter: string | null = null,
): TradeRow {
  const a = log.args;
  const quote = amt(a.hypeAmount, q);
  return {
    venue: "pool",
    trader: lc(a.trader),
    market: lc(a.token),
    side: a.isBuy ? "buy" : "sell",
    size: formatEther(a.tokenAmount),
    quote_amount: quote,
    usd_value: usd(quote, q),
    fee: null,
    tx_hash: log.transactionHash,
    log_index: log.logIndex,
    block_number: Number(log.blockNumber),
    ts,
    price_hype: priceAfter,
    curve_sold: null,
  };
}

/** A pair Swap NOT made through our router (e.g. an aggregator): trader = the tx sender. */
export function pairSwapToRow(
  log: Log<{ amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint }>,
  token: string,
  q: Quote,
  txFrom: string,
  ts: string,
  priceAfter: string | null = null,
): TradeRow {
  const a = log.args;
  const tokenIs0 = lc(token) < lc(q.address);
  const [tokIn, tokOut, quoteIn, quoteOut] = tokenIs0
    ? [a.amount0In, a.amount0Out, a.amount1In, a.amount1Out]
    : [a.amount1In, a.amount1Out, a.amount0In, a.amount0Out];
  const isBuy = quoteIn > 0n;
  const quote = amt(isBuy ? quoteIn : quoteOut, q);
  return {
    venue: "pool",
    trader: lc(txFrom),
    market: lc(token),
    side: isBuy ? "buy" : "sell",
    size: formatEther(isBuy ? tokOut : tokIn),
    quote_amount: quote,
    usd_value: usd(quote, q),
    fee: null,
    tx_hash: log.transactionHash,
    log_index: log.logIndex,
    block_number: Number(log.blockNumber),
    ts,
    price_hype: priceAfter,
    curve_sold: null,
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

// ------------------------------------------------------------------ Ascend (Elysium mainnet, user 2026-11-04)
// Tokens launch through our NeuriioLauncher into Ascend's Uniswap v4 pools (one PoolManager, the Ascend launchpad as hook).
// There's no curve: a token trades in its pool from launch (graduated = true, `pair` holds the v4 pool id).

export const launcherEvents = parseAbi([
  "event Launched(address indexed token, address indexed creator, uint64 indexed xUserId, string handle, uint8 category, bytes32 profileHash, bytes32 pool)",
  "event FtfLaunched(address indexed token, address indexed founder, string name, string ticker, uint64[4] memberXIds, address[4] members, bytes32 profileHash, bytes32 pool)",
]);
/** Uniswap v4 PoolManager: the AMM's part of a swap, from the swapper's side (negative = paid in), and the price after. */
export const poolManagerSwap = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
])[0];
/** Ascend's launchpad (the hook): each swap's fee, in the pair asset's slot (the PoolManager's Swap reports an LP fee of 0). */
export const hookSwap = parseAbi([
  "event HookSwap(bytes32 indexed poolId, address indexed sender, int128 amount0, int128 amount1, uint128 hookLPfeeAmount0, uint128 hookLPfeeAmount1)",
])[0];

/** A launch through NeuriioLauncher -> tokens row. No opening price is stored: the first trade sets it. */
export function launcherLaunchedToToken(
  log: Log<{ token: string; creator: string; xUserId: bigint; handle: string; category: number; profileHash: string; pool: string }>,
  ts: string,
) {
  const a = log.args;
  return {
    address: lc(a.token),
    launchpad: lc(log.address),
    kind: "individual",
    name: null,
    member_x_user_ids: null,
    x_user_id: a.xUserId.toString(),
    creator: lc(a.creator),
    handle: a.handle,
    symbol: a.handle.toUpperCase(),
    category: CATEGORIES[a.category],
    profile_hash: a.profileHash,
    launch_tx: log.transactionHash,
    launch_block: Number(log.blockNumber),
    launched_at: ts,
    graduated: true,
    graduated_at: ts,
    pair: lc(a.pool),
    virtual_hype: null,
  };
}

export function launcherFtfLaunchedToToken(
  log: Log<{ token: string; founder: string; name: string; ticker: string; memberXIds: readonly bigint[]; profileHash: string; pool: string }>,
  ts: string,
) {
  const a = log.args;
  return {
    address: lc(a.token),
    launchpad: lc(log.address),
    kind: "ftf",
    name: a.name,
    x_user_id: null,
    member_x_user_ids: a.memberXIds.map((x) => x.toString()),
    creator: lc(a.founder),
    handle: a.ticker.toLowerCase(),
    symbol: a.ticker,
    category: null,
    profile_hash: a.profileHash,
    launch_tx: log.transactionHash,
    launch_block: Number(log.blockNumber),
    launched_at: ts,
    graduated: true,
    graduated_at: ts,
    pair: lc(a.pool),
    virtual_hype: null,
  };
}

const Q192 = 1n << 192n;
/** Quote per whole token from a v4 sqrtPriceX96 (currency1 per currency0, base units), as a 36-decimal string. */
export function sqrtPriceToQuote(sqrtPriceX96: bigint, token: string, q: Quote): string | null {
  if (sqrtPriceX96 === 0n) return null;
  const sq = sqrtPriceX96 * sqrtPriceX96;
  const scale = 10n ** BigInt(18 - q.decimals) * 10n ** 36n;
  const raw = lc(token) < lc(q.address) ? (sq * scale) / Q192 : (Q192 * scale) / sq;
  return formatUnits(raw, 36);
}

const abs = (v: bigint) => (v < 0n ? -v : v);

/** A swap in one of our tokens' Ascend pools -> trades row. `hookFee`: the fee in the quote token (from HookSwap), or null.
 *  A buy pays the fee on top of what the AMM took; a sell's fee comes out of what the AMM paid; either way `quote_amount` is
 *  the trade's whole USDC side, fee included. */
export function ascendSwapToRow(
  log: Log<{ amount0: bigint; amount1: bigint; sqrtPriceX96: bigint }>,
  token: string,
  q: Quote,
  txFrom: string,
  ts: string,
  hookFee: bigint | null,
): TradeRow {
  const a = log.args;
  const tokenIs0 = lc(token) < lc(q.address);
  const [tokenDelta, quoteDelta] = tokenIs0 ? [a.amount0, a.amount1] : [a.amount1, a.amount0];
  const isBuy = quoteDelta < 0n; // the swapper paid USDC in
  const fee = hookFee ?? 0n;
  const quote = amt(isBuy ? abs(quoteDelta) + fee : abs(quoteDelta), q);
  return {
    venue: "pool",
    trader: lc(txFrom),
    market: lc(token),
    side: isBuy ? "buy" : "sell",
    size: formatEther(abs(tokenDelta)),
    quote_amount: quote,
    usd_value: usd(quote, q),
    fee: hookFee == null ? null : amt(hookFee, q),
    tx_hash: log.transactionHash,
    log_index: log.logIndex,
    block_number: Number(log.blockNumber),
    ts,
    price_hype: sqrtPriceToQuote(a.sqrtPriceX96, token, q),
    curve_sold: null,
  };
}

/** The quote-token fee of each HookSwap, keyed `tx:poolId`, in log order (paired with that tx's Swaps in the same pool). */
export function hookFeesByTx(
  logs: Log<{ poolId: string; hookLPfeeAmount0: bigint; hookLPfeeAmount1: bigint }>[],
  tokenOfPool: Map<string, string>,
  q: Quote,
) {
  const out = new Map<string, bigint[]>();
  for (const l of [...logs].sort((x, y) => x.logIndex - y.logIndex)) {
    const token = tokenOfPool.get(lc(l.args.poolId));
    if (!token) continue;
    const fee = lc(token) < lc(q.address) ? l.args.hookLPfeeAmount1 : l.args.hookLPfeeAmount0;
    const key = `${l.transactionHash}:${lc(l.args.poolId)}`;
    out.set(key, [...(out.get(key) ?? []), fee]);
  }
  return out;
}
