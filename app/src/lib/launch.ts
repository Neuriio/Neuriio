// Launch ("Tokenize yourself"): categories, curve math for the first-buy estimate, the launch-pass backend call and
// the Launchpad transaction. Mirrors src/launch/Launchpad.sol and supabase/functions/launch-pass.
import { createPublicClient, fallback, formatEther, http, keccak256, parseAbi, parseEther, toBytes, type Address } from "viem";
import { elysiumTestnet } from "../chain";
import { deployment, ELYSIUM_RPCS, SUPABASE_URL } from "./config";

/** The CURRENT Launchpad version: new launches go here. Existing tokens trade on their own version (TokenStat.launchpad). */
export const LAUNCHPAD = deployment.launchpad as Address;
/** The permanent LaunchRegistry: identity (one token per X account / wallet / handle, FTF tickers) and each token's
 *  Launchpad version, across every version (src/launch/LaunchRegistry.sol). */
export const REGISTRY = deployment.launchRegistry as Address;
export const registryAbi = parseAbi([
  "function tokenOfCreator(address) view returns (address)",
  "function tokenOfHandle(bytes32) view returns (address)",
  "function tokenOfFtfTicker(bytes32) view returns (address)",
  "function launchpadOf(address) view returns (address)",
]);

export const CATEGORIES = [
  { id: "trader", label: "Trader", hint: "Perps, spot, PnL receipts" },
  { id: "meme_trader", label: "Meme Trader", hint: "Onchain degen, early calls" },
  { id: "researcher", label: "Researcher", hint: "Threads, reports, alpha" },
  { id: "influencer", label: "Influencer", hint: "Reach, community, vibes" },
  { id: "builder", label: "Builder", hint: "Ships code and products" },
  { id: "creator", label: "Creator", hint: "Art, music, content" },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]["id"];

/** "What sector are you?" (2026-09-30). Off-chain: part of the hashed profile (supabase/functions/_shared/launchPass.ts). */
export const SECTORS = [
  { id: "robotics", label: "Robotics", hint: "Machines, automation, hardware" },
  { id: "quantum", label: "Quantum", hint: "Qubits, physics, deep tech" },
  { id: "finance", label: "Finance", hint: "Markets, DeFi, money" },
  { id: "ai", label: "AI", hint: "Models, agents, compute" },
  { id: "energy", label: "Energy", hint: "Power, grids, climate" },
  { id: "memory", label: "Memory", hint: "Chips, storage, data" },
  { id: "space", label: "Space", hint: "Launches, satellites, beyond" },
] as const;
export type SectorId = (typeof SECTORS)[number]["id"];

export const ABOUT_MIN = 50;
export const ABOUT_MAX = 5000;
export const MAX_LINKS = 10;

// curve constants (Launchpad.sol)
const TOTAL = 1_000_000_000;
const CURVE_SUPPLY = 793_100_000;
const VIRTUAL_TOKENS = 1_073_000_000;

/** Everything the app calls on the Launchpad (src/launch/Launchpad.sol): launching, curve trades, views. */
export const launchpadAbi = parseAbi([
  "struct LaunchPass { address creator; uint64 xUserId; string handle; uint8 category; bytes32 profileHash; uint256 deadline; }",
  "function launch(LaunchPass pass, bytes signature, uint256 minTokensOut) payable returns (address)",
  "struct FtfPass { address founder; string name; string ticker; uint64[4] memberXIds; address[4] members; bytes32 profileHash; uint256 deadline; }",
  "function launchFtf(FtfPass pass, bytes signature, uint256 minTokensOut) payable returns (address)",
  "function buy(address token, uint256 minTokensOut, uint256 deadline) payable returns (uint256)",
  "function sell(address token, uint256 tokensIn, uint256 minHypeOut, uint256 deadline) returns (uint256)",
  "function previewBuy(address token, uint256 value) view returns (uint256 tokensOut, uint256 hypeIn, uint256 fee, uint256 refund)",
  "function previewSell(address token, uint256 tokensIn) view returns (uint256 hypeOut, uint256 fee)",
  "function virtualHype() view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function curves(address) view returns (address creator, bool graduated, uint128 virtualHype, uint128 virtualToken, uint128 realHype, uint128 realToken)",
  "function profile(address) view returns ((uint64 xUserId, uint8 category, bytes32 profileHash, string handle))",
  "function isFtf(address) view returns (bool)",
  "function ftf(address) view returns ((string name, bytes32 profileHash, uint64[4] memberXIds, address[4] members))",
]);

