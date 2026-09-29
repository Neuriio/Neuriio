// After every X login, tell the backend who this is (X handle, picture, Neuriio wallet): refreshes their picture if
// it changed, makes them findable for FTF invites, and lets their trades earn points even if they never launch.
// Once per browser session per user.
import { useEffect } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { SUPABASE_URL } from "./config";

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
      const res = await fetch(`${SUPABASE_URL}/functions/v1/register`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        try {
          sessionStorage.setItem(key, "1");
        } catch {}
      }
    })().catch(() => {}); // retried on the next page load
  }, [ready, authenticated, user?.id, user?.twitter, getAccessToken]);
}
