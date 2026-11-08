// The browser side of our RPC proxy (app/api/_lib/rpcProxy.ts): in production every chain request goes to our own /rpc, which
// holds the provider's key. Reads need a session cookie; when /rpc answers 401, this runs an invisible Cloudflare Turnstile
// check, asks /rpc/session for the cookie, and retries once. One renewal at a time, whatever is waiting on it.

import { turnstileToken } from "./turnstile";

const SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "").trim();

let renewing: Promise<void> | null = null;
/** Gets a session cookie from /rpc/session (one request at a time; everyone waiting shares it). */
export function renewSession(origin = location.origin): Promise<void> {
  renewing ??= (async () => {
    const token = SITE_KEY ? await turnstileToken(SITE_KEY, "rpc-session-slot") : "";
    const res = await fetch(`${origin}/rpc/session`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstile: token }),
    });
    await res.body?.cancel().catch(() => {});
    if (!res.ok) throw new Error(`The network session was refused (${res.status}). Reload the page and try again.`);
  })().finally(() => {
    renewing = null;
  });
  return renewing;
}

/** viem's `fetchFn` for our /rpc: on 401 it renews the session and tries once more. */
export const proxyFetch: typeof fetch = async (input, init) => {
  const send = () => fetch(input, { ...init, credentials: "same-origin" });
  const res = await send();
  if (res.status !== 401) return res;
  await res.body?.cancel().catch(() => {});
  await renewSession();
  return send();
};
