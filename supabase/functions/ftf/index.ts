// POST /functions/v1/ftf     headers: Authorization: Bearer <Privy access token>     body: { action, ... }
// Forming an FTF ("Friends Turned Fam": exactly 4 people, one token on the bonding curve) before it launches.
// Every caller is identified from their Privy login (X account + Neuriio wallet), never from the body.
//
//   create  { name, ticker, profile: { about, links } }  -> you're the founder (accepted); returns the draft
//   invite  { draftId, handle }        founder invites a Neuriio user by X handle
//   request { draftId }                ask to be added (anyone logged in)
//   approve { draftId, xUserId }       founder accepts a request
//   accept  { draftId }                an invited user accepts
//   decline { draftId }                an invited user / requester says no
//   remove  { draftId, xUserId }       founder removes someone (not after launch)
//   leave   { draftId }                a member leaves (not the founder)
//   cancel  { draftId }                founder cancels the draft
//   pass    { draftId }                founder, with exactly 4 accepted: a signed FtfPass for Launchpad.launchFtf
//
// Secrets: PRIVY_APP_ID, PRIVY_APP_SECRET, LAUNCH_SIGNER_KEY, LAUNCHPAD_ADDRESS, CHAIN_ID, RPC_URL

import { createClient } from "npm:@supabase/supabase-js@2";
import { createPublicClient, getAddress, http, keccak256, parseAbi, toBytes, zeroAddress } from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import {
  canonicalFtfProfile,
  FTF_MEMBERS,
  ftfPassTypes,
  launchpadDomain,
  PASS_TTL_SECONDS,
  validFtfIdentity,
} from "../_shared/launchPass.ts";
import { CORS, HttpError, json, privyAuth, userRow, type XUser } from "../_shared/privy.ts";
import { env } from "../_shared/env.ts";

const CHAIN_ID = Number(env("CHAIN_ID"));
const LAUNCHPAD = getAddress(env("LAUNCHPAD_ADDRESS"));
const signer = privateKeyToAccount(env("LAUNCH_SIGNER_KEY") as `0x${string}`);
const chain = createPublicClient({ transport: http(env("RPC_URL")) });
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const xUserFromRequest = privyAuth(env("PRIVY_APP_ID"), env("PRIVY_APP_SECRET"));

const MAX_OPEN_DRAFTS = 3; // per founder
const MAX_PENDING = 8; // invited + requested per draft
const ACTIONS_PER_MINUTE = 30; // per X account

const padAbi = parseAbi([
  "function tokenOfFtfTicker(bytes32) view returns (address)",
  "function launchSigner() view returns (address)",
]);

type Draft = { id: string; founder: string; name: string; ticker: string; profile: string; profile_hash: string; status: string };
type Member = { draft_id: string; x_user_id: string; role: "founder" | "member"; status: string; created_at: string };

// deno-lint-ignore no-explicit-any
type Body = Record<string, any>;

// ------------------------------------------------------------------ helpers

const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};

function dbError(what: string, detail: string): never {
  console.error(`ftf: ${what}: ${detail}`); // details stay server-side
  throw new HttpError(500, "Something went wrong, try again");
}

async function draftOf(id: unknown): Promise<Draft> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) fail(400, "Unknown FTF");
  const { data, error } = await db.from("ftf_drafts").select("*").eq("id", id).maybeSingle();
  if (error) dbError("draft", error.message);
  if (!data) fail(404, "Unknown FTF");
  return data as Draft;
}

async function membersOf(draftId: string): Promise<Member[]> {
  const { data, error } = await db.from("ftf_members").select("*").eq("draft_id", draftId).order("created_at");
  if (error) dbError("members", error.message);
  return (data ?? []) as Member[];
}

function mustBeOpen(d: Draft) {
  if (d.status !== "open") fail(409, d.status === "launched" ? "This FTF already launched" : "This FTF was cancelled");
}

function mustBeFounder(d: Draft, who: XUser) {
  if (d.founder !== who.xUserId) fail(403, "Only the founder can do that");
}

async function setMember(draftId: string, xUserId: string, patch: Partial<Member>) {
  const { error } = await db
    .from("ftf_members")
    .upsert({ draft_id: draftId, x_user_id: xUserId, updated_at: new Date().toISOString(), ...patch }, { onConflict: "draft_id,x_user_id" });
  if (error) dbError("member upsert", error.message);
}

const accepted = (ms: Member[]) => ms.filter((m) => m.status === "accepted");

async function tickerTakenOnChain(ticker: string) {
  const token = await chain.readContract({ address: LAUNCHPAD, abi: padAbi, functionName: "tokenOfFtfTicker", args: [keccak256(toBytes(ticker))] });
  return token !== zeroAddress;
}

async function view(d: Draft) {
  return { draft: { id: d.id, founder: d.founder, name: d.name, ticker: d.ticker, status: d.status }, members: await membersOf(d.id) };
}

// ------------------------------------------------------------------ actions

