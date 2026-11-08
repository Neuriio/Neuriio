// The RPC proxy (api/_lib/rpcProxy.ts). Run: node --test app/api/_lib/rpcProxy.test.ts  (Node strips the types itself)
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBody, COOKIE, makeRpcHandler, makeSessionCookie, makeSessionHandler, MAX_BATCH, sessionValid, type ProxyEnv } from "./rpcProxy.ts";

const env: ProxyEnv = {
  upstream: "https://provider.example/v2/SECRETKEY",
  sessionSecret: "test-secret",
  allowedOrigins: ["https://app.neuriio.xyz"],
  sendOrigins: ["https://auth.privy.io"],
  turnstileSecret: "ts-secret",
};
const call = (method: string, params: unknown[] = [], id = 1) => ({ jsonrpc: "2.0", id, method, params });
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://app.neuriio.xyz/rpc", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const OURS = { origin: "https://app.neuriio.xyz" };

/** A fake provider that records what it was asked. */
function provider(reply: (body: unknown) => Response = (b) => new Response(JSON.stringify(Array.isArray(b) ? b.map((c) => ({ jsonrpc: "2.0", id: c.id, result: "0x1" })) : { jsonrpc: "2.0", id: (b as { id: unknown }).id, result: "0x1" }))) {
  const seen: { url: string; body: unknown }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push({ url, body });
    return reply(body);
  }) as unknown as typeof fetch;
  return { f, seen };
}
const cookieFor = async (nowS: number) => `${COOKIE}=${await makeSessionCookie(env.sessionSecret, nowS)}`;

test("body: the app's reads and sends pass; debug, admin and unknown methods don't", () => {
  assert.equal(checkBody(JSON.stringify(call("eth_call"))).ok, true);
  assert.equal(checkBody(JSON.stringify([call("eth_chainId"), call("eth_getBalance")])).ok, true);
  for (const m of ["debug_traceTransaction", "eth_subscribe", "admin_peers", "eth_sign", "personal_sign", "txpool_content", "eth_newFilter"]) {
    const r = checkBody(JSON.stringify(call(m)));
    assert.equal(r.ok, false, m);
  }
  assert.equal(checkBody("not json").ok, false);
  assert.equal(checkBody(JSON.stringify({ id: 1, method: "eth_call" })).ok, false); // no jsonrpc: "2.0"
  assert.equal(checkBody(JSON.stringify(Array.from({ length: MAX_BATCH + 1 }, (_, i) => call("eth_chainId", [], i)))).ok, false);
  assert.equal(checkBody(JSON.stringify([])).ok, false);
});

test("body: eth_getLogs needs an address and a bounded block range", () => {
  const logs = (f: unknown) => checkBody(JSON.stringify(call("eth_getLogs", [f])));
  assert.equal(logs({ address: "0xabc", fromBlock: "0x10", toBlock: "0x20" }).ok, true);
  assert.equal(logs({ address: ["0xabc", "0xdef"], fromBlock: "0x10", toBlock: "0x2720" }).ok, true); // 10,000 blocks
  assert.equal(logs({ address: "0xabc", fromBlock: "0x0", toBlock: "0x2711" }).ok, false); // 10,001
  assert.equal(logs({ fromBlock: "0x10", toBlock: "0x20" }).ok, false); // no address: the whole chain
  assert.equal(logs({ address: "0xabc", fromBlock: "earliest", toBlock: "latest" }).ok, false);
  assert.equal(logs({ address: "0xabc", blockHash: "0x" + "1".repeat(64) }).ok, true);
});

test("body: send-lane calls are marked as such", () => {
  const r = checkBody(JSON.stringify([call("eth_sendRawTransaction", ["0x02"]), call("eth_getTransactionReceipt", ["0x1"])]));
  assert.ok(r.ok && r.sendOnly);
  const r2 = checkBody(JSON.stringify([call("eth_chainId"), call("eth_call")]));
  assert.ok(r2.ok && !r2.sendOnly);
});

test("cookie: valid until it expires; a changed value or another secret fails", async () => {
  const now = 1_800_000_000;
  const c = await cookieFor(now);
  assert.equal(await sessionValid(c, env.sessionSecret, now + 10), true);
  assert.equal(await sessionValid(`other=1; ${c}`, env.sessionSecret, now + 10), true);
  assert.equal(await sessionValid(c, env.sessionSecret, now + 6 * 3600 + 1), false); // expired
  assert.equal(await sessionValid(c, "another-secret", now + 10), false);
  const [exp, mac] = c.slice(COOKIE.length + 1).split(".");
  assert.equal(await sessionValid(`${COOKIE}=${Number(exp) + 3600}.${mac}`, env.sessionSecret, now), false); // extended by hand
  assert.equal(await sessionValid(null, env.sessionSecret, now), false);
});

