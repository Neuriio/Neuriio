// Creator fees per token (user, 2026-11-07), for our launches and Ascend's top tokens on Explore -> creator_fees.
// Each Ascend pool has its own CreatorEscrow. Every settle emits Credited(creator, amount) and then pays it straight out, so
// "claimable" is nearly always ~0: lifetime earnings are the sum of Credited, plus held() (kept back under $40k mcap).
// cumulativeFees() is everything the pool has taken (the whole 1%).
// Cost (Alchemy, budget ~10-15M CU/month): runs every 5 minutes; one getLogs for all escrows per 10,000 blocks, plus one
// multicall for the views. A new token is backfilled from its launch block in 10,000-block steps (~140 for a coin from
// Ascend's first week), a few runs at most.
import { encodeAbiParameters, keccak256, parseAbi, parseAbiItem } from "npm:viem@2";
// deno-lint-ignore no-explicit-any
type Db = any;

const ZERO = "0x0000000000000000000000000000000000000000";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const ESCROW_FACTORY = (Deno.env.get("ESCROW_FACTORY") ?? "0x63f6a8A8d0257c0363251a50cdE8A8b1046e4d19") as `0x${string}`;
const HOOK = (Deno.env.get("LAUNCHPAD") ?? "0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC").toLowerCase() as `0x${string}`;
const WHYPE = "0xba876237b0f021a6c6d852d6c26e107997cc5e81";
const USDC = "0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65";
/** Our builder address: its share is paid with BuilderPaid, but never count it as the creator's if it's ever Credited. */
const BUILDER = (Deno.env.get("FEE_BUILDER") ?? "0xB153AA503a2C95fC175275D6b93415869A77e3d1").toLowerCase();
const ASCEND_FIRST_BLOCK = 422_319n; // Ascend's deployment: the start for a coin whose launch block we don't know
const AGORA_TOP = "https://api.agoradex.app/api/tokens?sort=volume&window=24h&launchpad=ascend&limit=15";

export const EVERY_MS = 5 * 60_000;
const STEP = 10_000n; // Alchemy's getLogs range limit
const RUN_MS = 20_000;

const credited = parseAbiItem("event Credited(address indexed account, uint256 amount)");
const factoryAbi = parseAbi(["function escrowOf(bytes32 poolId) view returns (address)"]);
const escrowAbi = parseAbi([
  "function held() view returns (uint256)",
  "function cumulativeFees() view returns (uint256)",
  "function recipient() view returns (address)",
]);

export type FeeRow = {
  token: string;
  pool_id: string;
  escrow: string;
  quote: string;
  quote_decimals: number;
  recipient: string | null;
  credited: string;
  held: string;
  total_fees: string;
  earned_usd: number;
  scanned_to: number;
  updated_at?: string;
};

/** An Ascend pool id: sorted currencies, dynamic fee, tick spacing 200, Ascend's launchpad as the hook. */
export function ascendPoolId(token: string, quote: string): `0x${string}` {
  const [c0, c1] = token.toLowerCase() < quote.toLowerCase() ? [token, quote] : [quote, token];
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [c0 as `0x${string}`, c1 as `0x${string}`, 0x800000, 200, HOOK],
  ));
}

/** USD per whole pair unit: USDC $1, WHYPE the HYPE price; null for other pairs. */
export function quoteUsd(quote: string, hypeUsd: number | null): number | null {
  const q = quote.toLowerCase();
  return q === USDC ? 1 : q === WHYPE ? hypeUsd : null;
}

/** (credited + held) in USD. */
export function earnedUsd(r: Pick<FeeRow, "credited" | "held" | "quote" | "quote_decimals">, hypeUsd: number | null): number {
  const usd = quoteUsd(r.quote, hypeUsd);
  if (usd == null) return 0;
  return (Number(BigInt(r.credited) + BigInt(r.held)) / 10 ** r.quote_decimals) * usd;
}

/** Sums each account's Credited per escrow, skipping the builder. */
export function sumCredited(logs: { address: string; args: { account?: string; amount?: bigint } }[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const l of logs) {
    if (l.args.account?.toLowerCase() === BUILDER) continue;
    const e = l.address.toLowerCase();
    out.set(e, (out.get(e) ?? 0n) + (l.args.amount ?? 0n));
  }
  return out;
}

/** The next range to scan: the rows furthest behind, up to 10,000 blocks, stopping at the next group so groups merge. */
export function nextRange(rows: { scanned_to: number }[], head: bigint): { from: bigint; to: bigint; group: number } | null {
  const marks = [...new Set(rows.map((r) => r.scanned_to))].sort((a, b) => a - b);
  if (!marks.length || BigInt(marks[0]) >= head) return null;
  const from = BigInt(marks[0]) + 1n;
  let to = from + STEP - 1n;
  if (to > head) to = head;
  if (marks.length > 1 && BigInt(marks[1]) < to) to = BigInt(marks[1]);
  return { from, to, group: marks[0] };
}

type Candidate = { token: string; pool_id: string; quote: string; quote_decimals: number; start: bigint };

