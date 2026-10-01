// Static server for the built app (app/dist) on Railway: SPA fallback so /launch, /explore, /feed load directly,
// plus security headers (no framing: stops clickjacking of wallet actions). No dependencies.
//   node app/serve.mjs    (PORT from the environment, default 8080)

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("./dist", import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);

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

createServer(async (req, res) => {
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
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    // hashed build assets never change; everything else (index.html, public files) is revalidated
    "Cache-Control": file.startsWith(join(DIST, "assets") + sep) ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}).listen(PORT, () => console.log(`serving ${DIST} on :${PORT}`));
