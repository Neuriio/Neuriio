// Pulls HyperCore spot top-of-book from the Hyperliquid info API and pushes it to
// KeeperHyperCoreOracle. Temporary data path until Elysium's native read precompile ships.
//
//   RPC_URL=... ORACLE=0x... PRIVATE_KEY=0x... MARKETS=1035 node keeper/feed-bbo.mjs [--loop ms]
//
// Env: HL_API (default testnet), MARKETS (comma-separated spot pair indices; HYPE/USDC testnet = 1035)
//      DEPTH_BPS (default 20): reported bid/ask size = everything resting within this distance of the
//      best price, not just level 1. A dust order at the touch would otherwise make the pool refuse
//      trades it can easily hedge (the hedger's IOC orders reach 20 bps by default).
//      RPC_URL may list a fallback: "primary,secondary"
//
// Loop mode is built to be light on public RPCs: nonce, gas and gas price are tracked locally, so
// each push is one eth_sendRawTransaction, and its receipt is checked once a moment later instead
// of polled. That is ~2 requests per push (was ~6) and lets prices land ~every second.
import { createPublicClient, encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeTransport, primaryUrl } from "./src/rpc.mjs";

const HL_API = process.env.HL_API ?? "https://api.hyperliquid-testnet.xyz/info";
const { RPC_URL, ORACLE, PRIVATE_KEY } = process.env;
const MARKETS = (process.env.MARKETS ?? "1035").split(",").map(Number);
const DEPTH_BPS = Number(process.env.DEPTH_BPS ?? 20);
const loopIdx = process.argv.indexOf("--loop");
const LOOP_MS = loopIdx > -1 ? Number(process.argv[loopIdx + 1] ?? 1000) : 0;

if (!RPC_URL || !ORACLE || !PRIVATE_KEY) {
  console.error("RPC_URL, ORACLE and PRIVATE_KEY are required");
  process.exit(1);
}

const abi = parseAbi([
  "struct Update { uint32 spotIndex; uint256 bid; uint256 ask; uint256 bidSz; uint256 askSz; uint64 coreBlock; uint64 coreTimeMs; }",
  "function push(Update[] updates)",
]);

// Exact decimal-string -> 1e18 fixed point (no float rounding).
export function toWad(s) {
  const [int, frac = ""] = s.split(".");
  if (frac.length > 18) throw new Error(`too many decimals: ${s}`);
  return BigInt(int) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
}

/** Total size (WAD) resting within DEPTH_BPS of the best level on one side of the book. */
export function depthWithin(levels, dir, bps = DEPTH_BPS) {
  const limit = Number(levels[0].px) * (1 + (dir * bps) / 10_000);
  let total = 0n;
  for (const l of levels) {
    if (dir > 0 ? Number(l.px) > limit : Number(l.px) < limit) break;
    total += toWad(l.sz);
  }
  return total;
}

async function fetchBbo(spotIndex) {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin: `@${spotIndex}` }),
  });
  if (!res.ok) throw new Error(`HL API ${res.status}`);
  const { time, levels } = await res.json();
  const [bids, asks] = levels;
  if (!bids.length || !asks.length) return null; // one-sided book: skip
  return {
    spotIndex,
    bid: toWad(bids[0].px),
    ask: toWad(asks[0].px),
    bidSz: depthWithin(bids, -1),
    askSz: depthWithin(asks, +1),
    coreBlock: 0n, // info API doesn't expose Core height; the native precompile will
    coreTimeMs: BigInt(time),
  };
}

const account = privateKeyToAccount(PRIVATE_KEY);
const transport = makeTransport(RPC_URL, { name: "feeder", statsEveryMs: LOOP_MS ? 60_000 : 0 });
const pub = createPublicClient({ transport });
const chain = { id: await pub.getChainId(), name: "target", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [primaryUrl(RPC_URL)] } } };

const GAS = 60_000n + 60_000n * BigInt(MARKETS.length); // push is ~50k warm, ~100k first write per market
let nonce = null;
let gasPrice = null;
let gasPriceAt = 0;

async function tick() {
  const updates = (await Promise.all(MARKETS.map(fetchBbo))).filter(Boolean);
  if (!updates.length) return console.log("no two-sided books");
  if (nonce === null) nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  if (Date.now() - gasPriceAt > 60_000) [gasPrice, gasPriceAt] = [(await pub.getGasPrice()) * 2n, Date.now()];

  let hash;
  try {
    // Sign locally and send raw: exactly one RPC call (writeContract adds eth_fillTransaction round-trips).
    const data = encodeFunctionData({ abi, functionName: "push", args: [updates] });
    const signed = await account.signTransaction({ chainId: chain.id, type: "legacy", to: ORACLE, data, nonce, gas: GAS, gasPrice });
    hash = await pub.sendRawTransaction({ serializedTransaction: signed });
    nonce++;
  } catch (e) {
    nonce = null; // another sender used this account, or a tx was dropped: resync next tick
    throw e;
  }
  const line = (status, gas) =>
    updates.forEach((u) => console.log(`@${u.spotIndex} bid=${u.bid} ask=${u.ask} coreTime=${u.coreTimeMs} tx=${hash} status=${status} gas=${gas}`));

  if (!LOOP_MS) {
    const r = await pub.waitForTransactionReceipt({ hash });
    return line(r.status, r.gasUsed);
  }
  // loop mode: one receipt lookup shortly after, without blocking the next push
  setTimeout(() => {
    pub.getTransactionReceipt({ hash }).then(
      (r) => line(r.status, r.gasUsed),
      () => line("pending", "?"),
    );
  }, 1500);
}

do {
  try {
    await tick();
  } catch (e) {
    console.error("tick failed:", e.shortMessage ?? e.message);
    if (!LOOP_MS) process.exit(1);
  }
  if (LOOP_MS) await new Promise((r) => setTimeout(r, LOOP_MS));
} while (LOOP_MS);
