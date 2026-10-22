// POST /functions/v1/launch-pass
//   headers: Authorization: Bearer <Privy access token>
//   body:    { sector: "robotics" | ..., category: "trader" | ..., profile: { about, links: [{ label, url }] } }
//   200:     { pass, signature, profileHash, launchpad, chainId }  -> Launchpad.launch(pass, signature, minTokensOut)
//
// Verifies the Privy login, reads the user's X account + Neuriio (embedded) wallet from Privy, stores the profile,
// and signs a LaunchPass. The chain enforces one token per X user / wallet / handle; we pre-check to fail early.
//
// Secrets: PRIVY_APP_ID, PRIVY_APP_SECRET, LAUNCH_SIGNER_KEY, LAUNCHPAD_ADDRESS, CHAIN_ID, RPC_URL
// (SUPABASE_URL is provided by Supabase; NEURIIO_DB_KEY = the project's sb_secret key, set 2026-10-21 after the Railway leak.)

import { createClient } from "npm:@supabase/supabase-js@2";
import { createPublicClient, getAddress, http, keccak256, parseAbi, toBytes, zeroAddress } from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import {
  canonicalProfile,
  CATEGORIES,
  type Category,
  SECTORS,
  type Sector,
  launchpadDomain,
  launchPassTypes,
  PASS_TTL_SECONDS,
} from "../_shared/launchPass.ts";
import { CORS, HttpError, internalError, json, privyAuth, userRow, type XUser } from "../_shared/privy.ts";
import { env } from "../_shared/env.ts";


const PRIVY_APP_ID = env("PRIVY_APP_ID");
const PRIVY_APP_SECRET = env("PRIVY_APP_SECRET");
const CHAIN_ID = Number(env("CHAIN_ID"));
const LAUNCHPAD = getAddress(env("LAUNCHPAD_ADDRESS")); // the current version: passes are signed for it
const REGISTRY = getAddress(env("REGISTRY_ADDRESS")); // identity across every version
const signer = privateKeyToAccount(env("LAUNCH_SIGNER_KEY") as `0x${string}`);
const chain = createPublicClient({ transport: http(env("RPC_URL")) });
const db = createClient(env("SUPABASE_URL"), env("NEURIIO_DB_KEY"), { auth: { persistSession: false } });
const xUserFromRequest = privyAuth(PRIVY_APP_ID, PRIVY_APP_SECRET);

const PASSES_PER_10_MIN = 5;

/** A server-side failure: logged with details, the caller gets a generic message. */
function failed(what: string, detail: string) {
  try {
    internalError("launch-pass", what, detail);
  } catch (e) {
    return json(500, { error: (e as Error).message });
  }
  return json(500, { error: "Something went wrong, try again" });
}

const launchpadAbi = parseAbi(["function launchSigner() view returns (address)"]);
const registryAbi = parseAbi([
  "function tokenOfXUser(uint64) view returns (address)",
  "function tokenOfCreator(address) view returns (address)",
  "function tokenOfHandle(bytes32) view returns (address)",
  "function reservedTicker(bytes32) view returns (bool)",
  "function isLaunchpad(address) view returns (bool)",
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

  // rate limit: a few passes per X account per 10 minutes (each stores a profile of up to 5,000 characters)
  const { count: recent } = await db
    .from("launch_passes")
    .select("id", { count: "exact", head: true })
    .eq("x_user_id", xUserId)
    .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
  if ((recent ?? 0) >= PASSES_PER_10_MIN) return json(429, { error: "Too many attempts, try again in a few minutes" });

  // 3. what they're launching
  let body: { sector?: string; category?: string; profile?: { about: string; links?: { label: string; url: string }[] } };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }
  const sector = body.sector as Sector;
  if (!SECTORS.includes(sector)) return json(422, { error: `Pick a sector: ${SECTORS.join(", ")}` });
  const category = body.category as Category;
  const categoryIndex = CATEGORIES.indexOf(category);
  if (categoryIndex < 0) return json(422, { error: `Pick a category: ${CATEGORIES.join(", ")}` });
  let profile: { content: string; hash: `0x${string}` };
  try {
    profile = canonicalProfile(body.profile!, { xUserId, handle, sector, category });
  } catch (e) {
    return json(422, { error: (e as Error).message });
  }

  // 4. fail early (the LaunchRegistry enforces all of this on-chain, across every Launchpad version)
  const reg = (functionName: "tokenOfXUser" | "tokenOfCreator" | "tokenOfHandle", arg: bigint | `0x${string}`) =>
    // deno-lint-ignore no-explicit-any
    chain.readContract({ address: REGISTRY, abi: registryAbi, functionName, args: [arg] as any });
  const [byX, byWallet, byHandle, reserved, approved, onchainSigner] = await Promise.all([
    reg("tokenOfXUser", BigInt(xUserId)),
    reg("tokenOfCreator", creator),
    reg("tokenOfHandle", keccak256(toBytes(handle.toLowerCase()))),
    chain.readContract({ address: REGISTRY, abi: registryAbi, functionName: "reservedTicker", args: [keccak256(toBytes(handle.toUpperCase()))] }),
    chain.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isLaunchpad", args: [LAUNCHPAD] }),
    chain.readContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "launchSigner" }),
  ]);
  const mine = [byX, byWallet].find((a) => a !== zeroAddress);
  if (mine) return json(409, { error: "You already launched your token", token: mine });
  if (byHandle !== zeroAddress) return json(409, { error: `@${handle} was already launched by another account`, token: byHandle });
  if (reserved) return json(422, { error: `$${handle.toUpperCase()} is reserved (it looks like a real asset), so @${handle} can't launch` });
  if (!approved || onchainSigner.toLowerCase() !== signer.address.toLowerCase()) {
    return json(503, { error: "Launches are paused" });
  }

  // 5. record the user + profile, sign
  const now = new Date();
  const { error: userErr } = await db.from("users").upsert(userRow(who), { onConflict: "privy_id" });
  if (userErr) return failed("users upsert", userErr.message);
  const { error: profileErr } = await db.from("creator_profiles").upsert(
    { hash: profile.hash, x_user_id: xUserId, content: profile.content },
    { onConflict: "hash", ignoreDuplicates: true },
  );
  if (profileErr) return failed("creator_profiles upsert", profileErr.message);

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
