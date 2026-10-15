// After every X login, tell the backend who this is (X handle, picture, Neuriio wallet): refreshes their picture if
// it changed, makes them findable for FTF invites, and lets their trades earn points even if they never launch.
// Once per browser session per user. Also sends the passcode they came in with (the passcode page's `neuriio_code`
// cookie), so we can count users per code.
import { useEffect } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { SUPABASE_URL } from "./config";

/** The passcode this browser came in with, if any (set by app/serve.mjs's passcode page). */
function accessCode(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)neuriio_code=([^;]*)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

export function useRegisterOnLogin() {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  useEffect(() => {
    if (!ready || !authenticated || !user?.twitter) return;
    const key = `neuriio-registered-${user.id}`;
    try {
      if (sessionStorage.getItem(key)) return;
    } catch {}
    (async () => {
      const token = await getAccessToken();
      if (!token) return;
      const res = await fetch(`${SUPABASE_URL}/functions/v1/register`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ accessCode: accessCode() }),
      });
      if (res.ok) {
        try {
          sessionStorage.setItem(key, "1");
        } catch {}
      }
    })().catch(() => {}); // retried on the next page load
  }, [ready, authenticated, user?.id, user?.twitter, getAccessToken]);
}
