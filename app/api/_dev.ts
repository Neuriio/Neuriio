// Local stand-in for Vercel's /rpc and /rpc/session (the same handlers as api/rpc.ts and api/rpc-session.ts), for testing the
// proxy with the dev app: run this, then `VITE_RPC_PROXY=on npm run dev` (vite.config.js forwards /rpc here).
//   ELYSIUM_RPC_UPSTREAM=<provider url> RPC_SESSION_SECRET=<anything> TURNSTILE_SECRET=<secret> node app/api/_dev.ts
// Cloudflare's test keys work for a local run: site key 1x00000000000000000000AA (VITE_TURNSTILE_SITE_KEY) with secret
// 1x0000000000000000000000000000000AA always pass. Not deployed (files starting with "_" aren't endpoints).
import { createServer } from "node:http";
import { envFrom, makeRpcHandler, makeSessionHandler } from "./_lib/rpcProxy.ts";

const env = envFrom((k) => process.env[k]);
// the dev app's origin, and the dev server's own (Vite forwards with its origin intact)
for (let port = 5173; port <= 5179; port++) env.allowedOrigins.push(`http://127.0.0.1:${port}`, `http://localhost:${port}`);
const rpc = makeRpcHandler(env);
const session = makeSessionHandler(env);
const PORT = Number(process.env.PORT ?? 8787);

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  // Secure cookies don't stick on plain http: keep the flag off locally only
  const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, { method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined });
  const out = await (req.url?.startsWith("/rpc/session") ? session : rpc)(request);
  const h: Record<string, string> = {};
  out.headers.forEach((v, k) => (h[k] = k === "set-cookie" ? v.replace("; Secure", "") : v));
  res.writeHead(out.status, h);
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(PORT, "127.0.0.1", () => console.log(`rpc proxy (dev) on http://127.0.0.1:${PORT} -> upstream set, turnstile ${env.turnstileSecret ? "on" : env.openSessions ? "OPEN" : "off"}`));
