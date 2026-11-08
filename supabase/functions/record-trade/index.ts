// POST /functions/v1/record-trade { tx }   (user, 2026-11-07): a trade placed on Neuriio shows on every chart and in the trader's
// Positions about a second after it lands, without watching the chain. The app sends the hash once its receipt is in; this
// reads that one receipt (~15-25 Alchemy compute units), keeps only swaps in Ascend pools we know (ascend_tokens, or our own
// launches), stores them in `trades` exactly as the indexer would (same tx_hash + log_index, so its later copy is a no-op; the
// candles follow from the trades_to_candles trigger), and broadcasts them to "trades:<token>" (charts) and "trades:all"
// (positions, live prices). Returns the live trades so the trader's own page can show them at once.
// Only recent, successful transactions sent to NeuriioSwap or Ascend's UniversalRouter count; rate-limited per IP.
// Secrets: RPC_URL, SUPABASE_URL, NEURIIO_DB_KEY; optional NEURIIO_SWAPS (comma list), UNIVERSAL_ROUTER, POOL_MANAGER, LAUNCHPAD.

import { createClient } from "npm:@supabase/supabase-js@2";
import { createPublicClient, getAddress, http, parseEventLogs } from "npm:viem@2";
import { ascendSwapToRow, bidFilled, hookFeesByTx, hookSwap, poolManagerSwap, rowInUsd, type TradeRow, withBidFills } from "../_shared/indexer.ts";
import { CORS, HttpError, json } from "../_shared/privy.ts";
import { rateLimit } from "../_shared/rateLimit.ts";
import { env } from "../_shared/env.ts";

const lc = (a: string) => a.toLowerCase();
const POOL_MANAGER = lc(Deno.env.get("POOL_MANAGER") ?? "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1");
const HOOK = lc(Deno.env.get("LAUNCHPAD") ?? "0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC");
const ROUTER = lc(Deno.env.get("UNIVERSAL_ROUTER") ?? "0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a");
const SWAPS = (Deno.env.get("NEURIIO_SWAPS") ?? "0x630B8f610abEAe77FD39f802136F57Dd2B2f4946").split(",").map((a) => lc(a.trim())).filter(Boolean);
const USDC = "0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65";
const WHYPE = "0xba876237b0f021a6c6d852d6c26e107997cc5e81";
const MAX_AGE_S = 15 * 60; // older trades are the indexer's job

const chain = createPublicClient({ transport: http(env("RPC_URL")) });
const db = createClient(env("SUPABASE_URL"), env("NEURIIO_DB_KEY"), { auth: { persistSession: false } });

type LiveTrade = {
  token: string; venue: "pool"; side: "buy" | "sell"; trader: string; hype: number; tokens: number; priceHype: number | null;
  tx: string; logIndex: number; block: number; ts: number;
};

async function hypeUsd(): Promise<number | null> {
  try {
    const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
    const px = Number((await r.json()).HYPE);
    return px > 0 ? px : null;
  } catch {
    return null;
  }
}

/** USD per whole pair unit: USDC $1, WHYPE the HYPE price, else unknown. */
const usdPer = (quote: string, hype: number | null) => (quote === USDC ? 1 : quote === WHYPE ? hype : null);

