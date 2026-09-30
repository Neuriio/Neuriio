// Explore: launched tokens (search, top lists, one token's details + chart). Reads the public Supabase view
// `token_stats` (migration 20260928000000_explore.sql) and function `token_chart`: stored, gap-free candles
// (migration 20260928010000_candles.sql). Prices are in HYPE;
// multiply by the live HYPE price for USD. `?demo` (dev only) serves generated sample data instead.
import { erc20Abi, keccak256, toBytes, zeroAddress, type Address } from "viem";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";
import { CATEGORIES, type CategoryId, LAUNCHPAD, launchpadAbi as padViews, pub, REGISTRY, registryAbi, SECTORS, type SectorId } from "./launch";

export type TokenStat = {
  address: string;
  handle: string;
  symbol: string;
  category: CategoryId;
  sector: SectorId | null; // from the creator profile (2026-09-30); null for tokens launched before sectors
  launchpad: string | null; // the Launchpad version it was launched on (its curve trades there); null = legacy row
  creator: string;
  x_user_id: string;
  x_name: string | null;
  x_pfp_url: string | null;
  launched_at: string;
  graduated: boolean;
  pair: string | null;
  graduated_at: string | null;
  price_hype: number;
  mcap_hype: number;
  price_hype_24h_ago: number;
  curve_progress: number; // 0..1 (1 once graduated)
  trades: number;
  trades_24h: number;
  volume_usd: number;
  volume_usd_24h: number;
  volume_hype: number;
  last_trade_at: string | null;
  kind: "individual" | "ftf"; // ftf: "Friends Turned Fam", 4 members sharing one token
  name: string | null; // FTF display name
  member_x_user_ids: string[] | null; // FTF: its 4 members, founder first
  fromChain?: true; // read straight from the Launchpad because the indexer hasn't stored it yet (brand-new token)
};

export type Candle = {
  bucket: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_hype: number;
  volume_usd: number | null;
  trades: number;
};

/** Lists the page can rank by (the view's columns). */
export type Ranking = "volume_usd_24h" | "volume_usd" | "launched_at" | "curve_progress" | "mcap_hype";

export const DEMO = import.meta.env.DEV && new URLSearchParams(location.search).has("demo");

const NUMERIC: (keyof TokenStat)[] = [
  "price_hype", "mcap_hype", "price_hype_24h_ago", "curve_progress", "trades", "trades_24h", "volume_usd",
  "volume_usd_24h", "volume_hype",
];

async function rest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`Explore data: ${res.status} ${await res.text()}`);
  return res.json();
}

// numeric columns arrive as strings or numbers depending on size; normalise to numbers
function toStat(r: Record<string, unknown>): TokenStat {
  const out = { ...r } as Record<string, unknown>;
  for (const k of NUMERIC) out[k] = Number(r[k] ?? 0);
  out.kind = r.kind === "ftf" ? "ftf" : "individual";
  return out as TokenStat;
}

/** For PostgREST `ilike`: "_" is a LIKE wildcard (and common in handles), so escape it; then URL-encode. */
const likeEscape = (s: string) => encodeURIComponent(s.replace(/_/g, "\\_"));

/** How a token is shown: an FTF by its name, a person by "@handle". */
export const displayName = (t: TokenStat) => (t.kind === "ftf" ? t.name ?? t.symbol : `@${t.handle}`);

/** Top `limit` tokens by a ranking (default: 24h volume), live order. */
export async function topTokens(by: Ranking = "volume_usd_24h", limit = 25): Promise<TokenStat[]> {
  if (DEMO) return [...demoTokens()].sort((a, b) => rankValue(b, by) - rankValue(a, by)).slice(0, limit);
  const rows = await rest<Record<string, unknown>[]>(`token_stats?select=*&order=${by}.desc.nullslast&limit=${limit}`);
  return rows.map(toStat);
}

/**
 * Explore's Top 25 by TOTAL volume. The order comes from a snapshot the database re-ranks every minute
 * (pg_cron, migration 20260928030000_top_tokens.sql), so it holds still between scans; the numbers stay live.
 */
