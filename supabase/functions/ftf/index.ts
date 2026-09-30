// POST /functions/v1/ftf     headers: Authorization: Bearer <Privy access token>     body: { action, ... }
// Forming an FTF ("Friends Turned Fam": exactly 4 people, one token on the bonding curve) before it launches.
// Every caller is identified from their Privy login (X account + Neuriio wallet), never from the body.
//
//   create  { name, ticker }            -> you're the founder (accepted); then invite 3 people
//   mine    {}                          the FTF you're forming (as founder), with member cards
//   inbox   {}                          notifications: invites to you + requests on FTFs you founded
//   profile { draftId, sector, category, about, links }   founder, after all 4 accepted
//   pfp     { draftId, contentType, base64 }      founder: the FTF's picture (png/jpeg/webp, <= 512 KB)
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
  CATEGORIES,
  type Category,
  canonicalFtfProfile,
  FTF_MEMBERS,
  ftfPassTypes,
  launchpadDomain,
  PASS_TTL_SECONDS,
  SECTORS,
  type Sector,
  validFtfIdentity,
} from "../_shared/launchPass.ts";
import { CORS, HttpError, internalError, json, privyAuth, userRow, type XUser } from "../_shared/privy.ts";
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

type Draft = {
  id: string;
  founder: string;
  name: string;
  ticker: string;
  profile: string | null;
  profile_hash: string | null;
  sector: Sector | null;
  category: Category | null;
  pfp_url: string | null;
  status: string;
};
type Member = { draft_id: string; x_user_id: string; role: "founder" | "member"; status: string; created_at: string };

// deno-lint-ignore no-explicit-any
type Body = Record<string, any>;

// ------------------------------------------------------------------ helpers

const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};

const dbError = (what: string, detail: string): never => internalError("ftf", what, detail);

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
  // member activity counts as activity on the draft (drafts idle for 7 days expire: expire_ftf_drafts)
  await db.from("ftf_drafts").update({ updated_at: new Date().toISOString() }).eq("id", draftId);
}

const accepted = (ms: Member[]) => ms.filter((m) => m.status === "accepted");

async function tickerTakenOnChain(ticker: string) {
  const token = await chain.readContract({ address: LAUNCHPAD, abi: padAbi, functionName: "tokenOfFtfTicker", args: [keccak256(toBytes(ticker))] });
  return token !== zeroAddress;
}

/** The draft + its members with their X cards (handle, name, picture). */
async function view(d: Draft) {
  const members = await membersOf(d.id);
  const cards = await cardsOf(members.map((m) => m.x_user_id));
  let about: string | null = null;
  let links: unknown[] = [];
  if (d.profile) {
    try {
      const p = JSON.parse(d.profile);
      about = p.about ?? null;
      links = p.links ?? [];
    } catch { /* stored by us; never malformed */ }
  }
  return {
    draft: { id: d.id, founder: d.founder, name: d.name, ticker: d.ticker, status: d.status, sector: d.sector, category: d.category, pfpUrl: d.pfp_url, about, links },
    members: members.map((m) => ({ ...m, ...cards.get(m.x_user_id) })),
  };
}

async function cardsOf(ids: string[]) {
  if (!ids.length) return new Map<string, { x_handle: string; x_name: string | null; x_pfp_url: string | null }>();
  const { data, error } = await db.from("users").select("x_user_id, x_handle, x_name, x_pfp_url").in("x_user_id", ids);
  if (error) dbError("cards", error.message);
  return new Map((data ?? []).map((u) => [u.x_user_id as string, { x_handle: u.x_handle as string, x_name: u.x_name, x_pfp_url: u.x_pfp_url }]));
}

// ------------------------------------------------------------------ actions

async function create(who: XUser, body: Body) {
  const { name, ticker } = validFtfIdentity(body.name, body.ticker);
  const { count } = await db.from("ftf_drafts").select("id", { count: "exact", head: true }).eq("founder", who.xUserId).eq("status", "open");
  if ((count ?? 0) >= MAX_OPEN_DRAFTS) fail(429, `You can have ${MAX_OPEN_DRAFTS} open FTFs at a time`);
  if (await tickerTakenOnChain(ticker)) fail(409, `$${ticker} is already an FTF`);
  const { data, error } = await db.from("ftf_drafts").insert({ founder: who.xUserId, name, ticker }).select("*").single();
  if (error) {
    if (error.code === "23505") fail(409, `$${ticker} is taken by another FTF being formed`);
    dbError("draft insert", error.message);
  }
  await setMember(data.id, who.xUserId, { role: "founder", status: "accepted" });
  return view(data as Draft);
}

/** The FTF you're forming as founder (newest open one), or null. */
async function mine(who: XUser) {
  const { data, error } = await db.from("ftf_drafts").select("*").eq("founder", who.xUserId).eq("status", "open")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) dbError("mine", error.message);
  return data ? view(data as Draft) : { draft: null, members: [] };
}