// pollingInterval: Elysium makes a block every ~0.16 s; viem's default without a known block time polls every 4 s, which
// held every "confirmed" (and the balance refresh after a trade) back by up to 4 s
export const pub = createPublicClient({
  chain: elysiumTestnet,
  transport: fallback(ELYSIUM_RPCS.map((u) => http(u))),
  pollingInterval: 300,
});

export type CurveParams = { virtualHype: number; feeBps: number };

export async function fetchCurveParams(): Promise<CurveParams> {
  const [vh, fee] = await Promise.all([
    pub.readContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "virtualHype" }),
    pub.readContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "feeBps" }),
  ]);
  return { virtualHype: Number(formatEther(vh)), feeBps: fee };
}

/** Tokens a fresh curve gives for `value` HYPE sent (fee inside, like Launchpad._quoteBuy). */
export function estimateFirstBuy(value: number, p: CurveParams) {
  if (!(value > 0)) return { tokens: 0, pctOfSupply: 0, fee: 0 };
  const fee = (value * p.feeBps) / (10_000 + p.feeBps);
  const hypeIn = value - fee;
  const tokens = Math.min(CURVE_SUPPLY, VIRTUAL_TOKENS - (p.virtualHype * VIRTUAL_TOKENS) / (p.virtualHype + hypeIn));
  return { tokens, pctOfSupply: (tokens / TOTAL) * 100, fee };
}

/** Where a first buy of `value` leaves the curve, 0..1 of the 793.1M for sale (for the preview chart). */
export const curveProgress = (value: number, p: CurveParams) => estimateFirstBuy(value, p).tokens / CURVE_SUPPLY;

/** Fully diluted market cap at graduation, in HYPE (= virtualHype x ~13.7). */
export const graduationMcapHype = (p: CurveParams) =>
  (p.virtualHype * (VIRTUAL_TOKENS / (VIRTUAL_TOKENS - CURVE_SUPPLY)) * TOTAL) / (VIRTUAL_TOKENS - CURVE_SUPPLY);

export async function launchedTokenOf(wallet: Address): Promise<Address | null> {
  const t = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "tokenOfCreator", args: [wallet] });
  return /^0x0{40}$/i.test(t) ? null : t;
}

export type LaunchPassResponse = {
  pass: { creator: Address; xUserId: string; handle: string; category: number; profileHash: `0x${string}`; deadline: string };
  signature: `0x${string}`;
};

/** Our backend checks the X login and signs the one-time launch pass. */
export async function requestLaunchPass(
  accessToken: string,
  body: { sector: SectorId; category: CategoryId; profile: { about: string; links: { label: string; url: string }[] } },
): Promise<LaunchPassResponse> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/launch-pass`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Launch pass failed (${res.status})`);
  return data;
}

/** Arguments for Launchpad.launch; `minTokensOut` allows 2% for someone buying first in the same block. */
export function launchArgs(r: LaunchPassResponse, firstBuyHype: number, p: CurveParams) {
  const est = estimateFirstBuy(firstBuyHype, p).tokens;
  const minOut = firstBuyHype > 0 ? parseEther(String(Math.floor(est * 0.98))) : 0n;
  const pass = { ...r.pass, xUserId: BigInt(r.pass.xUserId), deadline: BigInt(r.pass.deadline) };
  return { args: [pass, r.signature, minOut] as const, value: firstBuyHype > 0 ? parseEther(String(firstBuyHype)) : 0n };
}

/** Arguments for Launchpad.launchFtf (same first-buy handling as `launchArgs`). */
export function launchFtfArgs(
  r: { pass: { founder: Address; name: string; ticker: string; memberXIds: string[]; members: Address[]; profileHash: `0x${string}`; deadline: string }; signature: `0x${string}` },
  firstBuyHype: number,
  p: CurveParams,
) {
  const est = estimateFirstBuy(firstBuyHype, p).tokens;
  const minOut = firstBuyHype > 0 ? parseEther(String(Math.floor(est * 0.98))) : 0n;
  const pass = {
    ...r.pass,
    memberXIds: r.pass.memberXIds.map(BigInt) as unknown as readonly [bigint, bigint, bigint, bigint],
    members: r.pass.members as unknown as readonly [Address, Address, Address, Address],
    deadline: BigInt(r.pass.deadline),
  };
  return { args: [pass, r.signature, minOut] as const, value: firstBuyHype > 0 ? parseEther(String(firstBuyHype)) : 0n };
}

/** The launched FTF token for a ticker (or null). */
export async function ftfTokenOf(ticker: string): Promise<Address | null> {
  const t = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "tokenOfFtfTicker", args: [keccak256(toBytes(ticker))] });
  return /^0x0{40}$/i.test(t) ? null : t;
}
