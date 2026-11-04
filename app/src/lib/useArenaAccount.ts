// The live match screen's play-money account, run in the browser with the Trade Arena rules (arenaEngine.ts) on live
// Hyperliquid prices. PREVIEW ONLY until the server-side trade engine exists: saved in this browser (localStorage),
// nobody else sees it, nothing checks it. Liquidations run on every price tick; orders are limited to 3 a second.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  closePosition,
  liquidate,
  newAccount,
  openPosition,
  orderError,
  type Account,
  type Quote,
  type Side,
} from "./arenaEngine";

const KEY = "neuriio:arena-preview";
const MAX_ORDERS_PER_SEC = 3;

function load(): Account {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Account;
  } catch {
    // private window / blocked storage: start fresh
  }
  return newAccount();
}

export function useArenaAccount(quotes: Record<string, Quote | null>) {
  const [account, setAccount] = useState<Account>(load);
  const sent = useRef<number[]>([]); // order times in the last second

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(account));
    } catch {
      // not saved: fine for a preview
    }
  }, [account]);

  // liquidations: every tick of every market
  const mids = Object.entries(quotes)
    .map(([k, q]) => `${k}:${q?.mid ?? ""}`)
    .join("|");
  useEffect(() => {
    setAccount((a) => {
      let next = a;
      for (const [k, q] of Object.entries(quotes)) if (q) next = liquidate(next, k, q, Date.now());
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mids]);

  /** Places a market order; returns an error message, or null when it filled. */
  const open = useCallback(
    (market: string, side: Side, leverage: number, margin: number): string | null => {
      const q = quotes[market];
      if (!q) return "Waiting for a price";
      const now = Date.now();
      sent.current = sent.current.filter((t) => now - t < 1_000);
      if (sent.current.length >= MAX_ORDERS_PER_SEC) return "Too many orders · wait a second";
      const err = orderError(account, margin, leverage);
      if (err) return err;
      sent.current.push(now);
      // re-checked against the latest account: two quick orders can't spend the same balance twice
      setAccount((a) =>
        orderError(a, margin, leverage)
          ? a
          : openPosition(a, { id: crypto.randomUUID(), market, side, leverage, margin }, q, now),
      );
      return null;
    },
    [account, quotes],
  );

  const close = useCallback(
    (id: string) => {
      setAccount((a) => {
        const p = a.open.find((x) => x.id === id);
        const q = p && quotes[p.market];
        return q ? closePosition(a, id, q, Date.now()) : a;
      });
    },
    [quotes],
  );

  const reset = useCallback(() => setAccount(newAccount()), []);

  return { account, open, close, reset };
}
