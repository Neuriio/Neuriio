// GET /api/explore: Explore's first screen in ONE response, cached on Vercel's CDN (user, 2026-11-11: "cache for first page loads").
// Without it a first visit waits for the whole app to download, then asks Supabase three times in a row (the Verified top 15,
// our token_stats rows for any of them, the first coin's chart). index.html preloads this URL, so it arrives while the app is
// still downloading, and lib/explore.ts uses it for the first paint only; after that everything polls live as before.
// Every visitor in the same 15 s gets the same cached copy: Supabase sees ~4 requests a minute from here, not 3 per visitor.
export const config = { runtime: "edge" };

// public values (the same ones the page ships with): this route is self-contained, like the others in api/
const SUPABASE_URL = "https://yviymgfgaepmtijgyyyo.supabase.co";
const SUPABASE_KEY = "sb_publishable_FegCC3kuFI9k3EsEP2TGYA_zucL2uoq";
const REGISTRY = "0x637b9f79e3094045661a228d9df976db4d6c0f30"; // our launcher: token_stats lists this world (x-neuriio-registry)
const LIMIT = 15; // Explore's Verified list
const CHART_INTERVAL = 1800; // Explore opens on 30m (ExploreCard)
const CHART_BARS = 300;

async function rest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json", "x-neuriio-registry": REGISTRY, ...init?.headers },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`${path.split("?")[0]}: ${res.status}`);
  return res.json() as Promise<T>;
}

type Row = Record<string, unknown> & { address: string };

export default async function explore(): Promise<Response> {
  try {
    const [top, head] = await Promise.all([
      rest<Row[]>(`ascend_token_stats?select=*&volume_usd_24h=gt.0&order=volume_usd_24h.desc&limit=${LIMIT}`),
      rest<{ value: string; updated_at: string }[]>("app_config?select=value,updated_at&key=eq.elysium_head"),
    ]);
    const first = top[0]?.address ?? null;
    const [ours, chart] = await Promise.all([
      top.length ? rest<Row[]>(`token_stats?select=*&address=in.(${top.map((r) => r.address).join(",")})`) : Promise.resolve([]),
      first
        ? rest<unknown[]>("rpc/token_chart", {
          method: "POST",
          body: JSON.stringify({ p_token: first.toLowerCase(), p_interval: CHART_INTERVAL, p_limit: CHART_BARS }),
        })
        : Promise.resolve(null),
    ]);
    const body = {
      at: Date.now(),
      top, // Ascend's top coins by 24h volume (ascend_token_stats rows)
      ours, // our own token_stats rows for any of them (shown in their place)
      head: head[0] ?? null,
      chart: first ? { address: first.toLowerCase(), interval: CHART_INTERVAL, bars: CHART_BARS, rows: chart } : null,
    };
    return new Response(JSON.stringify(body), {
      headers: {
        "content-type": "application/json",
        // CDN: fresh for 15 s, then served stale for up to a minute while one request refreshes it; browsers don't keep it
        "cache-control": "public, max-age=0, s-maxage=15, stale-while-revalidate=60",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 502,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
}
