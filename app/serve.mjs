// Static server for the built app (app/dist) on Railway: SPA fallback so /launch, /explore, /feed load directly,
// plus security headers (no framing: stops clickjacking of wallet actions). No dependencies.
// Optional passcode gate (private beta): with APP_PASSCODE set, the app's pages (/explore, /launch, ...) sit behind a
// passcode page; the landing page "/" and the built files it loads stay open. A correct code sets a 30-day HttpOnly cookie derived from the passcode, so changing
// APP_PASSCODE signs everyone out. Wrong codes are rate limited per visitor and overall.
//   node app/serve.mjs    (PORT from the environment, default 8080; APP_PASSCODE optional)

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("./dist", import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const PASSCODE = process.env.APP_PASSCODE ?? "";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

const SECURITY = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

/** The file under DIST for a URL path, or null if it would escape DIST. */
function resolve(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null;
  }
  const file = normalize(join(DIST, p));
  return file === DIST || file.startsWith(DIST + sep) ? file : null;
}

async function fileAt(path) {
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ passcode gate

const COOKIE = "neuriio_gate";
const COOKIE_DAYS = 30;
const GATE_PATH = "/__gate";
/** Open without the passcode: the landing page "/" and every file (the landing loads the same bundle). App routes
 *  (paths without an extension) and index.html by any spelling (it would boot straight into Explore) need the passcode. */
const isOpen = (path) =>
  path === "/" || path === SHOWCASE || (extname(path) !== "" && resolve(path) !== join(DIST, "index.html"));
/** The landing's Explore card alone (fake showcase data), framed into the landing on phones: the one page our own
 *  pages may frame. */
const SHOWCASE = "/showcase";
const FRAMEABLE = { "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'" };
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS_PER_VISITOR = 10;
const MAX_FAILS_TOTAL = 200; // backstop if someone rotates addresses

/** The cookie value: an HMAC of the passcode, so it can't be forged and dies when the passcode changes. */
const token = () => createHmac("sha256", PASSCODE).update("neuriio-gate-v1").digest("hex");

function sameSecret(a, b) {
  const x = createHmac("sha256", "cmp").update(a).digest();
  const y = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(x, y);
}

function hasPass(req) {
  const cookies = Object.fromEntries(
    (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((kv) => kv.length === 2),
  );
  return typeof cookies[COOKIE] === "string" && sameSecret(cookies[COOKIE], token());
}

const fails = new Map(); // visitor -> timestamps of wrong codes
let failsTotal = [];

function visitor(req) {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return String(req.headers["x-real-ip"] ?? fwd.at(-1) ?? req.socket.remoteAddress ?? "?");
}

function limited(who) {
  const now = Date.now();
  failsTotal = failsTotal.filter((t) => now - t < WINDOW_MS);
  const mine = (fails.get(who) ?? []).filter((t) => now - t < WINDOW_MS);
  fails.set(who, mine);
  return mine.length >= MAX_FAILS_PER_VISITOR || failsTotal.length >= MAX_FAILS_TOTAL;
}

function recordFail(who) {
  const now = Date.now();
  fails.set(who, [...(fails.get(who) ?? []), now]);
  failsTotal.push(now);
  if (fails.size > 10_000) fails.clear(); // memory bound
}

/** Only same-site paths ("/launch"), never "//host" or "/\\host". */
const safeNext = (n) => (typeof n === "string" && /^\/(?![\/\\])/.test(n) ? n : "/");

const escapeHtml = (t) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function gatePage(next, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Neuriio</title><meta name="robots" content="noindex">
<style>
*{box-sizing:border-box}html,body{height:100%;overflow:hidden}
body{margin:0;height:100vh;height:100dvh;display:grid;place-items:center;padding:16px;background:#120c1d;
background-image:radial-gradient(rgba(129,114,152,.35) 1px,transparent 1px);background-size:20px 20px;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#ecddff}
form{width:min(340px,100%);display:flex;flex-direction:column;gap:14px;padding:28px 24px;background:rgba(27,20,40,.92);
border:1px solid rgba(236,221,255,.14);border-radius:12px;text-align:center}
img{width:44px;height:44px;margin:0 auto}h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.02em}
p{margin:0;font-size:12px;color:#a99bc2}input{height:42px;padding:0 12px;font:inherit;font-size:16px;color:#fff;
background:rgba(10,6,18,.55);border:1px solid rgba(236,221,255,.18);border-radius:8px;outline:none;text-align:center}
input:focus{border-color:rgba(204,236,236,.6)}button{height:40px;font:inherit;font-size:13px;font-weight:600;color:#120c1d;
background:#d8fffe;border:0;border-radius:8px;cursor:pointer}.err{color:#ff9b9b}a{color:#d8fffe}
</style></head><body><form method="post" action="${GATE_PATH}">
<img src="/brand/logo.png" alt=""><h1>Private Beta</h1>
<p>Enter the passcode to continue.</p>
${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}
<input name="code" type="password" autocomplete="current-password" aria-label="Passcode" autofocus required maxlength="128">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit">Enter</button>
<p>Not in the Beta? Read the <a href="https://docs.neuriio.xyz">docs</a>.</p>
</form></body></html>`;
}

function sendGate(res, next, message, status = 401) {
  res.writeHead(status, { ...SECURITY, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(gatePage(next, message));
}

async function readForm(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2048) return null;
  }
  return new URLSearchParams(body);
}

async function handleGate(req, res) {
  const form = await readForm(req);
  const next = safeNext(form?.get("next"));
  const who = visitor(req);
  if (limited(who)) return sendGate(res, next, "Too many tries. Wait 15 minutes and try again.", 429);
  if (!form || !sameSecret(form.get("code") ?? "", PASSCODE)) {
    recordFail(who);
    return sendGate(res, next, "Wrong passcode.");
  }
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.writeHead(303, {
    ...SECURITY,
    "Set-Cookie": `${COOKIE}=${token()}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; SameSite=Lax${secure}`,
    Location: next,
    "Cache-Control": "no-store",
  });
  res.end();
}

// ------------------------------------------------------------------ server

createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (PASSCODE) {
    if (path === GATE_PATH && req.method === "POST") return handleGate(req, res);
    if (!isOpen(path) && !hasPass(req)) {
      if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405, { ...SECURITY, Allow: "GET, HEAD" }).end();
      return sendGate(res, safeNext(req.url));
    }
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { ...SECURITY, Allow: "GET, HEAD" }).end();
    return;
  }
  const target = resolve(req.url ?? "/");
  let file = target && (await fileAt(target));
  // unknown paths without an extension are app routes: serve index.html; missing assets are real 404s
  if (!file && target && !extname(target)) file = join(DIST, "index.html");
  if (!file) {
    res.writeHead(404, { ...SECURITY, "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, {
    ...SECURITY,
    ...(path === SHOWCASE ? FRAMEABLE : {}),
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    // hashed build assets never change; everything else (index.html, public files) is revalidated
    "Cache-Control": file.startsWith(join(DIST, "assets") + sep) ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}).listen(PORT, () => console.log(`serving ${DIST} on :${PORT}`));
