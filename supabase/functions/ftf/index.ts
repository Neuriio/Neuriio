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
// Testnet HYPE requests (the header button; admins = app_config.hype_admins, they see requests in their inbox):
//   hypeStatus {}                      your latest request: { status: none | pending | sent | dismissed, at, claimed,
//                                      usdcClaimed }
//   claimHype  {}                      the faucet: what this X account hasn't had yet, once each, ever: 0.2 HYPE (gas)
//                                      and 1,000 test USDC, to your Neuriio wallet
//                                      -> { status: "sent", tx, hypeTx, usdcTx } | { status: "claimed" } |
//                                      { status: "fallback", usdcTx } (no HYPE to give: the app files a manual request)
//   hype       {}                      ask for testnet HYPE to your Neuriio wallet (one open request; again 24 h after sent)
//   hypeDone   { id, sent }            admin: mark a request sent (or dismissed)
//
// Secrets: PRIVY_APP_ID, PRIVY_APP_SECRET, LAUNCH_SIGNER_KEY, LAUNCHPAD_ADDRESS, CHAIN_ID, RPC_URL; optional FAUCET_KEY
// (the faucet wallet's key: its own wallet, never the deployer/owner key; without it every claim falls back)

import { createClient } from "npm:@supabase/supabase-js@2";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, getAddress, http, keccak256, parseAbi, parseEther, parseUnits, toBytes, zeroAddress } from "npm:viem@2";
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
const LAUNCHPAD = getAddress(env("LAUNCHPAD_ADDRESS")); // the current version: passes are signed for it
const REGISTRY = getAddress(env("REGISTRY_ADDRESS")); // FTF tickers + reserved tickers, across every version
const signer = privateKeyToAccount(env("LAUNCH_SIGNER_KEY") as `0x${string}`);
const chain = createPublicClient({ transport: http(env("RPC_URL")) });
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const xUserFromRequest = privyAuth(env("PRIVY_APP_ID"), env("PRIVY_APP_SECRET"));

const MAX_OPEN_DRAFTS = 3; // per founder
const MAX_PENDING = 8; // invited + requested per draft
const ACTIONS_PER_MINUTE = 30; // per X account

const padAbi = parseAbi([
  "function launchSigner() view returns (address)",
]);
const registryAbi = parseAbi([
  "function tokenOfFtfTicker(bytes32) view returns (address)",
  "function reservedTicker(bytes32) view returns (bool)",
  "function isLaunchpad(address) view returns (bool)",
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
  const token = await chain.readContract({ address: REGISTRY, abi: registryAbi, functionName: "tokenOfFtfTicker", args: [keccak256(toBytes(ticker))] });
  return token !== zeroAddress;
}

/** Reserved in the LaunchRegistry ($USDC, $HYPE, ...). */
async function tickerReservedOnChain(ticker: string) {
  return chain.readContract({ address: REGISTRY, abi: registryAbi, functionName: "reservedTicker", args: [keccak256(toBytes(ticker))] });
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
  if (await tickerReservedOnChain(ticker)) fail(422, `$${ticker} is reserved (it looks like a real asset): pick another ticker`);
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
  const hype = await hypeNotices(who);
  return { items: [...invites, ...requests, ...hype].sort((a, b) => String(b.at).localeCompare(String(a.at))) };
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
  const [onchainSigner, approved] = await Promise.all([
    chain.readContract({ address: LAUNCHPAD, abi: padAbi, functionName: "launchSigner" }),
    chain.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isLaunchpad", args: [LAUNCHPAD] }),
  ]);
  if (!approved || onchainSigner.toLowerCase() !== signer.address.toLowerCase()) fail(503, "Launches are paused");

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

// ------------------------------------------------------------------ testnet HYPE requests

const HYPE_AGAIN_MS = 24 * 60 * 60 * 1000; // after a request was sent

// the faucet: its own wallet (FAUCET_KEY), once per X account: 0.2 HYPE for gas and 1,000 test USDC (2026-10-18; paid
// from the faucet's USDC balance, funded by the owner)
const FAUCET_AMOUNT = parseEther("0.2");
const FAUCET_USDC = "1000"; // whole USDC
const FAUCET_GAS_RESERVE = parseEther("0.01"); // keep this much for gas; below amount + reserve, claims fall back
const faucetKey = Deno.env.get("FAUCET_KEY");
const faucet = faucetKey
  ? createWalletClient({
    account: privateKeyToAccount(faucetKey as `0x${string}`),
    chain: defineChain({ id: CHAIN_ID, name: "Elysium", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [env("RPC_URL")] } } }),
    transport: http(env("RPC_URL")),
  })
  : null;
