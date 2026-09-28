// Launch ("Tokenize yourself"): categories, curve math for the first-buy estimate, the launch-pass backend call and
// the Launchpad transaction. Mirrors src/launch/Launchpad.sol and supabase/functions/launch-pass.
import { createPublicClient, fallback, formatEther, http, parseAbi, parseEther, type Address } from "viem";
import { elysiumTestnet } from "../chain";
import { deployment, ELYSIUM_RPCS, SUPABASE_URL } from "./config";

export const LAUNCHPAD = deployment.launchpad as Address;

export const CATEGORIES = [
  { id: "trader", label: "Trader", hint: "Perps, spot, PnL receipts" },
  { id: "meme_trader", label: "Meme Trader", hint: "Onchain degen, early calls" },
  { id: "researcher", label: "Researcher", hint: "Threads, reports, alpha" },
  { id: "influencer", label: "Influencer", hint: "Reach, community, vibes" },
  { id: "builder", label: "Builder", hint: "Ships code and products" },
  { id: "creator", label: "Creator", hint: "Art, music, content" },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]["id"];

export const ABOUT_MIN = 50;
export const ABOUT_MAX = 5000;
export const MAX_LINKS = 10;

// curve constants (Launchpad.sol)
const TOTAL = 1_000_000_000;
const CURVE_SUPPLY = 793_100_000;
const VIRTUAL_TOKENS = 1_073_000_000;

export const launchpadAbi = parseAbi([
  "struct LaunchPass { address creator; uint64 xUserId; string handle; uint8 category; bytes32 profileHash; uint256 deadline; }",
  "function launch(LaunchPass pass, bytes signature, uint256 minTokensOut) payable returns (address)",
  "function virtualHype() view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function tokenOfCreator(address) view returns (address)",
]);

export const pub = createPublicClient({ chain: elysiumTestnet, transport: fallback(ELYSIUM_RPCS.map((u) => http(u))) });

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
  const t = await pub.readContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "tokenOfCreator", args: [wallet] });
  return /^0x0{40}$/i.test(t) ? null : t;
}

export type LaunchPassResponse = {
  pass: { creator: Address; xUserId: string; handle: string; category: number; profileHash: `0x${string}`; deadline: string };
  signature: `0x${string}`;
};

/** Our backend checks the X login and signs the one-time launch pass. */
export async function requestLaunchPass(
  accessToken: string,
  body: { category: CategoryId; profile: { about: string; links: { label: string; url: string }[] } },
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
