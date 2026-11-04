// Launch ("Tokenize yourself"): categories, the first-buy estimate, the launch-pass backend call and the NeuriioLauncher
// transaction (priced in USDC): our launcher checks the pass and launches the token into Ascend's pool through the adapter
// (src/launch/NeuriioLauncher.sol, AscendAdapter.sol; supabase/functions/launch-pass).
import { createPublicClient, erc20Abi, fallback, formatUnits, http, type Transport, keccak256, parseAbi, parseEther, parseUnits, toBytes, type Address, type EIP1193Provider } from "viem";
import { elysiumTestnet } from "../chain";
import { ASCEND, ELYSIUM_RPC, LAUNCHER, PUBLIC_RPC, QUOTE, SUPABASE_URL } from "./config";
import { confirmed, nonceAfter, walletClientFor } from "./tx";

/** NeuriioLauncher: where launches go, and the permanent record of identity (one token per X account / wallet / handle, FTF
 *  tickers). Both old names point at it: LAUNCHPAD (launching) and REGISTRY (lookups). */
export const LAUNCHPAD = LAUNCHER;
export const REGISTRY = LAUNCHER;
export const registryAbi = parseAbi([
  "function tokenOfCreator(address) view returns (address)",
  "function tokenOfHandle(bytes32) view returns (address)",
  "function tokenOfFtfTicker(bytes32) view returns (address)",
  "function tokenOfXUser(uint64) view returns (address)",
]);

export const CATEGORIES = [
  { id: "trader", label: "Trader", hint: "Perps, spot, PnL receipts" },
  { id: "meme_trader", label: "Meme Trader", hint: "Onchain degen, early calls" },
  { id: "researcher", label: "Researcher", hint: "Threads, reports, alpha" },
  { id: "influencer", label: "Influencer", hint: "Reach, community, vibes" },
  { id: "builder", label: "Builder", hint: "Ships code and products" },
  { id: "creator", label: "Creator", hint: "Art, music, content" },
  { id: "meme_account", label: "Meme Account", hint: "A meme launching its main X account" },
  { id: "founders", label: "Founders", hint: "An app or protocol launching here" },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]["id"];

/** Older tokens' sectors, for showing them: launches no longer ask (user, 2026-11-01). Off-chain: part of the hashed profile (supabase/functions/_shared/launchPass.ts). */
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

/** What the app calls on NeuriioLauncher: launching and views. Trades go through Ascend's router (lib/trade.ts). */
export const launchpadAbi = parseAbi([
  "struct LaunchPass { address creator; uint64 xUserId; string handle; uint8 category; bytes32 profileHash; bytes launchData; uint256 deadline; }",
  "function launch(LaunchPass pass, bytes signature, uint256 quoteIn, uint256 minTokensOut) returns (address)",
  "struct FtfPass { address founder; string name; string ticker; uint64[4] memberXIds; address[4] members; bytes32 profileHash; bytes launchData; uint256 deadline; }",
  "function launchFtf(FtfPass pass, bytes signature, uint256 quoteIn, uint256 minTokensOut) returns (address)",
  "struct Launch { address creator; uint64 xUserId; uint8 category; bytes32 profileHash; bytes32 pool; string handle; }",
  "function launchOf(address token) view returns (Launch)",
  "function isFtf(address) view returns (bool)",
  "function ftf(address) view returns ((string name, uint64[4] memberXIds, address[4] members))",
]);
const ascendViews = parseAbi(["function quoteConfig(address quote) view returns ((bool allowed, int24 startTick, uint128 maxClip))"]);

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
// transport: the keyless public RPC first, failing fast (no retries, 1.5 s timeout: a rate limit or a stall goes straight
// to the backup), then our Conduit key (patient with rate limits). A revert is a real answer and doesn't fall over.
// With no public URL configured (PUBLIC_RPC null, or equal to ours), only our key.
// Around this browser's own transactions (`viaKey` while waiting for the receipt, then `keyedFor` a few seconds after)
// every read goes straight to the key: the public RPC is a different node and can be a block behind, which would show
// the old balance until the follow-up read. That's a handful of calls per trade, so it costs the key very little.
let keyedHolds = 0;
let keyedUntil = 0;
const preferKeyed = () => keyedHolds > 0 || Date.now() < keyedUntil;
/** Send every read through our key for the next `ms`. */
export function keyedFor(ms: number) {
  keyedUntil = Math.max(keyedUntil, Date.now() + ms);
}
/** Run `f` with every read going through our key (e.g. waiting for a receipt). */
export async function viaKey<T>(f: () => Promise<T>): Promise<T> {
  keyedHolds++;
  try {
    return await f();
  } finally {
    keyedHolds--;
  }
}
const keyed = patient(http(ELYSIUM_RPC, { timeout: 10_000, retryCount: 2 }));
const publicFirst = (pub: string): Transport => (opts) => {
  const both = fallback([http(pub, { timeout: 1_500, retryCount: 0 }), keyed])(opts);
  const direct = keyed(opts);
  return { ...both, request: ((args: Parameters<typeof both.request>[0]) => (preferKeyed() ? direct : both).request(args)) as typeof both.request };
};
export const pub = createPublicClient({
  chain: elysiumTestnet,
  transport: PUBLIC_RPC && PUBLIC_RPC !== ELYSIUM_RPC ? publicFirst(PUBLIC_RPC) : keyed,
  batch: { multicall: { wait: 16 } },
  pollingInterval: 750,
});