export async function topByTotalVolume(): Promise<{ tokens: TokenStat[]; snapshotAt: string | null }> {
  if (DEMO) {
    const tokens = [...demoTokens()].sort((a, b) => b.volume_usd - a.volume_usd).slice(0, 25);
    return { tokens, snapshotAt: new Date(Math.floor(Date.now() / 1_800_000) * 1_800_000).toISOString() };
  }
  const rows = await rest<Record<string, unknown>[]>("top_tokens_live?select=*&order=rank.asc");
  return { tokens: rows.map(toStat), snapshotAt: rows[0] ? String(rows[0].snapshot_at) : null };
}

/** Search by handle, or by an FTF's name or ticker (case-insensitive, "@" optional), best volume first. */
export async function searchTokens(query: string, limit = 10): Promise<TokenStat[]> {
  const q = query.trim().replace(/^@/, "").replace(/[^A-Za-z0-9_ ]/g, "").trim();
  if (!q) return [];
  if (DEMO) {
    return demoTokens()
      .filter((t) => `${t.handle} ${t.name ?? ""}`.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => b.volume_usd_24h - a.volume_usd_24h)
      .slice(0, limit);
  }
  const rows = await rest<Record<string, unknown>[]>(
    `token_stats?select=*&or=(handle.ilike.*${likeEscape(q)}*,name.ilike.*${likeEscape(q)}*)&order=volume_usd_24h.desc&limit=${limit}`,
  );
  return rows.map(toStat);
}

/**
 * One token by address or handle. Supabase first; a token launched moments ago isn't indexed yet (the indexer runs
 * every minute), so then it's read straight from the Launchpad: it shows, and trades, from the block it launched in.
 */
export async function getToken(addressOrHandle: string, opts: { chainFallback?: boolean } = {}): Promise<TokenStat | null> {
  const v = addressOrHandle.trim().replace(/^@/, "");
  const byAddress = /^0x[0-9a-fA-F]{40}$/.test(v);
  if (DEMO) return demoTokens().find((t) => (byAddress ? t.address === v.toLowerCase() : t.handle.toLowerCase() === v.toLowerCase())) ?? null;
  if (!byAddress && !/^[A-Za-z0-9_]{1,15}$/.test(v)) return null;
  const filter = byAddress ? `address=eq.${v.toLowerCase()}` : `handle=ilike.${likeEscape(v)}`; // exact, any case
  const rows = await rest<Record<string, unknown>[]>(`token_stats?select=*&${filter}&limit=1`).catch(() => []);
  if (rows[0]) return toStat(rows[0]);
  return opts.chainFallback === false ? null : tokenFromChain(v, byAddress);
}

const CURVE_TOKENS = 793_100_000;

