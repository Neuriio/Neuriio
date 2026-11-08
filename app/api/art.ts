// GET /art/<cid> (vercel.json rewrites it here): a coin picture from IPFS, cached on Vercel's CDN for a year. A CID names exactly
// one file, so the cache never goes stale. Replaces gateway.pinata.cloud in the page (slow public gateway; user, 2026-11-08).
export const config = { runtime: "edge" };

const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;
const GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/"];

export default async function art(req: Request): Promise<Response> {
  const cid = new URL(req.url).searchParams.get("cid") ?? "";
  if (!CID.test(cid)) return new Response("bad cid", { status: 400 });
  for (const g of GATEWAYS) {
    try {
      const res = await fetch(g + cid, { signal: AbortSignal.timeout(8_000) });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.startsWith("image/")) continue;
      return new Response(res.body, {
        headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
      });
    } catch {
      /* next gateway */
    }
  }
  return new Response("not found", { status: 404, headers: { "cache-control": "public, max-age=300" } });
}