export async function record(txHash: `0x${string}`) {
  const receipt = await chain.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt) throw new HttpError(404, "Transaction not found yet");
  if (receipt.status !== "success") return { trades: [] };
  const to = lc(receipt.to ?? "");
  if (to !== ROUTER && !SWAPS.includes(to)) return { trades: [] };

  const logs = receipt.logs.filter((l) => lc(l.address) === POOL_MANAGER || lc(l.address) === HOOK);
  const swaps = parseEventLogs({ abi: [poolManagerSwap], logs: logs.filter((l) => lc(l.address) === POOL_MANAGER), strict: false });
  if (!swaps.length) return { trades: [] };
  const hooks = parseEventLogs({ abi: [hookSwap], logs: logs.filter((l) => lc(l.address) === HOOK), strict: false });
  const fills = parseEventLogs({ abi: [bidFilled], logs: logs.filter((l) => lc(l.address) === HOOK), strict: false });

  // which of these pools we know: every Ascend coin (ascend_tokens), else our own launches (USDC pairs)
  const ids = [...new Set(swaps.map((s) => lc(String(s.args.id))))];
  const [{ data: ascend }, { data: ours }] = await Promise.all([
    db.from("ascend_tokens").select("address, pool_id, quote, quote_decimals").in("pool_id", ids),
    db.from("tokens").select("address, pair").in("pair", ids),
  ]);
  const pools = new Map<string, { token: string; quote: string; decimals: number }>();
  for (const t of ours ?? []) pools.set(lc(t.pair), { token: lc(t.address), quote: USDC, decimals: 6 });
  for (const t of ascend ?? []) pools.set(lc(t.pool_id), { token: lc(t.address), quote: lc(t.quote), decimals: t.quote_decimals });
  if (!pools.size) return { trades: [] };

  const block = await chain.getBlock({ blockNumber: receipt.blockNumber });
  const tsSec = Number(block.timestamp);
  if (Date.now() / 1000 - tsSec > MAX_AGE_S) return { trades: [] };
  const ts = new Date(tsSec * 1000).toISOString();
  const hype = await hypeUsd();
  const trader = lc(receipt.from);
  const txFrom = new Map([[receipt.transactionHash, trader]]);

  // pool by pool (each pool's pair sets its units), exactly as the indexer stores them
  const rows: TradeRow[] = [];
  for (const [poolId, p] of pools) {
    const q = { address: getAddress(p.quote), decimals: p.decimals, usd: 1 };
    const tokenOfPool = new Map([[poolId, p.token]]);
    const mine = <L extends { args: Record<string, unknown> }>(xs: L[], f: string) => xs.filter((l) => lc(String(l.args[f])) === poolId);
    // deno-lint-ignore no-explicit-any
    const fees = hookFeesByTx(mine(hooks as any, "poolId") as any, tokenOfPool, q);
    let n = 0;
    // deno-lint-ignore no-explicit-any
    const swapRows = mine(swaps as any, "id").sort((a: any, b: any) => a.logIndex - b.logIndex).map((l: any) =>
      ascendSwapToRow(l, p.token, q, trader, ts, fees.get(`${l.transactionHash}:${poolId}`)?.[n++] ?? null)
    );
    // deno-lint-ignore no-explicit-any
    const all = withBidFills(swapRows, mine(fills as any, "poolId") as any, tokenOfPool, q, txFrom, (() => ts) as any);
    rows.push(...all.map((r) => rowInUsd(r, usdPer(p.quote, hype))));
  }
  if (!rows.length) return { trades: [] };
  const { error } = await db.from("trades").upsert(rows, { onConflict: "tx_hash,log_index", ignoreDuplicates: true });
  if (error) throw new Error(`trades: ${error.message}`);

  const live: LiveTrade[] = rows.map((r) => ({
    token: r.market, venue: "pool", side: r.side, trader: r.trader,
    hype: r.usd_value ?? Number(r.quote_amount), tokens: Number(r.size),
    priceHype: r.price_hype == null ? null : Number(r.price_hype),
    tx: r.tx_hash!, logIndex: r.log_index!, block: r.block_number!, ts: tsSec * 1000,
  }));
  await broadcast(live);
  return { trades: live };
}

async function broadcast(trades: LiveTrade[]) {
  const key = env("NEURIIO_DB_KEY");
  const messages = [
    ...trades.map((t) => ({ topic: `trades:${t.token}`, event: "trade", payload: t, private: true })),
    { topic: "trades:all", event: "trades", payload: { trades }, private: true },
  ];
  const res = await fetch(`${env("SUPABASE_URL")}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  }).catch(() => null);
  if (!res?.ok) console.error(`record-trade: broadcast ${res?.status}`); // stored anyway; the chart still shows it on reload
}

if (import.meta.main) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") return json(405, { error: "POST only" });
    try {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      await rateLimit(db, "record-trade", `record-trade:${ip}`, 30, 60);
      const body = await req.json().catch(() => ({}));
      const tx = String(body?.tx ?? "");
      if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return json(400, { error: "Bad transaction hash" });
      return json(200, await record(tx as `0x${string}`));
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      console.error(`record-trade: ${(e as Error).message}`); // details (may include the RPC URL) stay server-side
      return json(500, { error: "Something went wrong" });
    }
  });
}
