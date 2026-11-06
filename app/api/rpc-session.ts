// POST /rpc/session (vercel.json rewrites it here): a Turnstile token in, a 6-hour signed session cookie out (api/_lib/rpcProxy.ts).
import { envFrom, makeSessionHandler } from "./_lib/rpcProxy.ts";

export const config = { runtime: "edge" };

let handle: ((req: Request) => Promise<Response>) | null = null;
export default function rpcSession(req: Request): Promise<Response> {
  handle ??= makeSessionHandler(envFrom((k) => process.env[k]));
  return handle(req);
}
