// Gas sponsor service for one-click buys (see src/oneclick/sponsor.mjs).
//
//   RPC_URL=... DELEGATE=0x<NeuriioAccount> SPONSOR_KEY=0x... node sponsor.mjs
//
// SPONSOR_KEY only pays gas: keep a small HYPE balance on it (a buy costs ~250k gas).
// Use its own key, not the feeder's: they would fight over nonces.
// Env: PORT=8787  CORS_ORIGIN=*  BUYS_PER_MIN=6  SETUPS_PER_HOUR=3  TX_PER_DAY=5000
import { createServer } from "node:http";
import { createPublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeTransport } from "./src/rpc.mjs";
import { Sponsor, UserError } from "./src/oneclick/sponsor.mjs";
import { fromWire } from "./src/oneclick/wire.mjs";

const env = process.env;
const need = (k) => env[k] ?? (console.error(`${k} is required`), process.exit(1));
const num = (k, d) => (env[k] === undefined ? d : Number(env[k]));

const pub = createPublicClient({ transport: makeTransport(need("RPC_URL"), { name: "sponsor" }) });
const signer = privateKeyToAccount(need("SPONSOR_KEY"));
const sponsor = await new Sponsor({
  pub,
  signer,
  delegate: need("DELEGATE"),
  limits: { buysPerMinute: num("BUYS_PER_MIN", 6), setupsPerHour: num("SETUPS_PER_HOUR", 3), txPerDay: num("TX_PER_DAY", 5000) },
}).init();

const routes = { "/setup": (p) => sponsor.setup(p), "/buy": (p) => sponsor.buy(p) };
const cors = { "access-control-allow-origin": env.CORS_ORIGIN ?? "*", "access-control-allow-headers": "content-type" };
const reply = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", ...cors });
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
};

createServer(async (req, res) => {
  if (req.method === "OPTIONS") return reply(res, 204, {});
  if (req.method === "GET" && req.url === "/health") {
    return reply(res, 200, { ok: true, sponsor: signer.address, balance: await pub.getBalance({ address: signer.address }) });
  }
  const route = req.method === "POST" && routes[req.url];
  if (!route) return reply(res, 404, { error: "not found" });
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 16_384) return reply(res, 413, { error: "too large" });
  }
  try {
    reply(res, 200, await route(fromWire(text)));
  } catch (e) {
    const user = e instanceof UserError;
    if (!user) console.error(JSON.stringify({ ev: "sponsor_error", path: req.url, error: e.shortMessage ?? e.message }));
    reply(res, user ? 400 : 500, { error: user ? e.message : "sponsor failed, try again" });
  }
}).listen(num("PORT", 8787), () => {
  console.log(JSON.stringify({ ev: "start", sponsor: signer.address, delegate: env.DELEGATE, port: num("PORT", 8787) }));
});