/** The world's USDC: the current NeuriioPad's quote token (read once). */
let usdcAddress: `0x${string}` | null = null;
async function usdc() {
  usdcAddress ??= await chain.readContract({ address: LAUNCHPAD, abi: parseAbi(["function quote() view returns (address)"]), functionName: "quote" });
  return usdcAddress;
}

type ClaimTable = "hype_claims" | "usdc_claims";
async function claimedIn(table: ClaimTable, who: XUser) {
  const { data, error } = await db.from(table).select("status").eq("x_user_id", who.xUserId).maybeSingle();
  if (error) dbError("claim status", error.message);
  return !!data;
}

/** Sends one faucet payout (many claims at once share one sender: on a nonce clash, try again with a fresh nonce). */
async function faucetSend(send: (nonce: number) => Promise<`0x${string}`>) {
  for (let i = 0; ; i++) {
    try {
      return await send(await chain.getTransactionCount({ address: faucet!.account.address, blockTag: "pending" }));
    } catch (e) {
      const m = (e as Error).message.toLowerCase();
      if (!/nonce|replacement|already known/.test(m) || i === 3) throw e;
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 400));
    }
  }
}

/** One payout, once per X account: the row inserted first is the lock (a second click or tab hits the primary key);
 *  a failed send deletes it again. "sent" | "claimed" | "unavailable" (the faucet can't pay this right now). */
async function payOnce(table: ClaimTable, who: XUser, amount: string, canPay: () => Promise<boolean>, send: (nonce: number) => Promise<`0x${string}`>) {
  const { error } = await db.from(table).insert({ x_user_id: who.xUserId, wallet: who.wallet.toLowerCase(), amount, status: "sending" });
  if (error) {
    if (error.code === "23505") return { status: "claimed" as const };
    dbError("claim insert", error.message);
  }
  const release = () => db.from(table).delete().eq("x_user_id", who.xUserId).eq("status", "sending");
  try {
    if (!(await canPay())) {
      await release();
      return { status: "unavailable" as const };
    }
    const tx = await faucetSend(send);
    const { error: e2 } = await db.from(table).update({ status: "sent", tx_hash: tx }).eq("x_user_id", who.xUserId);
    if (e2) console.error(`ftf: ${table} update: ${e2.message}`); // it went out; the row still blocks a second claim
    return { status: "sent" as const, tx };
  } catch (e) {
    console.error(`ftf: faucet ${table}: ${(e as Error).message}`);
    await release();
    return { status: "unavailable" as const };
  }
}

