// Trade Arena rules (TRADE_ARENA.md) as pure functions: no React, no browser APIs, no I/O, so the same file can run in
// the server-side trade engine (Supabase edge function / watcher) later. Today the live match screen runs it in the
// browser (useArenaAccount), which is a preview only: nothing here is authoritative until the server runs it.
//
// Rules: $10,000 of play money; BTC/ETH perps; market orders fill at the best ask (long) / bid (short), close at the
// bid (long) / ask (short); 1-50x leverage, isolated margin per position; no fees; a position is liquidated when its
// loss reaches 94% of its margin (checked against the mid) and the whole margin is lost; at most 10 open positions;
// a liquidation still counts as a trade. To qualify: at least 3 trades (closed positions) and an average hold of at
// least 5 minutes.

export const START_BALANCE = 10_000;
export const MAX_LEVERAGE = 50;
export const MAX_OPEN = 10;
export const LIQ_LOSS = 0.94; // share of margin lost at liquidation
export const MIN_TRADES = 3;
export const MIN_AVG_HOLD_MS = 5 * 60_000;

export type Side = "long" | "short";
export type Quote = { bid: number; ask: number; mid: number };

export type Position = {
  id: string;
  market: string;
  side: Side;
  leverage: number;
  margin: number; // USD put in
  entry: number; // fill price
  qty: number; // coins: margin * leverage / entry
  openedAt: number; // ms
};

export type Trade = Position & {
  exit: number;
  pnl: number; // realized, USD (liquidations: -margin)
  closedAt: number;
  liquidated: boolean;
};

export type Account = {
  cash: number; // free play money (not in a position)
  open: Position[];
  closed: Trade[];
};

export const newAccount = (): Account => ({ cash: START_BALANCE, open: [], closed: [] });

export const liqPrice = (side: Side, entry: number, leverage: number) =>
  side === "long" ? entry * (1 - LIQ_LOSS / leverage) : entry * (1 + LIQ_LOSS / leverage);

/** PnL of a position if it were closed at `price` (never worse than losing its whole margin). */
export const pnlAt = (p: Position, price: number) =>
  Math.max(-p.margin, (p.side === "long" ? price - p.entry : p.entry - price) * p.qty);

/** What closing at the current quote would realize: longs sell at the bid, shorts buy back at the ask. */
export const closePrice = (p: Position, q: Quote) => (p.side === "long" ? q.bid : q.ask);

/** Why an order can't be placed, or null if it can. */
export function orderError(a: Account, margin: number, leverage: number): string | null {
  if (!(margin > 0)) return "Enter a margin";
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > MAX_LEVERAGE) return `Leverage is 1-${MAX_LEVERAGE}x`;
  if (margin > a.cash + 1e-9) return "Not enough free balance";
  if (a.open.length >= MAX_OPEN) return `${MAX_OPEN} open positions max`;
  return null;
}

export function openPosition(
  a: Account,
  o: { id: string; market: string; side: Side; leverage: number; margin: number },
  q: Quote,
  now: number,
): Account {
  const err = orderError(a, o.margin, o.leverage);
  if (err) throw new Error(err);
  const entry = o.side === "long" ? q.ask : q.bid;
  const p: Position = { ...o, entry, qty: (o.margin * o.leverage) / entry, openedAt: now };
  return { ...a, cash: a.cash - o.margin, open: [...a.open, p] };
}

function settle(a: Account, id: string, exit: number, pnl: number, now: number, liquidated: boolean): Account {
  const p = a.open.find((x) => x.id === id);
  if (!p) return a;
  const t: Trade = { ...p, exit, pnl, closedAt: now, liquidated };
  return { cash: a.cash + p.margin + pnl, open: a.open.filter((x) => x.id !== id), closed: [...a.closed, t] };
}

export function closePosition(a: Account, id: string, q: Quote, now: number): Account {
  const p = a.open.find((x) => x.id === id);
  if (!p) return a;
  const exit = closePrice(p, q);
  return settle(a, id, exit, pnlAt(p, exit), now, false);
}

/** Liquidates every open position in `market` whose liquidation price the mid has reached. */
export function liquidate(a: Account, market: string, q: Quote, now: number): Account {
  let next = a;
  for (const p of a.open) {
    if (p.market !== market) continue;
    const liq = liqPrice(p.side, p.entry, p.leverage);
    const hit = p.side === "long" ? q.mid <= liq : q.mid >= liq;
    if (hit) next = settle(next, p.id, liq, -p.margin, now, true);
  }
  return next;
}

/** Account value marked at the mids: free cash + every position's margin and unrealized PnL. */
export function equity(a: Account, mids: Record<string, number | undefined>): number {
  return a.open.reduce((s, p) => s + p.margin + (mids[p.market] ? pnlAt(p, mids[p.market]!) : 0), a.cash);
}

export const realized = (a: Account) => a.closed.reduce((s, t) => s + t.pnl, 0);

/** Trades so far, their average hold, and whether that meets the rules. */
export function qualification(a: Account) {
  const trades = a.closed.length;
  const avgHoldMs = trades ? a.closed.reduce((s, t) => s + (t.closedAt - t.openedAt), 0) / trades : 0;
  return { trades, avgHoldMs, qualified: trades >= MIN_TRADES && avgHoldMs >= MIN_AVG_HOLD_MS };
}