test("proxy: a read without a session is refused (401); with one it goes to the provider", async () => {
  const { f, seen } = provider();
  const handle = makeRpcHandler(env, f, () => 1_800_000_000_000);
  assert.equal((await handle(req(call("eth_call"), OURS))).status, 401);
  assert.equal(seen.length, 0);
  const ok = await handle(req(call("eth_call"), { ...OURS, cookie: await cookieFor(1_800_000_000) }));
  assert.equal(ok.status, 200);
  assert.equal(seen[0].url, env.upstream);
  assert.deepEqual((await ok.json()).result, "0x1");
});

test("proxy: Privy's iframe can send a transaction without our cookie, but can't read", async () => {
  const { f } = provider();
  const handle = makeRpcHandler(env, f);
  const privy = { origin: "https://auth.privy.io" };
  assert.equal((await handle(req(call("eth_sendRawTransaction", ["0x02"]), privy))).status, 200);
  assert.equal((await handle(req(call("eth_call"), privy))).status, 401);
  // a session cookie from Privy's origin doesn't count either
  assert.equal((await handle(req(call("eth_call"), { ...privy, cookie: await cookieFor(Math.floor(Date.now() / 1000)) }))).status, 401);
});

test("proxy: other sites are refused", async () => {
  const handle = makeRpcHandler(env, provider().f);
  assert.equal((await handle(req(call("eth_chainId"), { origin: "https://evil.example" }))).status, 403);
  assert.equal((await handle(new Request("https://app.neuriio.xyz/rpc", { method: "GET" }))).status, 405);
});

test("proxy: the provider's own error text (which can name its URL and key) never reaches the browser", async () => {
  const { f } = provider(() => new Response("upstream error at https://provider.example/v2/SECRETKEY", { status: 500 }));
  const handle = makeRpcHandler(env, f);
  const res = await handle(req(call("eth_chainId"), OURS));
  const text = await res.text();
  assert.equal(res.status, 502);
  assert.ok(!text.includes("SECRETKEY") && !text.includes("provider.example"), text);
});

test("proxy: each visitor is rate limited, counting every call in a batch", async () => {
  const handle = makeRpcHandler(env, provider().f, () => 1_800_000_000_000);
  const ip = { ...OURS, "x-real-ip": "1.2.3.4" };
  const batch = Array.from({ length: 25 }, (_, i) => call("eth_chainId", [], i));
  let last = 0;
  for (let i = 0; i < 5; i++) last = (await handle(req(batch, ip))).status; // 125 send-lane calls: over 120
  assert.equal(last, 429);
  assert.equal((await handle(req(call("eth_chainId"), { ...OURS, "x-real-ip": "5.6.7.8" }))).status, 200); // someone else
});

test("session: needs a Turnstile token Cloudflare accepts; then sets a 6-hour HttpOnly cookie for /rpc", async () => {
  const verify = async (_s: string, token: string) => token === "good";
  const handle = makeSessionHandler(env, verify);
  const post = (b: unknown, h: Record<string, string> = OURS) => handle(new Request("https://app.neuriio.xyz/rpc/session", { method: "POST", headers: h, body: JSON.stringify(b) }));
  assert.equal((await post({ turnstile: "bad" })).status, 403);
  assert.equal((await post({})).status, 403);
  const ok = await post({ turnstile: "good" });
  assert.equal(ok.status, 200);
  const set = ok.headers.get("set-cookie") ?? "";
  assert.match(set, new RegExp(`^${COOKIE}=\\d+\\.[A-Za-z0-9_-]+; Path=/rpc; Max-Age=21600; HttpOnly; Secure; SameSite=Strict$`));
  assert.equal(await sessionValid(set.split(";")[0], env.sessionSecret, Math.floor(Date.now() / 1000)), true);
  assert.equal((await post({ turnstile: "good" }, { origin: "https://evil.example" })).status, 403);
  // without a Turnstile secret it refuses, unless explicitly open for testing
  assert.equal((await makeSessionHandler({ ...env, turnstileSecret: undefined })(new Request("https://x/rpc/session", { method: "POST", body: "{}" }))).status, 503);
  assert.equal((await makeSessionHandler({ ...env, turnstileSecret: undefined, openSessions: true })(new Request("https://x/rpc/session", { method: "POST", body: "{}" }))).status, 200);
});
