// A trade placed on Neuriio, on every chart and in Positions about a second after it lands (user, 2026-11-07), without
// watching the chain: once the receipt is in, the app sends the hash to the record-trade function, which reads that one
// receipt, stores the trade and broadcasts it to everyone watching. Its answer is shown here at once too (the trader doesn't
// wait for the broadcast). The indexer stores the same trade later as a backup. Never throws: a trade is done either way.
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";
import { addLocalTrades, type LiveTrade } from "./live";

export function recordTrade(hash: string): void {
  const ask = () =>
    fetch(`${SUPABASE_URL}/functions/v1/record-trade`, {
      method: "POST",
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ tx: hash }),
    });
  (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await ask().catch(() => null);
      // 404: the provider behind the function hasn't seen the receipt yet; ask again in a moment
      if (res?.status === 404 || !res) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as { trades?: LiveTrade[] } | null;
      if (body?.trades?.length) addLocalTrades(body.trades);
      return;
    }
  })().catch(() => {});
}