async function tokenFromChain(v: string, byAddress: boolean): Promise<TokenStat | null> {
  const address = byAddress
    ? (v as Address)
    : await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "tokenOfHandle", args: [keccak256(toBytes(v.toLowerCase()))] });
  if (!address || address === zeroAddress) return null;
  // read it from the Launchpad version that launched it
  const pad = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "launchpadOf", args: [address] });
  if (pad === zeroAddress) return null;
  const [curve, prof, isFtf] = await Promise.all([
    pub.readContract({ address: pad, abi: padViews, functionName: "curves", args: [address] }),
    pub.readContract({ address: pad, abi: padViews, functionName: "profile", args: [address] }),
    pub.readContract({ address: pad, abi: padViews, functionName: "isFtf", args: [address] }).catch(() => false),
  ]);
  const [creator, graduated, vHype, vToken, , realToken] = curve;
  if (creator === zeroAddress) return null;
  const price = Number(vHype) / Number(vToken);
  const common = {
    address: address.toLowerCase(),
    sector: null, // the indexer adds it within a minute (from the stored profile)
    launchpad: pad.toLowerCase(),
    creator: creator.toLowerCase(),
    launched_at: new Date().toISOString(),
    graduated,
    pair: null,
    graduated_at: null,
    price_hype: price,
    mcap_hype: price * 1e9,
    price_hype_24h_ago: price,
    curve_progress: graduated ? 1 : 1 - Number(realToken) / 1e18 / CURVE_TOKENS,
    trades: 0,
    trades_24h: 0,
    volume_usd: 0,
    volume_usd_24h: 0,
    volume_hype: 0,
    last_trade_at: null,
    fromChain: true as const,
  };
  if (isFtf) {
    const [f, symbol] = await Promise.all([
      pub.readContract({ address: pad, abi: padViews, functionName: "ftf", args: [address] }),
      pub.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    ]);
    return {
      ...common,
      kind: "ftf",
      name: f.name,
      handle: symbol.toLowerCase(),
      symbol,
      category: "creator",
      x_user_id: "",
      x_name: null,
      x_pfp_url: null,
      member_x_user_ids: f.memberXIds.map(String),
    };
  }
  const xUserId = prof.xUserId.toString();
  // the creator's X card was stored when their launch pass was signed, before the launch itself
  const [card] = await rest<{ x_name: string | null; x_pfp_url: string | null }[]>(
    `user_cards?select=x_name,x_pfp_url&x_user_id=eq.${xUserId}`,
  ).catch(() => []);
  return {
    ...common,
    kind: "individual",
    name: null,
    member_x_user_ids: null,
    handle: prof.handle,
    symbol: prof.handle.toUpperCase(),
    category: CATEGORIES[prof.category]?.id ?? "creator",
    x_user_id: xUserId,
    x_name: card?.x_name ?? null,
    x_pfp_url: card?.x_pfp_url ?? null,
  };
}

/** Candle sizes stored in the database (seconds). */
export const INTERVALS = [
  { label: "5m", s: 300 },
  { label: "15m", s: 900 },
  { label: "30m", s: 1800 },
  { label: "1H", s: 3600 },
  { label: "4H", s: 14400 },
] as const;
export type IntervalSeconds = (typeof INTERVALS)[number]["s"];

/** The last `limit` candles (HYPE per token) up to now, no gaps: quiet buckets are flat at the last close. */
export async function candles(address: string, interval: IntervalSeconds = 900, limit = 300): Promise<Candle[]> {
  if (DEMO) return demoCandles(address, interval, limit);
  const rows = await rest<Record<string, unknown>[]>("rpc/token_chart", {
    method: "POST",
    body: JSON.stringify({ p_token: address.toLowerCase(), p_interval: interval, p_limit: limit }),
  });
  return rows.map((r) => ({
    bucket: String(r.bucket),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume_hype: Number(r.volume_hype),
    volume_usd: r.volume_usd == null ? null : Number(r.volume_usd),
    trades: Number(r.trades),
  }));
}

export type CreatorProfile = { about: string; links: { label: string; url: string }[] };
export type MemberCard = { x_user_id: string; x_handle: string; x_name: string | null; x_pfp_url: string | null };

/** An FTF's 4 members (X handle, name, picture), in pass order (founder first). */
export async function ftfMembers(xUserIds: string[]): Promise<MemberCard[]> {
  if (DEMO) return xUserIds.map((id, i) => ({ x_user_id: id, x_handle: ["von_hl", "degenharbor", "chartwizard", "hypeanalyst"][i % 4], x_name: null, x_pfp_url: null }));
  if (!xUserIds.length) return [];
  const rows = await rest<MemberCard[]>(`user_cards?select=x_user_id,x_handle,x_name,x_pfp_url&x_user_id=in.(${xUserIds.join(",")})`);
  const by = new Map(rows.map((r) => [r.x_user_id, r]));
  return xUserIds.map((id) => by.get(id) ?? { x_user_id: id, x_handle: "unknown", x_name: null, x_pfp_url: null });
}

