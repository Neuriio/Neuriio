// Your points: the public `leaderboard` view (sum of points_ledger per X account; the indexer awards every minute),
// looked up by the logged-in X account's id. null = loading or logged out; 0 = no points yet.
import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";

export type MyPoints = { points: number; rank: number | null };

export function usePoints(): MyPoints | null {
  const { ready, authenticated, user } = usePrivy();
  const xId = ready && authenticated ? user?.twitter?.subject : undefined;
  const [mine, setMine] = useState<MyPoints | null>(null);
  useEffect(() => {
    if (!xId) return setMine(null);
    let alive = true;
    const load = () =>
      fetch(`${SUPABASE_URL}/rest/v1/leaderboard?select=points,rank&x_user_id=eq.${encodeURIComponent(xId)}`, {
        headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((rows: { points: number; rank: number }[]) => {
          if (alive) setMine(rows[0] ? { points: Number(rows[0].points), rank: Number(rows[0].rank) } : { points: 0, rank: null });
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 60_000); // the indexer awards once a minute
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [xId]);
  return mine;
}