/** A new token's opening price on Ascend (USDC per whole token, from the USDC pair's start tick) and the fee (1.5%). */
export type CurveParams = { startPrice: number; feeBps: number };

export async function fetchCurveParams(): Promise<CurveParams> {
  const { startTick } = await pub.readContract({ address: ASCEND.launchpad, abi: ascendViews, functionName: "quoteConfig", args: [QUOTE.address] });
  // ASSUMPTION until checked on the mainnet fork: the start tick prices the coin in the pair asset (coin as currency0)
  const raw = 1.0001 ** startTick; // USDC base units per token wei
  return { startPrice: raw * 10 ** (18 - QUOTE.decimals), feeBps: 150 };
}

/** About how many tokens `value` USDC buys at the opening price, fee taken off (price impact ignored: an estimate). */
export function estimateFirstBuy(value: number, p: CurveParams) {
  if (!(value > 0) || !(p.startPrice > 0)) return { tokens: 0, pctOfSupply: 0, fee: 0 };
  const fee = (value * p.feeBps) / 10_000;
  const tokens = Math.min(1_000_000_000, (value - fee) / p.startPrice);
  return { tokens, pctOfSupply: tokens / 1e7, fee };
}

export async function launchedTokenOf(wallet: Address): Promise<Address | null> {
  const t = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "tokenOfCreator", args: [wallet] });
  return /^0x0{40}$/i.test(t) ? null : t;
}

export type LaunchPassResponse = {
  pass: { creator: Address; xUserId: string; handle: string; category: number; profileHash: `0x${string}`; launchData: `0x${string}`; deadline: string };
  signature: `0x${string}`;
  launchpad: Address; // the NeuriioLauncher the pass is signed for
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

/** The first buy in USDC base units, and its `minTokensOut`: 1 wei, because the buy runs in the same transaction that
 *  creates the pool, so nobody can trade ahead of it. */
function firstBuy(usdc: number, _p?: CurveParams) {
  if (!(usdc > 0)) return { quoteIn: 0n, minOut: 0n };
  return { quoteIn: parseUnits(usdc.toFixed(QUOTE.decimals), QUOTE.decimals), minOut: 1n };
}

/** Arguments for NeuriioLauncher.launch, plus the USDC the first buy needs approved to the launcher (`quoteIn`). */
export function launchArgs(r: LaunchPassResponse, firstBuyUsdc: number, p: CurveParams) {
  const { quoteIn, minOut } = firstBuy(firstBuyUsdc, p);
  const pass = { ...r.pass, xUserId: BigInt(r.pass.xUserId), deadline: BigInt(r.pass.deadline) };
  return { args: [pass, r.signature, quoteIn, minOut] as const, quoteIn };
}

/** Arguments for NeuriioLauncher.launchFtf (same first-buy handling as `launchArgs`). */
export function launchFtfArgs(
  r: { pass: { founder: Address; name: string; ticker: string; memberXIds: string[]; members: Address[]; profileHash: `0x${string}`; launchData: `0x${string}`; deadline: string }; signature: `0x${string}` },
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

/** A pass is only valid on the launcher it was signed for (the backend's LAUNCHER setting must match ours). */
export function checkPassPad(launchpad: string | undefined) {
  if (launchpad && launchpad.toLowerCase() !== LAUNCHPAD.toLowerCase()) {
    throw new Error("Launch passes are signed for a different launcher: launching opens at go-live.");
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

/** Approves the launcher for the first buy's USDC if it isn't already (the wallet sends it silently). Returns the nonce for
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