/** The creator's profile (about + links) as launched: stored in Supabase, its hash fixed on-chain at launch. */
export async function getProfile(address: string): Promise<CreatorProfile | null> {
  if (DEMO) return demoProfile(address);
  const [tok] = await rest<{ profile_hash: string }[]>(`tokens?select=profile_hash&address=eq.${address.toLowerCase()}`);
  // not indexed yet: the profile hash is on-chain (the profile itself was stored when the launch pass was signed)
  const hash =
    tok?.profile_hash ??
    ((await pub.readContract({ address: LAUNCHPAD, abi: padViews, functionName: "isFtf", args: [address as Address] }).catch(() => false))
      ? (await pub.readContract({ address: LAUNCHPAD, abi: padViews, functionName: "ftf", args: [address as Address] })).profileHash
      : (await pub.readContract({ address: LAUNCHPAD, abi: padViews, functionName: "profile", args: [address as Address] })).profileHash);
  if (!hash || /^0x0+$/.test(hash)) return null;
  const [row] = await rest<{ body: { about?: string; links?: { label: string; url: string }[] } }[]>(
    `creator_profiles?select=body&hash=eq.${hash}`,
  );
  return row ? { about: row.body.about ?? "", links: row.body.links ?? [] } : null;
}

export type Position = {
  token: TokenStat;
  amount: number; // tokens held (from this wallet's trades; transfers in/out aren't counted)
  costUsd: number; // cost basis of what's held (average cost)
  realizedUsd: number; // P/L already taken by selling
};

/** One curve/pool trade of a wallet, for positions. `id` = tx hash + log index (same for live and stored trades). */
export type WalletTrade = { id: string; market: string; side: "buy" | "sell"; size: number; usd: number; ts: number };

/** The wallet's stored curve/pool trades (the indexer's copy; the newest ones may still be arriving live). */
export async function walletTrades(wallet: string): Promise<WalletTrade[]> {
  const rows = await rest<{ market: string; side: "buy" | "sell"; size: string; usd_value: string | null; ts: string; tx_hash: string; log_index: number }[]>(
    `trades?select=market,side,size,usd_value,ts,tx_hash,log_index&trader=eq.${wallet.toLowerCase()}&venue=in.(curve,pool)&order=ts.asc,log_index.asc`,
  );
  return rows.map((r) => ({
    id: `${r.tx_hash.toLowerCase()}:${r.log_index}`,
    market: r.market,
    side: r.side,
    size: Number(r.size),
    usd: Number(r.usd_value ?? 0),
    ts: Date.parse(r.ts),
  }));
}

/** Average-cost positions from trades (oldest first). Transfers in/out aren't counted. */
export function aggregatePositions(trades: WalletTrade[]) {
  const acc = new Map<string, { amount: number; costUsd: number; realizedUsd: number }>();
  for (const r of [...trades].sort((a, b) => a.ts - b.ts)) {
    const a = acc.get(r.market) ?? { amount: 0, costUsd: 0, realizedUsd: 0 };
    if (r.side === "buy") {
      a.amount += r.size;
      a.costUsd += r.usd;
    } else if (a.amount > 0) {
      const sold = Math.min(r.size, a.amount);
      const costOut = (a.costUsd * sold) / a.amount;
      a.realizedUsd += r.usd - costOut;
      a.costUsd -= costOut;
      a.amount -= sold;
    }
    acc.set(r.market, a);
  }
  return new Map([...acc].filter(([, a]) => a.amount > 1e-6));
}

/** Stats for several tokens (Supabase, or from the chain for ones not indexed yet). */
export async function tokensByAddress(addresses: string[]): Promise<Map<string, TokenStat>> {
  if (!addresses.length) return new Map();
  const rows = await rest<Record<string, unknown>[]>(`token_stats?select=*&address=in.(${addresses.join(",")})`).catch(() => []);
  const out = new Map(rows.map((r) => [String(r.address), toStat(r)]));
  await Promise.all(
    addresses.filter((a) => !out.has(a)).map(async (a) => {
      const t = await getToken(a).catch(() => null);
      if (t) out.set(a, t);
    }),
  );
  return out;
}

