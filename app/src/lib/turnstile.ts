// Cloudflare Turnstile in the browser: loads Cloudflare's script once and gets a token for a site key. Used by our RPC
// session (lib/rpcSession.ts, our own key) and by token art (lib/tokenArt.ts, Ascend's key, allowed on app.neuriio.xyz only).

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
export async function turnstileToken(siteKey: string, slotId = "turnstile-slot"): Promise<string> {
  const t = await loadTurnstile();
  let slot = document.getElementById(slotId);
  if (!slot) {
    slot = document.createElement("div");
    slot.id = slotId;
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
      sitekey: siteKey,
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
