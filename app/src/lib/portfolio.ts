// The Feed's portfolio: your Neuriio wallet plus any wallets you've connected, added up. Balances come from the chain (lib/balances.ts).
// There's no stored balance history yet, so the balance chart draws from one snapshot a day kept in this browser: it starts flat and fills
// in as days pass, and never invents a past.
import type { Address } from "viem";
import { fetchBalances, type TokenBalance } from "./balances";

export type PortfolioParts = { usdc: number; hype: number; tokens: number };
export type Portfolio = { total: number; parts: PortfolioParts; elysium: TokenBalance[] };
export type Snapshot = PortfolioParts & { day: string };

const partsOf = (byToken: Iterable<TokenBalance>): PortfolioParts => {
  const parts = { usdc: 0, hype: 0, tokens: 0 };
  for (const t of byToken) {
    if (t.symbol === "USDC") parts.usdc += t.usd;
    else if (t.symbol === "HYPE") parts.hype += t.usd;
    else parts.tokens += t.usd;
  }
  return parts;
};

export async function fetchPortfolio(addresses: Address[]): Promise<Portfolio> {
  const all = await Promise.all(addresses.map(fetchBalances));
  const elysium = new Map<string, TokenBalance>();
  for (const b of all) {
    for (const t of b.elysium.tokens) {
      if (t.amount <= 0) continue;
      const had = elysium.get(t.symbol);
      elysium.set(t.symbol, { symbol: t.symbol, amount: (had?.amount ?? 0) + t.amount, usd: (had?.usd ?? 0) + t.usd });
    }
  }
  return {
    total: all.reduce((a, b) => a + b.total, 0),
    parts: partsOf(all.flatMap((b) => [...b.elysium.tokens, ...b.hypercore.tokens])),
    elysium: [...elysium.values()].sort((a, b) => b.usd - a.usd),
  };
}

const HISTORY_KEY = "neuriio:portfolio-history";
const MAX_DAYS = 366;

/** Saves today's snapshot (replacing an earlier one from today) and returns the history, oldest first. */
export function recordSnapshot(parts: PortfolioParts, key: string, today = new Date().toISOString().slice(0, 10)): Snapshot[] {
  const storeKey = `${HISTORY_KEY}:${key}`;
  let days: Snapshot[] = [];
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) ?? "[]");
    if (Array.isArray(saved)) days = saved;
  } catch {
    /* private window / blocked storage: today only */
  }
  days = [...days.filter((d) => d.day !== today), { ...parts, day: today }].slice(-MAX_DAYS);
  try {
    localStorage.setItem(storeKey, JSON.stringify(days));
  } catch {
    /* same */
  }
  return days;
}

/** Sample numbers for `?demo`. */
export const DEMO_PORTFOLIO: Portfolio = {
  total: 67_895,
  parts: { usdc: 31_200, hype: 21_400, tokens: 15_295 },
  elysium: [
    { symbol: "USDC", amount: 21_200, usd: 21_200 },
    { symbol: "HYPE", amount: 142, usd: 13_100 },
    { symbol: "$kntqkid", amount: 4e7, usd: 6_120 },
    { symbol: "$the_liq", amount: 2e7, usd: 3_240 },
    { symbol: "KNTQ", amount: 800, usd: 2_210 },
    { symbol: "$vaultvera", amount: 1e7, usd: 1_480 },
    { symbol: "$den", amount: 8e6, usd: 910 },
    { symbol: "$wagmiwes", amount: 4e6, usd: 545 },
    { symbol: "$onchain", amount: 2e6, usd: 330 },
  ],
};
export const DEMO_HISTORY: Snapshot[] = [
  ["2026-01-15", 30_000, 16_000, 12_000],
  ["2026-03-01", 30_500, 14_500, 11_000],
  ["2026-05-15", 30_000, 18_000, 12_000],
  ["2026-08-01", 30_800, 20_000, 13_500],
  ["2026-10-30", 31_200, 21_400, 15_295],
].map(([day, usdc, hype, tokens]) => ({ day: day as string, usdc: usdc as number, hype: hype as number, tokens: tokens as number }));
