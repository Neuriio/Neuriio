// Agora's public token feed (user, 2026-11-05: Explore's Trending list and token pages read it, replacing our own watch of
// Ascend). Production reads it through our cached /agora route (app/api/agora.ts); local dev calls Agora directly (it allows
// any site). Agora prices everything in HYPE and sends the HYPE price, so this turns it all into USD.
// Our own launches, when they make Agora's list, come from our token_stats instead (Neuriio logo, profile, trading).
import type { Candle, IntervalSeconds, TokenStat } from "./explore";

const DIRECT = "https://api.agoradex.app/api/tokens";
const SUPPLY = 1e9; // our chart and lists show market cap as price × 1e9 (see AgoraStats.price below)

type AgoraStats = {
  mcap: number; // HYPE
  price: number; // HYPE per token
  change: Partial<Record<"1h" | "6h" | "24h" | "7d", number>>; // fractions: 0.5 = +50%
  volume: Partial<Record<"1h" | "6h" | "24h" | "7d", number>>; // HYPE
  trades24h?: number;
  lastTradeAt?: number; // unix seconds
};
type AgoraToken = {
  address: string;
  name: string;
  symbol: string;
  image: string | null;
  launchpad: string; // "montra", "kleos", "ascend", ...
  version: string | null; // display name, e.g. "Montra", "v4"
  base: string | null; // what it trades against, e.g. "HYPE"
  createdAt: number; // ms
  stats: AgoraStats;
  holders?: number;
  description?: string | null;
  candles?: [number, number, number, number, number, number][]; // [unix s, open, high, low, close, volume HYPE], in HYPE
};
type TopFeed = { tokens: AgoraToken[]; hypeUsd: number };
type TokenFeed = AgoraToken & { hypeUsd?: number };

async function getJson<T>(query: { list: "top" } | { token: string; range: "24h" | "7d" | "30d" }): Promise<T> {
  const url = import.meta.env.DEV
    ? "list" in query
      ? `${DIRECT}?sort=volume&window=24h&launchpad=all&q=&limit=15&offset=0`
      : `${DIRECT}/${query.token.toLowerCase()}?range=${query.range}`
    : "list" in query
      ? "/agora?list=top"
      : `/agora?token=${query.token.toLowerCase()}&range=${query.range}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Agora ${res.status}`);
  return res.json() as Promise<T>;
}

/** Agora serves pictures through its own resizer ("/api/img?src=<original>"): use the original, https only. */
function imageOf(image: string | null): string | null {
  if (!image) return null;
  try {
    const u = new URL(image, "https://www.agoradex.app");
    const src = u.pathname === "/api/img" ? u.searchParams.get("src") : u.href;
    return src && /^https:\/\//.test(src) ? src : null;
  } catch {
    return null;
  }
}

/** Launchpad names as Agora shows them. */
const VENUES: Record<string, string> = { montra: "Montra", kleos: "Kleos", ascend: "Ascend", elyspump: "ElysPump", boxa: "BOXA", obol: "Obol", volta: "Volta", rons: "RONS", stockium: "Stockium", eleos: "Eleos" };
const venueOf = (a: AgoraToken) => VENUES[a.launchpad] ?? (a.launchpad === "other" ? null : a.launchpad);

/** USD per "1e9-supply unit": price × 1e9 = market cap, whatever the token's real supply (most are 1e9 already). */
function unitPrice(a: AgoraToken, hypeUsd: number) {
  const { price, mcap } = a.stats;
  const k = price > 0 && mcap > 0 ? mcap / (price * SUPPLY) : 1;
  return { usd: price * hypeUsd * k, k };
}

