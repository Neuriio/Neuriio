// POST /functions/v1/referral    headers: Authorization: Bearer <Privy access token>    body: { action, ... }
// Referral codes (migration referrals; user, 2026-11-03). The Account panel's Referral box:
//   status                     -> { code, wallets: [{ address, kind }] }
//   apply   { code }           ties the account to an active code (one per account, for good) and counts its Neuriio wallet
//   verify  { wallet, signature }  counts an outside wallet once its owner signed the Verify message (_shared/referral.ts). Plain
//                              wallets only: a smart-contract wallet's signature can't be checked this way.
// A wallet counts for one account only. Partners are paid weekly by hand from referral_report().
//
// Secrets: PRIVY_APP_ID, PRIVY_APP_SECRET, NEURIIO_DB_KEY (SUPABASE_URL is provided by Supabase).

import { createClient } from "npm:@supabase/supabase-js@2";
import { getAddress, isAddress, verifyMessage as checkSignature } from "npm:viem@2";
import { CORS, HttpError, internalError, json, privyAuth, type XUser } from "../_shared/privy.ts";
import { env } from "../_shared/env.ts";
import { rateLimit } from "../_shared/rateLimit.ts";
import { isCode, normalizeCode, verifyMessage } from "../_shared/referral.ts";

const db = createClient(env("SUPABASE_URL"), env("NEURIIO_DB_KEY"), { auth: { persistSession: false } });
const xUserFromRequest = privyAuth(env("PRIVY_APP_ID"), env("PRIVY_APP_SECRET"));
const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};
const dbError = (what: string, detail: string) => internalError("referral", what, detail);

async function status(who: XUser) {
  const { data: acct, error } = await db.from("referral_accounts").select("code").eq("x_user_id", who.xUserId).maybeSingle();
  if (error) dbError("account", error.message);
  if (!acct) return { code: null, wallets: [] };
  const { data: wallets, error: e2 } = await db.from("referral_wallets").select("wallet, kind").eq("x_user_id", who.xUserId).order("added_at");
  if (e2) dbError("wallets", e2.message);
  return { code: acct.code, wallets: (wallets ?? []).map((w) => ({ address: getAddress(w.wallet), kind: w.kind })) };
}

async function apply(who: XUser, body: Record<string, unknown>) {
  const code = normalizeCode(String(body.code ?? ""));
  if (!isCode(code)) fail(422, "Codes are 3 to 20 letters, numbers or _");
  await rateLimit(db, "referral", `referral:apply:${who.xUserId}`, 10, 600, "Too many tries, wait a few minutes");
  const { data: found, error } = await db.from("referral_codes").select("active").eq("code", code).maybeSingle();
  if (error) dbError("code", error.message);
  if (!found?.active) fail(404, "That code doesn't exist");

  const { error: e2 } = await db.from("referral_accounts").insert({ x_user_id: who.xUserId, code });
  if (e2?.code === "23505") {
    const now = await status(who);
    if (now.code !== code) fail(409, `This account already uses ${now.code}`);
  } else if (e2) dbError("account insert", e2.message);

  const { error: e3 } = await db.from("referral_wallets").insert({ wallet: who.wallet.toLowerCase(), x_user_id: who.xUserId, kind: "neuriio" });
  if (e3 && e3.code !== "23505") dbError("wallet insert", e3.message); // 23505: already counted (applied twice)
  return status(who);
}

async function verify(who: XUser, body: Record<string, unknown>) {
  const wallet = String(body.wallet ?? "");
  const signature = String(body.signature ?? "");
  if (!isAddress(wallet, { strict: false })) fail(422, "Not a wallet address");
  if (!/^0x[0-9a-fA-F]{130,}$/.test(signature) || signature.length > 2000) fail(422, "Not a signature");
  await rateLimit(db, "referral", `referral:verify:${who.xUserId}`, 20, 600, "Too many tries, wait a few minutes");
  const now = await status(who);
  if (!now.code) fail(409, "Apply a code first");

  const address = getAddress(wallet);
  const message = verifyMessage(now.code!, who.wallet, address);
  const ok = await checkSignature({ address, message, signature: signature as `0x${string}` }).catch(() => false);
  if (!ok) fail(401, "That signature isn't from this wallet");

  const { error } = await db.from("referral_wallets").insert({ wallet: address.toLowerCase(), x_user_id: who.xUserId, kind: "signed", signature });
  if (error?.code === "23505") {
    if (!now.wallets.some((w) => w.address === address)) fail(409, "This wallet already counts for another account");
  } else if (error) dbError("wallet insert", error.message);
  return status(who);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  try {
    const who = await xUserFromRequest(req);
    const body = await req.json().catch(() => ({}));
    switch (body?.action) {
      case "status":
        return json(200, await status(who));
      case "apply":
        return json(200, await apply(who, body));
      case "verify":
        return json(200, await verify(who, body));
      default:
        return json(400, { error: "Unknown action" });
    }
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(`referral: ${(e as Error).message}`); // unexpected: details stay server-side
    return json(500, { error: "Something went wrong, try again" });
  }
});
