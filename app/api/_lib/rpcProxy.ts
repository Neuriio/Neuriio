// Our RPC proxy (user, 2026-11-04, modelled on Ascend's): the browser never sees the RPC provider's key. The app sends every chain
// request to app.neuriio.xyz/rpc; this forwards it to the provider (ELYSIUM_RPC_UPSTREAM, a server-only variable) and answers.
// It only takes what the app needs, from our own pages, and reads need a session: a short-lived signed cookie handed out by
// /rpc/session after an invisible Cloudflare Turnstile check, so bots can't spend our quota. A few calls Privy's wallet needs to
// send a transaction work without the cookie (its iframe sends them from Privy's own origin), under a tighter limit.
// Pure Web APIs (fetch, Request, Response, crypto.subtle): runs on Vercel's Edge runtime and in Node for the tests. Files in api/
// starting with "_" aren't endpoints.

export type ProxyEnv = {
  upstream: string; // the provider URL with its key
  sessionSecret: string; // signs the session cookie
  allowedOrigins: string[]; // our pages, e.g. https://app.neuriio.xyz
  sendOrigins: string[]; // may use the send lane without a session (Privy's iframe: https://auth.privy.io)
  turnstileSecret?: string; // Cloudflare Turnstile; unset only with openSessions for testing
  openSessions?: boolean; // hand out sessions without Turnstile (testing only, never in production)
};

/** Reads (and the send lane) the app makes; anything else is refused (debug, trace, admin, subscriptions, huge reads). */
export const READ_METHODS = new Set([
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getLogs",
  "eth_getBlockByHash",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_createAccessList",
]);
/** What a wallet needs to send a transaction and wait for it: no session needed (Privy's iframe has no cookie of ours). */
export const SEND_METHODS = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_sendRawTransaction",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBlockByNumber",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
]);

export const MAX_BATCH = 25;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_LOG_BLOCKS = 10_000n;
export const SESSION_SECONDS = 6 * 3600;
export const COOKIE = "rpc_s";

type RpcCall = { jsonrpc: "2.0"; id?: unknown; method: string; params?: unknown[] };
export type Checked = { ok: true; calls: RpcCall[]; batch: boolean; sendOnly: boolean } | { ok: false; status: number; error: string };

const hexBlock = (v: unknown): bigint | null => (typeof v === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(v) ? BigInt(v) : null);

/** Checks a JSON-RPC body: shape, size, methods, and that eth_getLogs names an address and spans at most MAX_LOG_BLOCKS. */
export function checkBody(raw: string): Checked {
  if (raw.length > MAX_BODY_BYTES) return { ok: false, status: 413, error: "request too large" };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "not JSON" };
  }
  const batch = Array.isArray(body);
  const calls = (batch ? body : [body]) as RpcCall[];
  if (!calls.length || calls.length > MAX_BATCH) return { ok: false, status: 400, error: `batches hold 1 to ${MAX_BATCH} calls` };
  let sendOnly = true;
  for (const c of calls) {
    if (!c || typeof c !== "object" || c.jsonrpc !== "2.0" || typeof c.method !== "string") return { ok: false, status: 400, error: "not JSON-RPC 2.0" };
    if (c.params !== undefined && !Array.isArray(c.params)) return { ok: false, status: 400, error: "params must be an array" };
    if (SEND_METHODS.has(c.method)) continue;
    if (!READ_METHODS.has(c.method)) return { ok: false, status: 403, error: `method not allowed: ${c.method}` };
    sendOnly = false;
    if (c.method === "eth_getLogs") {
      const f = (c.params?.[0] ?? {}) as { address?: unknown; fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown };
      const hasAddress = typeof f.address === "string" || (Array.isArray(f.address) && f.address.length > 0 && f.address.length <= 100);
      if (!hasAddress) return { ok: false, status: 403, error: "eth_getLogs needs an address" };
      if (f.blockHash === undefined) {
        const from = hexBlock(f.fromBlock);
        const to = hexBlock(f.toBlock);
        if (from === null || to === null || to < from || to - from > MAX_LOG_BLOCKS) {
          return { ok: false, status: 403, error: `eth_getLogs needs numeric fromBlock/toBlock at most ${MAX_LOG_BLOCKS} blocks apart` };
        }
      }
    }
  }
  return { ok: true, calls, batch, sendOnly };
}

// ------------------------------------------------------------------ the session cookie

const enc = new TextEncoder();
async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Compares without stopping at the first difference. */
function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function makeSessionCookie(secret: string, nowS: number): Promise<string> {
  const exp = nowS + SESSION_SECONDS;
  return `${exp}.${await hmac(secret, `rpc-session-v1:${exp}`)}`;
}

export async function sessionValid(cookieHeader: string | null, secret: string, nowS: number): Promise<boolean> {
  const value = cookieHeader?.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const [expS, mac] = value?.split(".") ?? [];
  const exp = Number(expS);
  if (!mac || !Number.isInteger(exp) || exp <= nowS || exp > nowS + SESSION_SECONDS) return false;
  return sameString(mac, await hmac(secret, `rpc-session-v1:${exp}`));
}

