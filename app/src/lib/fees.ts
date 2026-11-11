// Creator fees on Ascend (user, 2026-11-07): what a token's creator has earned, for our launches and Ascend's top tokens alike.
// The indexer (supabase/functions/indexer/creatorFees.ts) reads each token's CreatorEscrow every 5 minutes into creator_fees:
// the sum of its Credited amounts plus what's held back below Ascend's $40k market cap. Credited is BOOKED to the creator, not
// sent: it stays in the escrow until claimed (see "Claiming" below). Lifetime figures only read that table: no RPC per visitor.
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";
import { parseAbi, type Address, type EIP1193Provider } from "viem";
import { launchedTokenOf, pub } from "./launch";
import { confirmed, walletClientFor } from "./tx";

export type CreatorFees = {
  /** Lifetime creator earnings in USD (paid out + held), at the indexer's last run. */
  usd: number;
  /** The held part's share of it (0..1): forfeited if the token doesn't qualify within Ascend's 14 days. */
  heldShare: number;
};

/** A token's creator fees, or null when the indexer doesn't track it (yet). Kept a minute per token. */
const cache = new Map<string, { at: number; p: Promise<CreatorFees | null> }>();
export function creatorFees(token: string): Promise<CreatorFees | null> {
  const k = token.toLowerCase();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = fetch(`${SUPABASE_URL}/rest/v1/creator_fees?token=eq.${k}&select=earned_usd,credited,held`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
  })
    .then((r) => (r.ok ? r.json() : []))
    .then((rows: { earned_usd: number | string; credited: number | string; held: number | string }[]) => {
      const r = rows[0];
      if (!r) return null;
      const credited = Number(r.credited);
      const held = Number(r.held);
      return { usd: Number(r.earned_usd), heldShare: credited + held > 0 ? held / (credited + held) : 0 };
    })
    .catch(() => null);
  cache.set(k, { at: Date.now(), p });
  return p;
}

// ---- Claiming (user, 2026-11-11) ----
// Ascend's CreatorEscrow does NOT pay creators by itself: each settle books `credits(account)` and the USDC stays in the escrow
// until someone calls `claim(account)` (anyone may; it always pays `account`). The account panel shows what's waiting and
// sends that claim from the creator's Neuriio wallet. Amounts are read live from the escrow, not from creator_fees.

const escrowAbi = parseAbi([
  "function claimable(address account) view returns (uint256)",
  "function held() view returns (uint256)",
  "function deadline() view returns (uint256)",
  "function recipient() view returns (address)",
  "function claim(address account) returns (uint256)",
]);

export type CreatorClaim = {
  token: Address;
  escrow: Address;
  /** USDC base units ready to claim now. */
  claimable: bigint;
  /** USDC base units Ascend holds until the token reaches a $40k market cap (paid to the creator then, lost after `deadline`). */
  held: bigint;
  /** When the held part is forfeited if the token hasn't qualified (unix seconds); 0 when there's nothing held. */
  deadline: number;
};

/** The escrow of a token we index (creator_fees.escrow), remembered: it never changes. */
const escrowOf = new Map<string, Address | null>();
async function escrowFor(token: Address): Promise<Address | null> {
  const k = token.toLowerCase();
  if (escrowOf.has(k)) return escrowOf.get(k)!;
  const rows: { escrow: string }[] = await fetch(`${SUPABASE_URL}/rest/v1/creator_fees?token=eq.${k}&select=escrow`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
  }).then((r) => (r.ok ? r.json() : []));
  const e = (rows[0]?.escrow as Address | undefined) ?? null;
  if (e) escrowOf.set(k, e); // a miss isn't remembered: a fresh launch gets its row within ~5 minutes
  return e;
}

/** What `wallet` can claim as a creator, or null when it hasn't launched a token (or the indexer hasn't found its escrow yet). */
export async function creatorClaim(wallet: Address): Promise<CreatorClaim | null> {
  const token = await launchedTokenOf(wallet);
  if (!token) return null;
  const escrow = await escrowFor(token);
  if (!escrow) return null;
  const e = { address: escrow, abi: escrowAbi } as const;
  const [claimable, held, deadline] = await Promise.all([
    pub.readContract({ ...e, functionName: "claimable", args: [wallet] }),
    pub.readContract({ ...e, functionName: "held" }),
    pub.readContract({ ...e, functionName: "deadline" }),
  ]);
  return { token, escrow, claimable, held, deadline: held > 0n ? Number(deadline) : 0 };
}

/** Sends the claim: everything `account` is owed by `escrow`, in USDC, to `account`. */
export async function claimCreatorFees(provider: EIP1193Provider, account: Address, escrow: Address) {
  await confirmed(await walletClientFor(provider, account).writeContract({ address: escrow, abi: escrowAbi, functionName: "claim", args: [account] }));
}
