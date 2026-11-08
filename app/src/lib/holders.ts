// Top holders (user, 2026-11-08): the 10 biggest wallets of a coin, by % of supply. Balances are kept from the coin's own Transfer
// events by the launch-check service (keeper/src/holders/holders.mjs) into token_balances; this only reads the top 10.
import { ASCEND } from "./config";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";

export type Holder = { address: string; pct: number; label: string | null };
const SUPPLY = 1e27; // every Ascend and Neuriio coin: 1,000,000,000 tokens x 1e18
const BURN = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);

/** The top 10, or null if this coin isn't counted yet. Labels: the pool, the creator, burned. */
export async function topHolders(token: string, creator?: string | null): Promise<Holder[] | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/token_balances?token=eq.${token.toLowerCase()}&select=holder,balance&order=balance.desc&limit=10`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as { holder: string; balance: number | string }[];
  if (!rows.length) return null;
  const pool = ASCEND.poolManager.toLowerCase();
  const me = creator?.toLowerCase() || null;
  return rows.map((r) => ({
    address: r.holder,
    pct: (Number(r.balance) / SUPPLY) * 100,
    label: r.holder === pool ? "Pool" : r.holder === me ? "Creator" : BURN.has(r.holder) ? "Burned" : null,
  }));
}