// ------------------------------------------------------------------ rate limits (best effort: per server instance)

type Bucket = { start: number; n: number };
export function makeLimiter(perMinute: number) {
  const buckets = new Map<string, Bucket>();
  return (key: string, cost: number, nowMs: number) => {
    const b = buckets.get(key);
    if (!b || nowMs - b.start >= 60_000) {
      if (buckets.size > 50_000) buckets.clear();
      buckets.set(key, { start: nowMs, n: cost });
      return cost <= perMinute;
    }
    b.n += cost;
    return b.n <= perMinute;
  };
}

// ------------------------------------------------------------------ the handlers

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const rpcError = (id: unknown, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message } });
const clientIp = (req: Request) => req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

export function makeRpcHandler(env: ProxyEnv, upstream: typeof fetch = fetch, now = () => Date.now()) {
  const reads = makeLimiter(600); // calls a minute per visitor, with a session
  const sends = makeLimiter(120); // without one (the send lane)
  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { error: "POST only" });
    const origin = req.headers.get("origin");
    const ours = !origin || env.allowedOrigins.includes(origin);
    const sender = !!origin && env.sendOrigins.includes(origin);
    if (!ours && !sender) return json(403, { error: "origin not allowed" });
    const checked = checkBody(await req.text());
    if (!checked.ok) return json(checked.status, { error: checked.error });
    const withSession = ours && (await sessionValid(req.headers.get("cookie"), env.sessionSecret, Math.floor(now() / 1000)));
    if (!withSession && !checked.sendOnly) return json(401, { error: "session needed" }); // the app renews and retries
    const limit = withSession ? reads : sends;
    if (!limit(clientIp(req), checked.calls.length, now())) {
      const errs = checked.calls.map((c) => rpcError(c.id, "rate limited"));
      return json(429, checked.batch ? errs : errs[0], { "retry-after": "10" });
    }
    const res = await upstream(env.upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(checked.batch ? checked.calls : checked.calls[0]),
    }).catch(() => null);
    if (!res) return json(502, { error: "RPC unreachable" });
    // the provider's own error text can carry its URL (and key): never pass a non-JSON body through
    const text = await res.text();
    try {
      JSON.parse(text);
    } catch {
      return json(502, { error: `RPC answered ${res.status}` });
    }
    const cors: Record<string, string> = origin ? { "access-control-allow-origin": origin, vary: "origin" } : {};
    return new Response(text, { status: res.ok ? 200 : res.status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });
  };
}

/** Cloudflare's check of a Turnstile token. */
export async function verifyTurnstile(secret: string, token: string, ip: string | null, post: typeof fetch = fetch): Promise<boolean> {
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  const res = await post("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form }).catch(() => null);
  const out = res?.ok ? ((await res.json().catch(() => null)) as { success?: boolean } | null) : null;
  return out?.success === true;
}

export function makeSessionHandler(env: ProxyEnv, verify = verifyTurnstile, now = () => Date.now()) {
  const tries = makeLimiter(20);
  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { error: "POST only" });
    const origin = req.headers.get("origin");
    if (origin && !env.allowedOrigins.includes(origin)) return json(403, { error: "origin not allowed" });
    if (!tries(clientIp(req), 1, now())) return json(429, { error: "too many tries" });
    const body = (await req.json().catch(() => ({}))) as { turnstile?: unknown };
    if (!env.openSessions) {
      if (!env.turnstileSecret) return json(503, { error: "sessions aren't set up" });
      const token = typeof body.turnstile === "string" ? body.turnstile : "";
      if (!token || token.length > 4096 || !(await verify(env.turnstileSecret, token, clientIp(req)))) return json(403, { error: "check failed" });
    }
    const cookie = await makeSessionCookie(env.sessionSecret, Math.floor(now() / 1000));
    return json(200, { ok: true, expiresIn: SESSION_SECONDS }, {
      "set-cookie": `${COOKIE}=${cookie}; Path=/rpc; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
    });
  };
}

/** The proxy's settings from server-only environment variables (never VITE_: those ship in the page). */
export function envFrom(get: (k: string) => string | undefined): ProxyEnv {
  const need = (k: string) => {
    const v = get(k);
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  const list = (k: string, d: string) => (get(k) ?? d).split(",").map((s) => s.trim()).filter(Boolean);
  return {
    upstream: need("ELYSIUM_RPC_UPSTREAM"),
    sessionSecret: need("RPC_SESSION_SECRET"),
    allowedOrigins: list("RPC_ALLOWED_ORIGINS", "https://app.neuriio.xyz"),
    sendOrigins: list("RPC_SEND_ORIGINS", "https://auth.privy.io"),
    turnstileSecret: get("TURNSTILE_SECRET") || undefined,
    openSessions: get("RPC_SESSION_OPEN") === "1",
  };
}
