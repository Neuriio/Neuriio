// The browser side of our RPC proxy (app/api/_lib/rpcProxy.ts): in production every chain request goes to our own /rpc, which
// holds the provider's key. Reads need a session cookie; when /rpc answers 401, this runs an invisible Cloudflare Turnstile
// check, asks /rpc/session for the cookie, and retries once. One renewal at a time, whatever is waiting on it.

const SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "").trim();

// Cloudflare's own Turnstile types are already on `window` (a dependency brings them)
type Turnstile = NonNullable<Window["turnstile"]>;

let script: Promise<Turnstile> | null = null;
function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  script ??= new Promise<Turnstile>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile didn't load")));
    s.onerror = () => {
      script = null;
      reject(new Error("Turnstile didn't load"));
    };
    document.head.appendChild(s);
  });
  return script;
}

/** An invisible Turnstile token (it only shows a box if Cloudflare wants an interaction). */
async function turnstileToken(): Promise<string> {
  const t = await loadTurnstile();
  let slot = document.getElementById("rpc-session-slot");
  if (!slot) {
    slot = document.createElement("div");
    slot.id = "rpc-session-slot";
    slot.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647";
    document.body.appendChild(slot);
  }
  const host = slot;
  return new Promise<string>((resolve, reject) => {
    host.replaceChildren();
    let id: string | null | undefined = "";
    const done = (f: () => void) => {
      f();
      if (id) t.remove(id);
    };
    id = t.render(host, {
      sitekey: SITE_KEY,
      appearance: "interaction-only",
      execution: "execute",
      callback: (token: string) => done(() => resolve(token)),
      "error-callback": () => done(() => reject(new Error("The security check failed. Reload the page and try again."))),
      "timeout-callback": () => done(() => reject(new Error("The security check timed out. Try again."))),
    });
    if (!id) return reject(new Error("The security check didn't start. Reload the page and try again."));
    t.execute(id);
  });
}

let renewing: Promise<void> | null = null;
/** Gets a session cookie from /rpc/session (one request at a time; everyone waiting shares it). */
export function renewSession(origin = location.origin): Promise<void> {
  renewing ??= (async () => {
    const token = SITE_KEY ? await turnstileToken() : "";
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