// ------------------------------------------------------------------ launched tokens a wallet holds (balances, Send)

let allCache: { at: number; list: Promise<TokenStat[]> } | null = null;
/** Every launched token (cached 60 s; prices in it are for valuing balances, not trading). */
function allTokens(): Promise<TokenStat[]> {
  if (allCache && Date.now() - allCache.at < 60_000) return allCache.list;
  const list = rest<Record<string, unknown>[]>("token_stats?select=*&limit=1000").then((rows) => rows.map(toStat));
  allCache = { at: Date.now(), list };
  list.catch(() => (allCache = null));
  return list;
}

/** Launched tokens this wallet holds right now, read on-chain (one multicall): bought, launched or received. */
export async function launchedHoldings(wallet: Address): Promise<{ token: TokenStat; balance: bigint }[]> {
  const list = await allTokens();
  if (!list.length) return [];
  const res = await pub.multicall({
    contracts: list.map((t) => ({ address: t.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }) as const),
    allowFailure: true,
  });
  return list
    .map((token, i) => ({ token, balance: res[i].status === "success" ? (res[i].result as bigint) : 0n }))
    .filter((h) => h.balance > 0n);
}

/** ?demo only: three example positions. */
export async function positions(): Promise<Position[]> {
  return demoPositions();
}

/** 24h change in percent (null when there's no earlier price). */
export const change24h = (t: TokenStat) =>
  t.price_hype_24h_ago > 0 ? (t.price_hype / t.price_hype_24h_ago - 1) * 100 : null;

function rankValue(t: TokenStat, by: Ranking) {
  return by === "launched_at" ? Date.parse(t.launched_at) : t[by];
}

// ------------------------------------------------------------------ demo data (dev only)

const DEMO_HANDLES = [
  "von_hl", "degenharbor", "chartwizard", "hypeanalyst", "onchainolivia", "perpsmaxi", "mememonk", "builderbee",
  "alphaseeker", "cryptocleo", "the_liquidator", "gmgrace", "basisbro", "fundingfarmer", "orderbookoz",
  "vaultvera", "slippagesam", "kntqkid", "elysiumeli", "bondingbeth", "tickertom", "curvecarl", "wagmiwes",
  "researchrae", "pixelpia", "shipitsid", "threadqueen", "lowcaplou",
];
const DEMO_CATS: CategoryId[] = ["trader", "meme_trader", "researcher", "influencer", "builder", "creator"];
const OPEN_PRICE = 60 / 1_073_000_000; // mainnet virtualHype 60 HYPE

// small deterministic PRNG so demo data is stable between reloads
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const hash = (str: string) => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

