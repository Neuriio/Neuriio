// GET /agora (vercel.json rewrites it here): Agora's public token feed (api.agoradex.app; reading it approved by the user,
// 2026-11-05), passed through with CDN caching so Agora sees about one request a minute per region however many people visit,
// and a slow or failed Agora answer still serves the last good copy (stale-while-revalidate).
//   /agora?list=top                     the top 15 Elysium tokens by 24h volume, every launchpad
//   /agora?token=0x…&range=24h|7d|30d   one token: stats, candles, recent trades, holders
// Only these two shapes are forwarded; anything else is refused.

export const config = { runtime: "edge" };

const AGORA = "https://api.agoradex.app/api/tokens";
const RANGES = new Set(["24h", "7d", "30d"]);
const TOP_LIMIT = 15;

const refuse = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function agoraTarget(url: URL): { target: string; maxAge: number } | null {
  const token = url.searchParams.get("token");
  if (token !== null) {
    const range = url.searchParams.get("range") ?? "24h";
    if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !RANGES.has(range)) return null;
    return { target: `${AGORA}/${token.toLowerCase()}?range=${range}`, maxAge: 30 };
  }
  if (url.searchParams.get("list") === "top") {
    return { target: `${AGORA}?sort=volume&window=24h&launchpad=all&q=&limit=${TOP_LIMIT}&offset=0`, maxAge: 60 };
  }
  return null;
}

export default async function agora(req: Request): Promise<Response> {
  if (req.method !== "GET") return refuse(405, "GET only");
  const t = agoraTarget(new URL(req.url));
  if (!t) return refuse(400, "Ask for ?list=top or ?token=0x…&range=24h|7d|30d");
  try {
    const res = await fetch(t.target, { headers: { accept: "application/json" } });
    if (!res.ok) return refuse(502, "The token feed didn't answer");
    return new Response(await res.text(), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=15, s-maxage=${t.maxAge}, stale-while-revalidate=600`,
      },
    });
  } catch {
    return refuse(502, "The token feed didn't answer");
  }
}