/** Notifications: invites waiting for you, and people asking to join FTFs you founded. */
async function inbox(who: XUser) {
  const { data: mineRows, error: e1 } = await db.from("ftf_members").select("draft_id, status, created_at")
    .eq("x_user_id", who.xUserId).eq("status", "invited");
  if (e1) dbError("inbox invites", e1.message);
  const { data: founded, error: e2 } = await db.from("ftf_drafts").select("id").eq("founder", who.xUserId).eq("status", "open");
  if (e2) dbError("inbox drafts", e2.message);
  const foundedIds = (founded ?? []).map((d) => d.id as string);
  const { data: reqRows, error: e3 } = foundedIds.length
    ? await db.from("ftf_members").select("draft_id, x_user_id, created_at").in("draft_id", foundedIds).eq("status", "requested")
    : { data: [], error: null };
  if (e3) dbError("inbox requests", e3.message);

  const draftIds = [...new Set([...(mineRows ?? []).map((r) => r.draft_id as string), ...foundedIds])];
  const { data: drafts, error: e4 } = draftIds.length
    ? await db.from("ftf_drafts").select("id, founder, name, ticker, status").in("id", draftIds).eq("status", "open")
    : { data: [], error: null };
  if (e4) dbError("inbox draft rows", e4.message);
  const byId = new Map((drafts ?? []).map((d) => [d.id as string, d]));
  const cards = await cardsOf([...(drafts ?? []).map((d) => d.founder as string), ...(reqRows ?? []).map((r) => r.x_user_id as string)]);

  const invites = (mineRows ?? []).filter((r) => byId.has(r.draft_id)).map((r) => {
    const d = byId.get(r.draft_id)!;
    return { kind: "invite", draftId: d.id, name: d.name, ticker: d.ticker, from: { x_user_id: d.founder, ...cards.get(d.founder) }, at: r.created_at };
  });
  const requests = (reqRows ?? []).filter((r) => byId.has(r.draft_id)).map((r) => {
    const d = byId.get(r.draft_id)!;
    return { kind: "request", draftId: d.id, name: d.name, ticker: d.ticker, from: { x_user_id: r.x_user_id, ...cards.get(r.x_user_id) }, at: r.created_at };
  });
  return { items: [...invites, ...requests].sort((a, b) => String(b.at).localeCompare(String(a.at))) };
}

/** Founder, once all 4 accepted: sector + category + about + links (the picture comes from `pfp`). */
async function profile(who: XUser, body: Body) {
  const d = await draftOf(body.draftId);
  mustBeOpen(d);
  mustBeFounder(d, who);
  if (accepted(await membersOf(d.id)).length !== FTF_MEMBERS) fail(409, `All ${FTF_MEMBERS} members have to accept first`);
  const sector = String(body.sector) as Sector;
  if (!SECTORS.includes(sector)) fail(422, `Pick a sector: ${SECTORS.join(", ")}`);
  const category = String(body.category) as Category;
  if (!CATEGORIES.includes(category)) fail(422, `Pick a category: ${CATEGORIES.join(", ")}`);
  let p: { content: string; hash: `0x${string}` };
  try {
    p = canonicalFtfProfile(body, { name: d.name, ticker: d.ticker, founderXUserId: d.founder, sector, category, pfpUrl: d.pfp_url });
  } catch (e) {
    return fail(422, (e as Error).message);
  }
  const { error } = await db.from("ftf_drafts")
    .update({ sector, category, profile: p.content, profile_hash: p.hash, updated_at: new Date().toISOString() }).eq("id", d.id);
  if (error) dbError("profile", error.message);
  return view({ ...d, sector, category, profile: p.content, profile_hash: p.hash });
}

const PFP_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** Founder: the FTF's picture (stored in the public ftf-pfp bucket). Clears the profile hash (it includes the URL). */
async function pfp(who: XUser, body: Body) {
  const d = await draftOf(body.draftId);
  mustBeOpen(d);
  mustBeFounder(d, who);
  const ext = PFP_TYPES[String(body.contentType)];
  if (!ext) fail(422, "Picture must be PNG, JPEG or WebP");
  const b64 = typeof body.base64 === "string" ? body.base64 : "";
  if (b64.length > 700_000) fail(413, "Picture must be 512 KB or smaller");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return fail(422, "Couldn't read that picture");
  }
  if (bytes.length > 524_288) fail(413, "Picture must be 512 KB or smaller");
  const path = `${d.id}/${Date.now()}.${ext}`; // new name each time, so caches never show an old picture
  const { error: upErr } = await db.storage.from("ftf-pfp").upload(path, bytes, { contentType: String(body.contentType), upsert: false });
  if (upErr) dbError("pfp upload", upErr.message);
  const url = db.storage.from("ftf-pfp").getPublicUrl(path).data.publicUrl;
  // the profile document includes the picture URL, so it has to be saved again after a new picture
  let patch: Partial<Draft> = { pfp_url: url };
  if (d.profile && d.sector && d.category) {
    const old = JSON.parse(d.profile);
    const p = canonicalFtfProfile({ about: old.about, links: old.links }, { name: d.name, ticker: d.ticker, founderXUserId: d.founder, sector: d.sector, category: d.category, pfpUrl: url });
    patch = { ...patch, profile: p.content, profile_hash: p.hash };
  }
  const { error } = await db.from("ftf_drafts").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", d.id);
  if (error) dbError("pfp save", error.message);
  return view({ ...d, ...patch });
}

async function invite(who: XUser, body: Body) {
  const d = await draftOf(body.draftId);
  mustBeOpen(d);
  mustBeFounder(d, who);
  const handle = typeof body.handle === "string" ? body.handle.trim().replace(/^@/, "") : "";
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) fail(422, "Enter an X handle");
  // they must have logged into Neuriio once (so we know their X account + wallet)
  // case-insensitive exact match: escape "_" (a LIKE wildcard, and common in handles) so @a_b can't match @axb
  const { data: user } = await db.from("users").select("x_user_id").ilike("x_handle", handle.replace(/_/g, "\\_")).maybeSingle();
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
  if (!d.profile || !d.profile_hash || !d.sector || !d.category) fail(409, "Add the FTF's sector, category and profile first");
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
  create, mine, inbox, profile, pfp, invite, request, approve, accept, decline, leave, remove, cancel, pass,
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
