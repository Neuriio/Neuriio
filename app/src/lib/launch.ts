// Launch ("Tokenize yourself"): categories, curve math for the first-buy estimate, the launch-pass backend call and
// the NeuriioPad transaction (priced in USDC). Mirrors src/launch/NeuriioPad.sol and supabase/functions/launch-pass.
import { createPublicClient, erc20Abi, formatUnits, http, type Transport, keccak256, parseAbi, parseEther, parseUnits, toBytes, type Address, type EIP1193Provider } from "viem";
import { elysiumTestnet } from "../chain";
import { deployment, ELYSIUM_RPC, QUOTE, SUPABASE_URL } from "./config";
import { confirmed, nonceAfter, walletClientFor } from "./tx";

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

/** What the app calls on the NeuriioPad (src/launch/NeuriioPad.sol): launching and views (trades go through the
 *  NeuriioRouter, lib/trade.ts). */
export const launchpadAbi = parseAbi([
  "struct LaunchPass { address creator; uint64 xUserId; string handle; uint8 category; bytes32 profileHash; uint256 deadline; }",
  "function launch(LaunchPass pass, bytes signature, uint256 quoteIn, uint256 minTokensOut) returns (address)",
  "struct FtfPass { address founder; string name; string ticker; uint64[4] memberXIds; address[4] members; bytes32 profileHash; uint256 deadline; }",
  "function launchFtf(FtfPass pass, bytes signature, uint256 quoteIn, uint256 minTokensOut) returns (address)",
  "function virtualQuote() view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function curves(address) view returns (address creator, bool graduated, uint128 virtualQuote, uint128 virtualToken, uint128 realQuote, uint128 realToken)",
  "function profile(address) view returns ((uint64 xUserId, uint8 category, bytes32 profileHash, string handle))",
  "function isFtf(address) view returns (bool)",
  "function ftf(address) view returns ((string name, bytes32 profileHash, uint64[4] memberXIds, address[4] members))",
]);

/** Elysium's public RPC (a Conduit node) rate-limits each visitor: HTTP 429 / JSON-RPC code -32017 "Rate Limit
 *  Exceeded" (2026-10-18: about 1 request in 4 when a page is busy). viem doesn't retry that code, so a rate-limited
 *  read failed at once ("RPC Request failed."): wait a little and ask again. */
const isRateLimited = (e: unknown) => /Rate Limit|-32017|\b429\b/i.test(`${(e as Error)?.message} ${(e as { details?: string })?.details ?? ""}`);
const patient = (base: Transport): Transport => (opts) => {
  const t = base(opts);
  return {
    ...t,
    request: (async (args: Parameters<typeof t.request>[0]) => {
      for (let i = 0; ; i++) {
        try {
          return await t.request(args);
        } catch (e) {
          if (i === 4 || !isRateLimited(e)) throw e;
          await new Promise((r) => setTimeout(r, 200 * 2 ** i + Math.random() * 200)); // 0.2, 0.4, 0.8, 1.6 s
        }
      }
    }) as typeof t.request,
  };
};

// The app's one reader for Elysium. pollingInterval: Elysium makes a block every ~0.16 s; viem's default without a
// known block time polls every 4 s, which held every "confirmed" (and the balance refresh after a trade) back by up to
// 4 s; 300 ms asked the rate-limited RPC too often, 750 ms still confirms within a second. batch.multicall: contract
// reads made in the same moment (balances, stake card, positions, quotes...) go out as one multicall, so the page asks
// the RPC far less often.
export const pub = createPublicClient({
  chain: elysiumTestnet,
  transport: patient(http(ELYSIUM_RPC, { timeout: 10_000, retryCount: 2 })),
  batch: { multicall: { wait: 16 } },
  pollingInterval: 750,
});

/** The current pad's curve: its starting virtual USDC reserve (whole USDC) and fee. */
export type CurveParams = { virtualQuote: number; feeBps: number };

export async function fetchCurveParams(): Promise<CurveParams> {
  const [vq, fee] = await Promise.all([
    pub.readContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "virtualQuote" }),
    pub.readContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "feeBps" }),
  ]);
  return { virtualQuote: Number(formatUnits(vq, QUOTE.decimals)), feeBps: fee };
}

/** Tokens a fresh curve gives for `value` USDC (fee inside, like NeuriioPad._quoteBuy). */
export function estimateFirstBuy(value: number, p: CurveParams) {
  if (!(value > 0)) return { tokens: 0, pctOfSupply: 0, fee: 0 };
  const fee = (value * p.feeBps) / (10_000 + p.feeBps);
  const quoteIn = value - fee;
  const tokens = Math.min(CURVE_SUPPLY, VIRTUAL_TOKENS - (p.virtualQuote * VIRTUAL_TOKENS) / (p.virtualQuote + quoteIn));
  return { tokens, pctOfSupply: (tokens / TOTAL) * 100, fee };
}

