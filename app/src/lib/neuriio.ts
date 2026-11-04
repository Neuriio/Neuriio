// Your Neuriio: a tally that converts into the token when it launches. Stakers are the only ones who get it, 100 for every $1 of fees
// they earn (user, 2026-11-01). Worked out by keeper/src/fees/neuriio.mjs; this only reads it. No table yet, or an error: 0.
import { useEffect, useState } from "react";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";

/** A wallet's Neuriio, from every token it staked or just `token`. */
export function useNeuriio(wallet: string | undefined, token?: string): number {
  const [minted, setMinted] = useState(0);
  useEffect(() => {
    if (!wallet) return setMinted(0);
    let alive = true;
    const load = () =>
      fetch(`${SUPABASE_URL}/rest/v1/neuriio_balances?wallet=eq.${wallet.toLowerCase()}${token ? `&token=eq.${token.toLowerCase()}` : ""}&select=minted`, {
        headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
      })
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: { minted: number | string }[]) => alive && setMinted(rows.reduce((a, r) => a + Number(r.minted), 0) / 1e6))
        .catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [wallet, token]);
  return minted;
}
