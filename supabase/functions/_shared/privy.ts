// Privy login -> the user's X account + Neuriio (embedded) wallet, read from Privy's API (never from the request).
// Needs secrets PRIVY_APP_ID + PRIVY_APP_SECRET.

import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";
import { getAddress } from "npm:viem@2";
import { HANDLE_RE } from "./launchPass.ts";

export const CORS = {
  "Access-Control-Allow-Origin": "*", // auth is the Privy bearer token, not cookies
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type XUser = {
  did: string;
  xUserId: string; // permanent X user ID
  handle: string; // without "@"
  name: string | null;
  pfpUrl: string | null;
  wallet: `0x${string}`; // checksummed
};

type Linked = {
  type: string;
  subject?: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
  address?: string;
  chain_type?: string;
  wallet_client_type?: string;
};

export function privyAuth(appId: string, appSecret: string) {
  const jwks = createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`));

  /** Verifies the Bearer token and returns the caller's X account + Neuriio wallet. Throws HttpError. */
  return async function xUserFromRequest(req: Request): Promise<XUser> {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) throw new HttpError(401, "Log in first");
    let did: string;
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: "privy.io", audience: appId });
      did = String(payload.sub);
    } catch {
      throw new HttpError(401, "Session expired, log in again");
    }

    const res = await fetch(`https://auth.privy.io/api/v1/users/${encodeURIComponent(did)}`, {
      headers: { Authorization: `Basic ${btoa(`${appId}:${appSecret}`)}`, "privy-app-id": appId },
    });
    if (!res.ok) throw new HttpError(502, `Privy user lookup failed (${res.status})`);
    const linked: Linked[] = (await res.json()).linked_accounts ?? [];

    const x = linked.find((a) => a.type === "twitter_oauth");
    const wallet = linked.find(
      (a) => a.type === "wallet" && a.wallet_client_type === "privy" && a.chain_type === "ethereum",
    )?.address;
    if (!x?.subject || !x.username) throw new HttpError(403, "Log in with X");
    if (!wallet) throw new HttpError(409, "Your Neuriio wallet isn't ready yet, try again in a moment");
    if (!HANDLE_RE.test(x.username)) throw new HttpError(422, `Unsupported X handle: ${x.username}`);
    return {
      did,
      xUserId: x.subject,
      handle: x.username,
      name: x.name ?? null,
      pfpUrl: x.profile_picture_url?.replace("_normal.", "_200x200.") ?? null,
      wallet: getAddress(wallet),
    };
  };
}

/** users row for an XUser (upsert on privy_id). */
export const userRow = (u: XUser) => ({
  privy_id: u.did,
  x_user_id: u.xUserId,
  x_handle: u.handle,
  x_name: u.name,
  x_pfp_url: u.pfpUrl,
  wallet: u.wallet.toLowerCase(),
  last_seen_at: new Date().toISOString(),
});