async function create(who: XUser, body: Body) {
  const { name, ticker } = validFtfIdentity(body.name, body.ticker);
  const { count } = await db.from("ftf_drafts").select("id", { count: "exact", head: true }).eq("founder", who.xUserId).eq("status", "open");
  if ((count ?? 0) >= MAX_OPEN_DRAFTS) fail(429, `You can have ${MAX_OPEN_DRAFTS} open FTFs at a time`);
  if (await tickerTakenOnChain(ticker)) fail(409, `$${ticker} is already an FTF`);
  let profile: { content: string; hash: `0x${string}` };
  try {
    profile = canonicalFtfProfile(body.profile, { name, ticker, founderXUserId: who.xUserId });
  } catch (e) {
    return fail(422, (e as Error).message);
  }
  const { data, error } = await db
    .from("ftf_drafts")
    .insert({ founder: who.xUserId, name, ticker, profile: profile.content, profile_hash: profile.hash })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") fail(409, `$${ticker} is taken by another FTF being formed`);
    dbError("draft insert", error.message);
  }
  await setMember(data.id, who.xUserId, { role: "founder", status: "accepted" });
  return view(data as Draft);
}

async function invite(who: XUser, body: Body) {
  const d = await draftOf(body.draftId);
  mustBeOpen(d);
  mustBeFounder(d, who);
  const handle = typeof body.handle === "string" ? body.handle.trim().replace(/^@/, "") : "";
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) fail(422, "Enter an X handle");
  // they must have logged into Neuriio once (so we know their X account + wallet)
  const { data: user } = await db.from("users").select("x_user_id").ilike("x_handle", handle).maybeSingle();
  if (!user) fail(404, `@${handle} hasn't logged into Neuriio yet`);
  const ms = await membersOf(d.id);
  const existing = ms.find((m) => m.x_user_id === user!.x_user_id);
  if (existing?.status === "accepted") fail(409, `@${handle} is already in`);
  if (ms.filter((m) => m.status === "invited" || m.status === "requested").length >= MAX_PENDING) fail(429, "Too many pending invites and requests");
  // an invite to someone who already asked to join is an approval
  await setMember(d.id, user!.x_user_id, { role: "member", status: existing?.status === "requested" ? "accepted" : "invited" });
  await capAt4(d.id);
  return view(d);
}

async function request(who: XUser, body: Body) {
  const d = await draftOf(body.draftId);
  mustBeOpen(d);
  const ms = await membersOf(d.id);
  const me = ms.find((m) => m.x_user_id === who.xUserId);
  if (me?.status === "accepted") fail(409, "You're already in");
  if (accepted(ms).length >= FTF_MEMBERS) fail(409, "This FTF is full");
  if (ms.filter((m) => m.status === "invited" || m.status === "requested").length >= MAX_PENDING) fail(429, "Too many pending requests");
  // asking after being invited = accepting
  await setMember(d.id, who.xUserId, { role: "member", status: me?.status === "invited" ? "accepted" : "requested" });
  await capAt4(d.id);
  return view(d);
}

async function approve(who: XUser, body: Body) {
  const d = await draftOf(body.draftId);
  mustBeOpen(d);
  mustBeFounder(d, who);
  const ms = await membersOf(d.id);
  const m = ms.find((x) => x.x_user_id === String(body.xUserId));
  if (!m || m.status !== "requested") fail(404, "No request from them");
  if (accepted(ms).length >= FTF_MEMBERS) fail(409, "This FTF is full");
  await setMember(d.id, m!.x_user_id, { status: "accepted" });
  return view(d);
}

async function accept(who: XUser, body: Body) {
  const d = await draftOf(body.draftId);
  mustBeOpen(d);
  const ms = await membersOf(d.id);
  const me = ms.find((m) => m.x_user_id === who.xUserId);
  if (!me || me.status !== "invited") fail(404, "You weren't invited");
  if (accepted(ms).length >= FTF_MEMBERS) fail(409, "This FTF is full");
  await setMember(d.id, who.xUserId, { status: "accepted" });
  return view(d);
}

async function decline(who: XUser, body: Body) {
  const d = await draftOf(body.draftId);
  mustBeOpen(d);
  const me = (await membersOf(d.id)).find((m) => m.x_user_id === who.xUserId);
  if (!me || (me.status !== "invited" && me.status !== "requested")) fail(404, "Nothing to decline");
  await setMember(d.id, who.xUserId, { status: "declined" });
  return view(d);
}

async function leave(who: XUser, body: Body) {
  const d = await draftOf(body.draftId);
  mustBeOpen(d);
  if (d.founder === who.xUserId) fail(409, "The founder can cancel the FTF instead");
  const me = (await membersOf(d.id)).find((m) => m.x_user_id === who.xUserId);
  if (!me || me.status !== "accepted") fail(404, "You're not in this FTF");
  await setMember(d.id, who.xUserId, { status: "declined" });
  return view(d);
}