let demoCache: TokenStat[] | null = null;
function demoTokens(): TokenStat[] {
  if (demoCache) return demoCache;
  const now = Date.now();
  demoCache = DEMO_HANDLES.map((handle, i) => {
    const r = rng(hash(handle));
    const graduated = r() < 0.25;
    const progress = graduated ? 1 : Math.min(0.97, r() ** 1.6);
    // curve price after selling progress * 793.1M: virtualHype * 1.073B / (1.073B - sold)^2 (per token)
    const sold = progress * 793_100_000;
    const vt = 1_073_000_000 - sold;
    const curvePrice = (60 * 1_073_000_000) / vt / vt;
    const price = graduated ? curvePrice * (0.6 + r() * 2.5) : curvePrice;
    const vol24 = Math.round(500 + r() ** 2 * (graduated ? 180_000 : 40_000));
    const address = `0x${hash(handle + "a").toString(16).padStart(8, "0")}${"0".repeat(24)}${i.toString(16).padStart(8, "0")}`;
    return {
      address,
      handle,
      symbol: handle.toUpperCase(),
      category: DEMO_CATS[i % DEMO_CATS.length],
      sector: SECTORS[i % SECTORS.length].id,
      launchpad: LAUNCHPAD.toLowerCase(),
      creator: address,
      x_user_id: String(1_000 + i),
      x_name: handle.replace(/_/g, " "),
      x_pfp_url: null,
      launched_at: new Date(now - (2 + r() * 240) * 3600_000).toISOString(),
      graduated,
      pair: graduated ? address : null,
      graduated_at: graduated ? new Date(now - r() * 48 * 3600_000).toISOString() : null,
      price_hype: price,
      mcap_hype: price * 1e9,
      price_hype_24h_ago: price / (0.7 + r() * 0.9),
      curve_progress: progress,
      trades: Math.round(vol24 / 40 + r() * 400),
      trades_24h: Math.round(vol24 / 60),
      volume_usd: Math.round(vol24 * (1.5 + r() * 4)),
      volume_usd_24h: vol24,
      volume_hype: Math.round((vol24 * 3) / 90),
      last_trade_at: new Date(now - r() * 600_000).toISOString(),
      kind: "individual" as const,
      name: null,
      member_x_user_ids: null,
    };
  });
  // one demo FTF: "Degen Den" ($DEN)
  const den = demoCache[5];
  Object.assign(den, { kind: "ftf", name: "Degen Den", handle: "den", symbol: "DEN", x_name: null, x_pfp_url: null, member_x_user_ids: ["1001", "1002", "1003", "1004"] });
  return demoCache;
}

function demoCandles(address: string, interval: number, limit: number): Candle[] {
  const t = demoTokens().find((x) => x.address === address.toLowerCase());
  if (!t) return [];
  const r = rng(hash(address) + interval);
  const step = interval * 1000;
  const end = Math.floor(Date.now() / step) * step;
  const n = Math.max(2, Math.min(limit, Math.floor((end - Date.parse(t.launched_at)) / step) + 1));
  const start = end - (n - 1) * step;
  // random walk from the opening price that ends exactly at the current price
  const walk = [Math.log(OPEN_PRICE)];
  for (let i = 1; i <= n; i++) walk.push(walk[i - 1] + (r() - 0.46) * 0.08);
  const drift = (Math.log(t.price_hype) - walk[n]) / n;
  const px = walk.map((w, i) => Math.exp(w + drift * i));
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const open = px[i];
    const close = px[i + 1];
    const wick = 1 + r() * 0.03;
    const volHype = r() * 3;
    out.push({
      bucket: new Date(start + i * step).toISOString(),
      open,
      close,
      high: Math.max(open, close) * wick,
      low: Math.min(open, close) / wick,
      volume_hype: volHype,
      volume_usd: volHype * 90,
      trades: 1 + Math.floor(r() * 12),
    });
  }
  return out;
}

function demoProfile(address: string): CreatorProfile | null {
  const t = demoTokens().find((x) => x.address === address.toLowerCase());
  if (!t) return null;
  return {
    about:
      `Full-time ${t.category.replace("_", " ")} posting daily breakdowns, calls and the occasional L. ` +
      "Building in public on Hyperliquid and Elysium. Everything I share is for fun and learning, not advice.",
    links: [
      { label: "YouTube", url: `https://youtube.com/@${t.handle}` },
      { label: "Newsletter", url: `https://${t.handle}.substack.com` },
      { label: "Portfolio", url: `https://${t.handle}.xyz` },
    ],
  };
}

// three example positions: one up, one down, one roughly flat
function demoPositions(): Position[] {
  const pick = ["kntqkid", "chartwizard", "the_liquidator"];
  const shape = [
    { amount: 2_500_000, entryMult: 0.62 },
    { amount: 910_000, entryMult: 1.35 },
    { amount: 4_200_000, entryMult: 0.97 },
  ];
  const hypeUsd = 90;
  return pick.map((h, i) => {
    const token = demoTokens().find((t) => t.handle === h)!;
    const entry = token.price_hype * shape[i].entryMult * hypeUsd;
    return { token, amount: shape[i].amount, costUsd: entry * shape[i].amount, realizedUsd: i === 0 ? 48.2 : 0 };
  });
}
