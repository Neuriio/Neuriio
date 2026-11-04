// Referral codes (user, 2026-11-03): a partner protocol gets a code; traders it brings in are tied to it, and the partner is paid weekly by
// hand from the KNTQ + treasury shares on their volume. A trader arrives through `?ref=CODE` (kept in this browser until they log in) or
// types the code in Account. Each account takes one code, the first, for good. Their Neuriio wallet counts automatically; an outside
// wallet counts once its owner signs a message proving it's theirs (free, no gas, moves nothing). Stored and checked by the `referral`
// edge function (supabase/functions/referral), which re-checks every signature.
import { useCallback, useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { getAddress } from "viem";
import { SUPABASE_URL } from "./config";

const PENDING_KEY = "neuriio:ref-pending";

export const normalizeCode = (s: string) => s.trim().toUpperCase();
export const isCode = (s: string) => /^[A-Z0-9_]{3,20}$/.test(s);

// a partner's link: remember its code until the visitor logs in
{
  const ref = normalizeCode(new URLSearchParams(location.search).get("ref") ?? "");
  if (isCode(ref)) {
    try {
      localStorage.setItem(PENDING_KEY, ref);
    } catch {
      /* private window / blocked storage: they can still type it */
    }
  }
}

/** The code from a partner's link, if the visitor came through one. */
export const pendingCode = () => {
  try {
    return localStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
};

/** What an outside wallet signs. Must match supabase/functions/_shared/referral.ts word for word (a test checks). */
export const verifyMessage = (code: string, account: string, wallet: string) =>
  `Neuriio referral\n\nI own ${wallet} and want its trades counted for referral code ${code} on the Neuriio account ${account}.\n\nThis signature is free and moves no funds.`;

export type RefStatus = { code: string | null; wallets: { address: string; kind: "neuriio" | "signed" }[] };

export type Referral = {
  /** null until the first load */
  status: RefStatus | null;
  /** resolves to an error message, or null on success */
  apply: (code: string) => Promise<string | null>;
  /** asks `sign` to sign the Verify message for `wallet`, then has the server check it; throws on failure */
  verify: (wallet: string, sign: (message: string) => Promise<string>) => Promise<void>;
};

export function useReferral(account: string): Referral {
  const { getAccessToken } = usePrivy();
  const [status, setStatus] = useState<RefStatus | null>(null);
  const call = useCallback(
    async (action: string, body: Record<string, unknown> = {}): Promise<RefStatus> => {
      const token = await getAccessToken();
      if (!token) throw new Error("Log in first");
      const res = await fetch(`${SUPABASE_URL}/functions/v1/referral`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
      return json as RefStatus;
    },
    [getAccessToken],
  );
  useEffect(() => {
    let alive = true;
    call("status").then(
      (s) => alive && setStatus(s),
      () => alive && setStatus({ code: null, wallets: [] }),
    );
    return () => {
      alive = false;
    };
  }, [call, account]);
  const apply = useCallback(
    async (raw: string) => {
      const code = normalizeCode(raw);
      if (!isCode(code)) return "Codes are 3 to 20 letters, numbers or _";
      try {
        setStatus(await call("apply", { code }));
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    },
    [call],
  );
  const verify = useCallback(
    async (wallet: string, sign: (message: string) => Promise<string>) => {
      if (!status?.code) throw new Error("Apply a code first");
      const signature = await sign(verifyMessage(status.code, getAddress(account), getAddress(wallet)));
      setStatus(await call("verify", { wallet, signature }));
    },
    [call, status?.code, account],
  );
  return { status, apply, verify };
}
