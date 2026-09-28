// POST /functions/v1/launch-pass
//   headers: Authorization: Bearer <Privy access token>
//   body:    { category: "trader" | ..., profile: { about, links: [{ label, url }] } }
//   200:     { pass, signature, profileHash, launchpad, chainId }  -> Launchpad.launch(pass, signature, minTokensOut)
//
// Verifies the Privy login, reads the user's X account + Neuriio (embedded) wallet from Privy, stores the profile,
// and signs a LaunchPass. The chain enforces one token per X user / wallet / handle; we pre-check to fail early.
//
// Secrets: PRIVY_APP_ID, PRIVY_APP_SECRET, LAUNCH_SIGNER_KEY, LAUNCHPAD_ADDRESS, CHAIN_ID, RPC_URL
// (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.)

import { createClient } from "npm:@supabase/supabase-js@2";
import { createPublicClient, getAddress, http, parseAbi, zeroAddress } from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import {
  canonicalProfile,
  CATEGORIES,
  type Category,
  launchpadDomain,
  launchPassTypes,
  PASS_TTL_SECONDS,
} from "../_shared/launchPass.ts";
import { CORS, HttpError, json, privyAuth, userRow, type XUser } from "../_shared/privy.ts";

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing secret ${k}`);
  return v;
};

const PRIVY_APP_ID = env("PRIVY_APP_ID");
const PRIVY_APP_SECRET = env("PRIVY_APP_SECRET");
const CHAIN_ID = Number(env("CHAIN_ID"));
const LAUNCHPAD = getAddress(env("LAUNCHPAD_ADDRESS"));
const signer = privateKeyToAccount(env("LAUNCH_SIGNER_KEY") as `0x${string}`);
const chain = createPublicClient({ transport: http(env("RPC_URL")) });
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const xUserFromRequest = privyAuth(PRIVY_APP_ID, PRIVY_APP_SECRET);

const launchpadAbi = parseAbi([
  "function tokenOfXUser(uint64) view returns (address)",
  "function tokenOfCreator(address) view returns (address)",
  "function launchSigner() view returns (address)",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  // 1-2. who is calling: Privy login -> X account + Neuriio wallet (from Privy, never from the body)
  let who: XUser;
  try {
    who = await xUserFromRequest(req);
  } catch (e) {
    return json(e instanceof HttpError ? e.status : 500, { error: (e as Error).message });
  }
  const { did, xUserId, handle, wallet: creator } = who;

  // 3. what they're launching
  let body: { category?: string; profile?: { about: string; links?: { label: string; url: string }[] } };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }
  const category = body.category as Category;
  const categoryIndex = CATEGORIES.indexOf(category);
  if (categoryIndex < 0) return json(422, { error: `Pick a category: ${CATEGORIES.join(", ")}` });
  let profile: { content: string; hash: `0x${string}` };
  try {
    profile = canonicalProfile(body.profile!, { xUserId, handle, category });
  } catch (e) {
    return json(422, { error: (e as Error).message });
  }

  // 4. fail early if they already launched (the contract enforces this too)
  const [byX, byWallet, onchainSigner] = await Promise.all([
    chain.readContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "tokenOfXUser", args: [BigInt(xUserId)] }),
    chain.readContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "tokenOfCreator", args: [creator] }),
    chain.readContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "launchSigner" }),
  ]);
  if (byX !== zeroAddress || byWallet !== zeroAddress) {
    return json(409, { error: "You already launched your token", token: byX !== zeroAddress ? byX : byWallet });
  }
  if (onchainSigner.toLowerCase() !== signer.address.toLowerCase()) {
    return json(503, { error: "Launches are paused" });
  }

  // 5. record the user + profile, sign
  const now = new Date();
  const { error: userErr } = await db.from("users").upsert(userRow(who), { onConflict: "privy_id" });
  if (userErr) return json(500, { error: "Could not save your profile", detail: userErr.message });
  const { error: profileErr } = await db.from("creator_profiles").upsert(
    { hash: profile.hash, x_user_id: xUserId, content: profile.content },
    { onConflict: "hash", ignoreDuplicates: true },
  );
  if (profileErr) return json(500, { error: "Could not save your profile", detail: profileErr.message });

  const deadline = BigInt(Math.floor(now.getTime() / 1000) + PASS_TTL_SECONDS);
  const pass = {
    creator,
    xUserId: BigInt(xUserId),
    handle,
    category: categoryIndex,
    profileHash: profile.hash,
    deadline,
  };
  const signature = await signer.signTypedData({
    domain: launchpadDomain(CHAIN_ID, LAUNCHPAD),
    types: launchPassTypes,
    primaryType: "LaunchPass",
    message: pass,
  });
  await db.from("launch_passes").insert({
    privy_id: did,
    x_user_id: xUserId,
    wallet: creator.toLowerCase(),
    handle,
    category,
    profile_hash: profile.hash,
    deadline: new Date(Number(deadline) * 1000).toISOString(),
    signature,
  });

  return json(200, {
    pass: { ...pass, xUserId: xUserId, deadline: deadline.toString() },
    signature,
    profileHash: profile.hash,
    launchpad: LAUNCHPAD,
    chainId: CHAIN_ID,
  });
});