export function agoraToStat(a: AgoraToken, hypeUsd: number): TokenStat {
  const { usd } = unitPrice(a, hypeUsd);
  const c24 = a.stats.change["24h"];
  const symbol = a.symbol.replace(/^\$/, "");
  return {
    address: a.address.toLowerCase(),
    handle: symbol.toLowerCase().replace(/[^a-z0-9_]/g, "") || "token",
    symbol,
    category: "other" as TokenStat["category"],
    sector: null,
    launchpad: null,
    creator: "",
    x_user_id: "",
    x_name: null,
    x_pfp_url: imageOf(a.image),
    launched_at: new Date(a.createdAt).toISOString(),
    graduated: true,
    pair: null,
    graduated_at: null,
    price_hype: usd,
    mcap_hype: usd * SUPPLY,
    price_hype_24h_ago: c24 != null && c24 > -1 ? usd / (1 + c24) : 0,
    curve_progress: 1,
    trades: a.stats.trades24h ?? 0,
    trades_24h: a.stats.trades24h ?? 0,
    volume_usd: (a.stats.volume["7d"] ?? 0) * hypeUsd,
    volume_usd_24h: (a.stats.volume["24h"] ?? 0) * hypeUsd,
    volume_hype: a.stats.volume["7d"] ?? 0,
    last_trade_at: a.stats.lastTradeAt ? new Date(a.stats.lastTradeAt * 1000).toISOString() : null,
    kind: "individual",
    name: null,
    member_x_user_ids: null,
    ours: false,
    token_name: a.name,
    quote_symbol: a.base,
    source: "agora",
    venue: venueOf(a),
  };
}

/** Agora's top 15 Elysium tokens by 24h volume (every launchpad), as Explore rows. */
export async function agoraTop(): Promise<TokenStat[]> {
  const feed = await getJson<TopFeed>({ list: "top" });
  return feed.tokens.map((a) => agoraToStat(a, feed.hypeUsd));
}

let lastHypeUsd = 0; // the single-token answer may not carry the HYPE price: reuse the list's
export async function agoraToken(address: string): Promise<TokenStat | null> {
  try {
    const a = await getJson<TokenFeed>({ token: address, range: "24h" });
    const hypeUsd = a.hypeUsd ?? (lastHypeUsd || (await getJson<TopFeed>({ list: "top" })).hypeUsd);
    lastHypeUsd = hypeUsd;
    return a?.address ? agoraToStat(a, hypeUsd) : null;
  } catch {
    return null;
  }
}

/** The chart for an Agora token: its candles (sparse: only where it traded), regrouped into our interval with the gaps
 *  filled flat, in the same "1e9-supply" USD units as the rest of Explore. */
export async function agoraCandles(address: string, interval: IntervalSeconds, limit = 300): Promise<Candle[]> {
  const range = interval <= 300 ? "24h" : interval <= 1800 ? "7d" : "30d";
  const a = await getJson<TokenFeed>({ token: address, range });
  const hypeUsd = a.hypeUsd ?? (lastHypeUsd || (await getJson<TopFeed>({ list: "top" })).hypeUsd);
  lastHypeUsd = hypeUsd;
  const { k } = unitPrice(a, hypeUsd);
  const f = hypeUsd * k;
  const byBucket = new Map<number, Candle>();
  for (const [t, o, h, l, c, v] of [...(a.candles ?? [])].sort((x, y) => x[0] - y[0])) {
    const b = Math.floor(t / interval) * interval;
    const cur = byBucket.get(b);
    if (!cur) byBucket.set(b, { bucket: new Date(b * 1000).toISOString(), open: o * f, high: h * f, low: l * f, close: c * f, volume_hype: v * hypeUsd, volume_usd: v * hypeUsd, trades: 0 });
    else {
      cur.high = Math.max(cur.high, h * f);
      cur.low = Math.min(cur.low, l * f);
      cur.close = c * f;
      cur.volume_hype += v * hypeUsd;
      cur.volume_usd = (cur.volume_usd ?? 0) + v * hypeUsd;
    }
  }
  const keys = [...byBucket.keys()].sort((x, y) => x - y);
  if (!keys.length) return [];
  // fill quiet buckets flat at the last close, up to now
  const out: Candle[] = [];
  const end = Math.floor(Date.now() / 1000 / interval) * interval;
  let prev: Candle | null = null;
  for (let b = keys[0]; b <= end; b += interval) {
    const c = byBucket.get(b);
    if (c) out.push((prev = c));
    else if (prev) out.push({ bucket: new Date(b * 1000).toISOString(), open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume_hype: 0, volume_usd: 0, trades: 0 });
  }
  return out.slice(-limit);
}

/** A token's page on Agora. */
export const agoraTokenUrl = (address: string) => `https://www.agoradex.app/token/${address.toLowerCase()}`;