async function remove(who: XUser, body: Body) {
  const d = await draftOf(body.draftId);
  mustBeOpen(d);
  mustBeFounder(d, who);
  const id = String(body.xUserId);
  if (id === d.founder) fail(409, "The founder can cancel the FTF instead");
  const m = (await membersOf(d.id)).find((x) => x.x_user_id === id);
  if (!m || m.status === "declined") fail(404, "They're not in this FTF");
  await setMember(d.id, id, { status: "declined" });
  return view(d);
}

async function cancel(who: XUser, body: Body) {
  const d = await draftOf(body.draftId);
  mustBeOpen(d);
  mustBeFounder(d, who);
  const { error } = await db.from("ftf_drafts").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", d.id);
  if (error) dbError("cancel", error.message);
  return view({ ...d, status: "cancelled" });
}

/** Never more than 4 accepted: extra acceptances (race between two actions) are turned back into requests. */
async function capAt4(draftId: string) {
  const acc = accepted(await membersOf(draftId));
  for (const m of acc.slice(FTF_MEMBERS)) await setMember(draftId, m.x_user_id, { status: "requested" });
}

async function pass(who: XUser, body: Body) {
  const d = await draftOf(body.draftId);
  mustBeOpen(d);
  mustBeFounder(d, who);
  const acc = accepted(await membersOf(d.id));
  if (acc.length !== FTF_MEMBERS) fail(409, `An FTF launches with exactly ${FTF_MEMBERS} members (${acc.length} accepted)`);
  // founder first, then in the order they joined
  const ordered = [acc.find((m) => m.role === "founder")!, ...acc.filter((m) => m.role !== "founder")];
  const { data: users, error } = await db.from("users").select("x_user_id, wallet").in("x_user_id", ordered.map((m) => m.x_user_id));
  if (error) dbError("users", error.message);
  const walletOf = new Map((users ?? []).map((u) => [u.x_user_id as string, u.wallet as string]));
  const wallets = ordered.map((m) => walletOf.get(m.x_user_id));
  if (wallets.some((w) => !w)) fail(409, "A member's Neuriio wallet isn't set up yet");
  if (new Set(wallets).size !== FTF_MEMBERS) fail(409, "Members need 4 different wallets");
  if (await tickerTakenOnChain(d.ticker)) fail(409, `$${d.ticker} is already an FTF`);
  const onchainSigner = await chain.readContract({ address: LAUNCHPAD, abi: padAbi, functionName: "launchSigner" });
  if (onchainSigner.toLowerCase() !== signer.address.toLowerCase()) fail(503, "Launches are paused");

  // store the profile where Explore reads it (its hash is fixed on-chain by the pass)
  const { error: pErr } = await db
    .from("creator_profiles")
    .upsert({ hash: d.profile_hash, x_user_id: d.founder, content: d.profile }, { onConflict: "hash", ignoreDuplicates: true });
  if (pErr) dbError("profile", pErr.message);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + PASS_TTL_SECONDS);
  const message = {
    founder: getAddress(wallets[0]!),
    name: d.name,
    ticker: d.ticker,
    memberXIds: ordered.map((m) => BigInt(m.x_user_id)) as [bigint, bigint, bigint, bigint],
    members: wallets.map((w) => getAddress(w!)) as [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`],
    profileHash: d.profile_hash as `0x${string}`,
    deadline,
  };
  if (message.founder.toLowerCase() !== who.wallet.toLowerCase()) fail(409, "Launch it from your own Neuriio wallet");
  const signature = await signer.signTypedData({
    domain: launchpadDomain(CHAIN_ID, LAUNCHPAD),
    types: ftfPassTypes,
    primaryType: "FtfPass",
    message,
  });
  return {
    pass: { ...message, memberXIds: message.memberXIds.map(String), deadline: deadline.toString() },
    signature,
    launchpad: LAUNCHPAD,
    chainId: CHAIN_ID,
  };
}

const ACTIONS: Record<string, (who: XUser, body: Body) => Promise<unknown>> = {
  create, invite, request, approve, accept, decline, leave, remove, cancel, pass,
};

// ------------------------------------------------------------------ entry

const recent = new Map<string, number[]>(); // per X account, action timestamps (per function instance)

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  try {
    const who = await xUserFromRequest(req);
    const now = Date.now();
    const times = (recent.get(who.xUserId) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= ACTIONS_PER_MINUTE) fail(429, "Too many actions, slow down");
    recent.set(who.xUserId, [...times, now]);

    let body: Body;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Invalid JSON" });
    }
    const run = ACTIONS[String(body?.action)];
    if (!run) return json(400, { error: `Unknown action. One of: ${Object.keys(ACTIONS).join(", ")}` });
    // keep the caller's user row fresh (handle, pfp, wallet): members are looked up there
    const { error } = await db.from("users").upsert(userRow(who), { onConflict: "privy_id" });
    if (error) dbError("users upsert", error.message);
    return json(200, await run(who, body));
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(`ftf: ${(e as Error).message}`); // unexpected: details stay server-side
    return json(500, { error: "Something went wrong, try again" });
  }
});