async function claimHype(who: XUser) {
  if (!faucet) return { status: "fallback" };
  const gas = () => chain.getBalance({ address: faucet.account.address });
  const hype = await payOnce("hype_claims", who, "0.2", async () => {
    const balance = await gas();
    if (balance < FAUCET_AMOUNT + FAUCET_GAS_RESERVE) console.error(`ftf: faucet low on HYPE: ${balance} wei`);
    return balance >= FAUCET_AMOUNT + FAUCET_GAS_RESERVE;
  }, (nonce) => faucet.sendTransaction({ to: who.wallet, value: FAUCET_AMOUNT, nonce }));
  const amount = parseUnits(FAUCET_USDC, 6);
  const usdcPay = await payOnce("usdc_claims", who, FAUCET_USDC, async () => {
    const [held, balance] = await Promise.all([
      chain.readContract({ address: await usdc(), abi: erc20Abi, functionName: "balanceOf", args: [faucet.account.address] }),
      gas(),
    ]);
    if (held < amount) console.error(`ftf: faucet low on USDC: ${held}`);
    return held >= amount && balance >= FAUCET_GAS_RESERVE;
  }, async (nonce) => faucet.writeContract({ address: await usdc(), abi: erc20Abi, functionName: "transfer", args: [who.wallet as `0x${string}`, amount], nonce }));
  const hypeTx = hype.status === "sent" ? hype.tx : undefined;
  const usdcTx = usdcPay.status === "sent" ? usdcPay.tx : undefined;
  if (hype.status === "unavailable") return { status: "fallback", usdcTx }; // the app asks the team for the HYPE
  if (hypeTx || usdcTx) return { status: "sent", tx: hypeTx ?? usdcTx, hypeTx, usdcTx };
  if (usdcPay.status === "unavailable") fail(503, "The test USDC faucet is empty right now. Try again later.");
  return { status: "claimed" };
}

async function isHypeAdmin(who: XUser) {
  const { data, error } = await db.from("app_config").select("value").eq("key", "hype_admins").maybeSingle();
  if (error) dbError("hype admins", error.message);
  return String(data?.value ?? "").split(",").map((s) => s.trim()).includes(who.xUserId);
}

async function latestHype(who: XUser) {
  const { data, error } = await db.from("hype_requests").select("status, created_at, done_at").eq("x_user_id", who.xUserId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) dbError("hype latest", error.message);
  return data;
}

async function hypeStatus(who: XUser) {
  const r = await latestHype(who);
  const [claimed, usdcClaimed] = await Promise.all([claimedIn("hype_claims", who), claimedIn("usdc_claims", who)]);
  return { status: r?.status ?? "none", at: r ? (r.done_at ?? r.created_at) : null, claimed, usdcClaimed };
}

async function hype(who: XUser) {
  const r = await latestHype(who);
  if (r?.status === "pending") return hypeStatus(who);
  if (r?.status === "sent" && Date.now() - Date.parse(r.done_at) < HYPE_AGAIN_MS) fail(429, "HYPE was sent to you in the last 24 hours");
  const { error } = await db.from("hype_requests").insert({ x_user_id: who.xUserId, wallet: who.wallet.toLowerCase() });
  if (error && error.code !== "23505") dbError("hype insert", error.message); // 23505: a pending one already exists
  return hypeStatus(who);
}

async function hypeDone(who: XUser, body: Body) {
  if (!(await isHypeAdmin(who))) fail(403, "Only an admin can do that");
  const id = Number(body.id);
  if (!Number.isSafeInteger(id)) fail(400, "Unknown request");
  const { error } = await db.from("hype_requests").update({ status: body.sent ? "sent" : "dismissed", done_at: new Date().toISOString() })
    .eq("id", id).eq("status", "pending");
  if (error) dbError("hype done", error.message);
  return { ok: true };
}

/** Admins only: open HYPE requests, as inbox items. */
async function hypeNotices(who: XUser) {
  if (!(await isHypeAdmin(who))) return [];
  const { data, error } = await db.from("hype_requests").select("id, x_user_id, wallet, created_at").eq("status", "pending")
    .order("created_at", { ascending: false }).limit(50);
  if (error) dbError("hype inbox", error.message);
  const cards = await cardsOf((data ?? []).map((r) => r.x_user_id as string));
  return (data ?? []).map((r) => ({
    kind: "hype", id: r.id, wallet: r.wallet, from: { x_user_id: r.x_user_id, ...cards.get(r.x_user_id) }, at: r.created_at,
  }));
}

const ACTIONS: Record<string, (who: XUser, body: Body) => Promise<unknown>> = {
  create, mine, inbox, profile, pfp, invite, request, approve, accept, decline, leave, remove, cancel, pass,
  hypeStatus, hype, hypeDone, claimHype,
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
