// POST /rpc (vercel.json rewrites it here): the browser's chain requests, forwarded to our RPC provider (api/_lib/rpcProxy.ts).
import { envFrom, makeRpcHandler } from "./_lib/rpcProxy";

declare const process: { env: Record<string, string | undefined> }; // Vercel Edge provides it; no @types/node here

export const config = { runtime: "edge" };

let handle: ((req: Request) => Promise<Response>) | null = null;
export default function rpc(req: Request): Promise<Response> {
  handle ??= makeRpcHandler(envFrom((k) => process.env[k]));
  return handle(req);
}