/** Tokens to track: our launches plus Ascend's current top 15 (Agora's public feed), with their pools. */
async function candidates(db: Db, appRegistry: string, oursFrom: bigint): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const { data: ours } = await db.from("tokens").select("address, pair").eq("registry", appRegistry).not("pair", "is", null);
  for (const t of ours ?? []) out.push({ token: t.address, pool_id: t.pair.toLowerCase(), quote: USDC, quote_decimals: 6, start: oursFrom });

  const top: string[] = await fetch(AGORA_TOP, { headers: { accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : []))
    // deno-lint-ignore no-explicit-any
    .then((b: any) => (Array.isArray(b) ? b : b?.tokens ?? b?.data ?? []).map((t: { address: string }) => t.address.toLowerCase()))
    .catch(() => []);
  if (top.length) {
    const { data: known } = await db.from("ascend_tokens").select("address, pool_id, quote, quote_decimals, launch_block").in("address", top);
    const byAddr = new Map((known ?? []).map((k: { address: string }) => [k.address, k]));
    for (const a of top) {
      // deno-lint-ignore no-explicit-any
      const k: any = byAddr.get(a);
      out.push(k
        ? { token: a, pool_id: k.pool_id, quote: k.quote, quote_decimals: k.quote_decimals, start: BigInt(k.launch_block ?? ASCEND_FIRST_BLOCK) }
        // not in our Ascend list yet: Ascend's top coins all pair with WHYPE
        : { token: a, pool_id: ascendPoolId(a, WHYPE), quote: WHYPE, quote_decimals: 18, start: ASCEND_FIRST_BLOCK });
    }
  }
  return out;
}

export async function indexCreatorFees(
  { chain, db, appRegistry, oursFrom, hypeUsd, getState, setState }: {
    // deno-lint-ignore no-explicit-any
    chain: any; // the indexer's viem client
    db: Db;
    appRegistry: string;
    oursFrom: bigint;
    hypeUsd: number | null;
    getState: (k: string) => Promise<string | null>;
    setState: (k: string, v: string) => Promise<void>;
  },
) {
  // every 5 minutes once caught up; every run (each minute) while a token is still being backfilled
  const caughtUp = Number((await getState("creator_fees:caught_up_at")) ?? 0);
  if (Date.now() - caughtUp < EVERY_MS) return { skipped: "checked in the last 5 minutes" };
  const started = Date.now();

  const { data: stored, error } = await db.from("creator_fees").select("*");
  if (error) throw new Error(`creator_fees: ${error.message}`);
  const rows = new Map<string, FeeRow>((stored ?? []).map((r: FeeRow) => [r.token, { ...r, credited: String(r.credited), held: String(r.held), total_fees: String(r.total_fees) }]));

  // new tokens: find each one's escrow
  const fresh = (await candidates(db, appRegistry, oursFrom)).filter((c) => !rows.has(c.token));
  const unique = [...new Map(fresh.map((c) => [c.token, c])).values()];
  if (unique.length) {
    const escrows = await chain.multicall({
      multicallAddress: MULTICALL3,
      allowFailure: true,
      contracts: unique.map((c) => ({ address: ESCROW_FACTORY, abi: factoryAbi, functionName: "escrowOf", args: [c.pool_id as `0x${string}`] })),
    });
    unique.forEach((c, i) => {
      const e = escrows[i];
      if (e.status !== "success" || e.result === ZERO) return;
      rows.set(c.token, {
        token: c.token, pool_id: c.pool_id, escrow: (e.result as string).toLowerCase(), quote: c.quote, quote_decimals: c.quote_decimals,
        recipient: null, credited: "0", held: "0", total_fees: "0", earned_usd: 0, scanned_to: Number(c.start) - 1,
      });
    });
  }
  if (!rows.size) {
    await setState("creator_fees:caught_up_at", String(Date.now()));
    return { tokens: 0 };
  }

  // Credited, range by range, for as long as the run allows
  const head = await chain.getBlockNumber({ cacheTime: 0 });
  let ranges = 0;
  while (Date.now() - started < RUN_MS) {
    const all = [...rows.values()];
    const r = nextRange(all, head);
    if (!r) break;
    const group = all.filter((x) => x.scanned_to === r.group);
    const logs = await chain.getLogs({ address: group.map((g) => g.escrow as `0x${string}`), event: credited, fromBlock: r.from, toBlock: r.to });
    const sums = sumCredited(logs);
    for (const g of group) {
      g.credited = (BigInt(g.credited) + (sums.get(g.escrow) ?? 0n)).toString();
      g.scanned_to = Number(r.to);
    }
    ranges++;
  }

  // the views, all escrows in one call
  const list = [...rows.values()];
  const views = await chain.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: list.flatMap((r) => [
      { address: r.escrow as `0x${string}`, abi: escrowAbi, functionName: "held" },
      { address: r.escrow as `0x${string}`, abi: escrowAbi, functionName: "cumulativeFees" },
      { address: r.escrow as `0x${string}`, abi: escrowAbi, functionName: "recipient" },
    ]),
  });
  const now = new Date().toISOString();
  list.forEach((r, i) => {
    const [h, c, rc] = views.slice(i * 3, i * 3 + 3);
    if (h.status === "success") r.held = String(h.result);
    if (c.status === "success") r.total_fees = String(c.result);
    if (rc.status === "success") r.recipient = String(rc.result).toLowerCase();
    r.earned_usd = earnedUsd(r, hypeUsd);
    r.updated_at = now;
  });
  const { error: upErr } = await db.from("creator_fees").upsert(list, { onConflict: "token" });
  if (upErr) throw new Error(`creator_fees: ${upErr.message}`);
  const behind = list.filter((r) => BigInt(r.scanned_to) < head).length;
  if (!behind) await setState("creator_fees:caught_up_at", String(Date.now()));
  return { tokens: list.length, added: rows.size - (stored ?? []).length, ranges, behind };
}