/** Where a first buy of `value` leaves the curve, 0..1 of the 793.1M for sale (for the preview chart). */
export const curveProgress = (value: number, p: CurveParams) => estimateFirstBuy(value, p).tokens / CURVE_SUPPLY;

/** Fully diluted market cap at graduation, in USDC (= virtualQuote x ~13.7). */
export const graduationMcap = (p: CurveParams) =>
  (p.virtualQuote * (VIRTUAL_TOKENS / (VIRTUAL_TOKENS - CURVE_SUPPLY)) * TOTAL) / (VIRTUAL_TOKENS - CURVE_SUPPLY);

export async function launchedTokenOf(wallet: Address): Promise<Address | null> {
  const t = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "tokenOfCreator", args: [wallet] });
  return /^0x0{40}$/i.test(t) ? null : t;
}

export type LaunchPassResponse = {
  pass: { creator: Address; xUserId: string; handle: string; category: number; profileHash: `0x${string}`; deadline: string };
  signature: `0x${string}`;
  launchpad: Address; // the NeuriioPad the pass is signed for
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

/** The first buy in USDC base units, and its `minTokensOut` (2% for someone buying first in the same block). */
function firstBuy(usdc: number, p: CurveParams) {
  if (!(usdc > 0)) return { quoteIn: 0n, minOut: 0n };
  const est = estimateFirstBuy(usdc, p).tokens;
  return { quoteIn: parseUnits(usdc.toFixed(QUOTE.decimals), QUOTE.decimals), minOut: parseEther(String(Math.floor(est * 0.98))) };
}

/** Arguments for NeuriioPad.launch, plus the USDC the first buy needs approved to the pad (`quoteIn`). */
export function launchArgs(r: LaunchPassResponse, firstBuyUsdc: number, p: CurveParams) {
  const { quoteIn, minOut } = firstBuy(firstBuyUsdc, p);
  const pass = { ...r.pass, xUserId: BigInt(r.pass.xUserId), deadline: BigInt(r.pass.deadline) };
  return { args: [pass, r.signature, quoteIn, minOut] as const, quoteIn };
}

/** Arguments for NeuriioPad.launchFtf (same first-buy handling as `launchArgs`). */
export function launchFtfArgs(
  r: { pass: { founder: Address; name: string; ticker: string; memberXIds: string[]; members: Address[]; profileHash: `0x${string}`; deadline: string }; signature: `0x${string}` },
  firstBuyUsdc: number,
  p: CurveParams,
) {
  const { quoteIn, minOut } = firstBuy(firstBuyUsdc, p);
  const pass = {
    ...r.pass,
    memberXIds: r.pass.memberXIds.map(BigInt) as unknown as readonly [bigint, bigint, bigint, bigint],
    members: r.pass.members as unknown as readonly [Address, Address, Address, Address],
    deadline: BigInt(r.pass.deadline),
  };
  return { args: [pass, r.signature, quoteIn, minOut] as const, quoteIn };
}

/** A pass is only valid on the pad it was signed for: until go-live the backend still signs for the HYPE world's. */
export function checkPassPad(launchpad: string | undefined) {
  if (launchpad && launchpad.toLowerCase() !== LAUNCHPAD.toLowerCase()) {
    throw new Error("Launch passes are still signed for the old launchpad: launching opens at go-live.");
  }
}

/** USDC (base units) and gas HYPE (wei) in a wallet, for the first buy. */
export async function launchBalances(wallet: Address) {
  const [usdc, gas] = await Promise.all([
    pub.readContract({ address: QUOTE.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
    pub.getBalance({ address: wallet }),
  ]);
  return { usdc, gas };
}

/** Approves the pad for the first buy's USDC if it isn't already (the wallet sends it silently). Returns the nonce for
 *  the launch when it sent one (see nonceAfter), else undefined. */
export async function approveFirstBuy(provider: EIP1193Provider, account: Address, quoteIn: bigint) {
  if (quoteIn === 0n) return undefined;
  const allowance = await pub.readContract({ address: QUOTE.address, abi: erc20Abi, functionName: "allowance", args: [account, LAUNCHPAD] });
  if (allowance >= quoteIn) return undefined;
  const hash = await walletClientFor(provider, account).writeContract({ address: QUOTE.address, abi: erc20Abi, functionName: "approve", args: [LAUNCHPAD, quoteIn] });
  await confirmed(hash);
  return nonceAfter(hash);
}

/** The launched FTF token for a ticker (or null). */
export async function ftfTokenOf(ticker: string): Promise<Address | null> {
  const t = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "tokenOfFtfTicker", args: [keccak256(toBytes(ticker))] });
  return /^0x0{40}$/i.test(t) ? null : t;
}
