// Shared RPC transport for the bots: gentle on public endpoints.
//   - RPC_URL may list several endpoints ("primary,fallback"); rate-limited or failing requests
//     move to the next one
//   - reads issued together are batched into one HTTP request
//   - retries with backoff instead of hammering
//   - logs requests/minute so load is visible
import { fallback, http } from "viem";

export function makeTransport(urls, { name = "rpc", statsEveryMs = 60_000, log = console.log } = {}) {
  if (statsEveryMs && process.env.RPC_STATS_MS) statsEveryMs = Number(process.env.RPC_STATS_MS);
  const list = urls.split(",").map((u) => u.trim()).filter(Boolean);
  if (!list.length) throw new Error("RPC_URL is empty");
  let requests = 0;
  let methods = {};
  const count = async (req) => {
    requests++;
    try {
      const body = JSON.parse(await req.clone().text());
      for (const m of Array.isArray(body) ? body : [body]) methods[m.method] = (methods[m.method] ?? 0) + 1;
    } catch {}
  };
  // With a backup available, give each endpoint one quick try and move on; alone, retry harder.
  const one = (url) =>
    http(url, {
      batch: { wait: 16 },
      retryCount: list.length > 1 ? 0 : 3,
      retryDelay: 400,
      timeout: 5_000,
      onFetchRequest: count,
    });
  if (statsEveryMs) {
    setInterval(() => {
      const perMin = (n) => Math.round((n * 60_000) / statsEveryMs);
      const byMethod = Object.fromEntries(Object.entries(methods).map(([m, n]) => [m, perMin(n)]));
      log(JSON.stringify({ ev: "rpc_stats", bot: name, requestsPerMin: perMin(requests), byMethod }));
      requests = 0;
      methods = {};
    }, statsEveryMs).unref();
  }
  // rank: health-check endpoints every 60s so a dead or slow one stops being tried first
  return list.length > 1 ? fallback(list.map(one), { retryCount: 2, rank: { interval: 60_000 } }) : one(list[0]);
}

/** First URL, for the viem chain definition. */
export const primaryUrl = (urls) => urls.split(",")[0].trim();
