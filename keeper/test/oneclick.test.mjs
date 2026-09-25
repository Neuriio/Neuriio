import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { planCollateralMove } from "../src/trade/orders.mjs";
import { orderUsdFor } from "../src/oneclick/oneclick.mjs";
import { Sponsor, UserError } from "../src/oneclick/sponsor.mjs";
import { fromWire, toWire } from "../src/oneclick/wire.mjs";

const DELEGATE = "0x00000000000000000000000000000000000de1e6";
const BRIDGE = "0x00000000000000000000000000000000000b1d6e";
const USDC = "0x0000000000000000000000000000000000005dc0";

// ------------------------------------------------------------------ sizing

test("orderUsdFor: leaves room for slippage and taker fee", () => {
  // spot: 100 / (1.005 * 1.0007)
  assert.equal(orderUsdFor(100, "spot"), 99.43);
  // perps 10x: 100 / (1.005 * (1 + 10 * 0.00045))
  assert.equal(orderUsdFor(100, "perp", 10), 99.05);
  assert.equal(orderUsdFor(100, "outcome"), 99.5); // outcome markets: no fee to open
  assert.equal(orderUsdFor(-1, "spot"), 0);
});

test("orderUsdFor output always fits the collateral check", () => {
  for (const [kind, lev] of [["spot", 1], ["perp", 1], ["perp", 40], ["outcome", 1]]) {
    for (const avail of [10.5, 57.31, 999.99]) {
      const usd = orderUsdFor(avail, kind, lev);
      const px = 1.005; // order limit at mid +50 bps, mid normalised to 1
      const summary = { kind, side: "buy", price: String(px), size: String((usd * lev) / 1), leverage: lev };
      const bal = kind === "perp" ? { perp: avail, spot: 0 } : { perp: 0, spot: avail };
      assert.equal(planCollateralMove(summary, bal), null, `${kind} ${lev}x $${avail}`);
    }
  }
});

// ------------------------------------------------------------------ perps <-> spot USDC

const buy = (kind, size, price, leverage = 1) => ({ kind, side: "buy", size: String(size), price: String(price), leverage });

test("collateral: spot/outcome buys pull USDC from perps (where the bridge credits it)", () => {
  assert.deepEqual(planCollateralMove(buy("spot", 2, 25), { perp: 100, spot: 0 }), {
    sourceDex: "",
    destinationDex: "spot",
    amount: "50.04", // 50 * 1.0007, rounded up to the cent
  });
  assert.deepEqual(planCollateralMove(buy("outcome", 100, 0.5), { perp: 100, spot: 20 }), {
    sourceDex: "",
    destinationDex: "spot",
    amount: "30.00",
  });
});

test("collateral: perps buys pull from spot only when perps is short", () => {
  assert.equal(planCollateralMove(buy("perp", 1, 100, 10), { perp: 20, spot: 0 }), null);
  assert.deepEqual(planCollateralMove(buy("perp", 1, 100, 10), { perp: 5, spot: 50 }), {
    sourceDex: "spot",
    destinationDex: "",
    amount: "5.05",
  });
});

test("collateral: sells and reduce-only need nothing; shortfall is a clear error", () => {
  assert.equal(planCollateralMove({ ...buy("spot", 2, 25), side: "sell" }, { perp: 0, spot: 0 }), null);
  assert.equal(planCollateralMove(buy("perp", 1, 100), { perp: 0, spot: 0 }, { reduceOnly: true }), null);
  assert.throws(() => planCollateralMove(buy("spot", 2, 25), { perp: 10, spot: 10 }), /not enough USDC/);
});

// ------------------------------------------------------------------ wire format

test("wire: bigints survive the trip to the sponsor", () => {
  const p = {
    wallet: "0xabc",
    order: { token: "0x1", amountIn: 10n ** 30n, minUsdcOut: 5n, deadline: 99n, nonce: 2n ** 255n },
    signature: "0xsig",
  };
  assert.deepEqual(fromWire(toWire(p)).order, p.order);
  const s = { key: "0x2", validUntil: 1n, maxPerBuy: 2n, maxPerDay: 3n, epoch: 4, nonce: 5n };
  assert.deepEqual(fromWire(toWire({ session: s })).session, s);
});

// ------------------------------------------------------------------ sponsor guards

function fakeSponsor(overrides = {}) {
  const calls = [];
  const pub = {
    getChainId: async () => 99801,
    getCode: async () => "0x",
    estimateGas: async () => 100_000n,
    getTransactionCount: async () => 0,
    getGasPrice: async () => 10_000_000n,
    sendRawTransaction: async (x) => (calls.push(x), "0xhash"),
    waitForTransactionReceipt: async () => ({ status: "success", transactionHash: "0xhash", logs: [] }),
    readContract: async ({ functionName }) => (functionName === "bridge" ? BRIDGE : USDC),
    ...overrides,
  };
  const signer = privateKeyToAccount(generatePrivateKey());
  return { sponsor: new Sponsor({ pub, signer, delegate: DELEGATE, log: () => {} }), calls };
}

const session = { key: "0x0000000000000000000000000000000000000001", validUntil: 9n, maxPerBuy: 1n, maxPerDay: 1n, epoch: 0, nonce: 1n };

test("sponsor: only forwards authorizations to OUR delegate, on THIS chain, signed by the wallet", async () => {
  const { sponsor, calls } = fakeSponsor();
  await sponsor.init();
  const user = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const auth = (acct, o) => acct.signAuthorization({ address: DELEGATE, chainId: 99801, nonce: 0, ...o });
  const setup = (authorization, wallet = user.address) => sponsor.setup({ wallet, authorization, session, signature: "0x" });

  await assert.rejects(setup(await auth(user, { address: "0x000000000000000000000000000000000000beef" })), /not for NeuriioAccount/);
  await assert.rejects(setup(await auth(user, { chainId: 0 })), /this chain only/); // 0 = valid on every chain
  await assert.rejects(setup(await auth(other)), /not signed by wallet/);
  assert.equal(calls.length, 0);

  const { sponsor: s2, calls: c2 } = fakeSponsor();
  await s2.init();
  await s2.setup({ wallet: user.address, authorization: await auth(user), session, signature: "0x" });
  assert.equal(c2.length, 1);
  assert.match(c2[0].serializedTransaction, /^0x04/, "type-4 (EIP-7702) transaction");
});

test("sponsor: refuses undelegated wallets and anything that would revert (no gas wasted)", async () => {
  const user = privateKeyToAccount(generatePrivateKey()).address;
  const { sponsor, calls } = fakeSponsor();
  await sponsor.init();
  await assert.rejects(sponsor.buy({ wallet: user, order: {}, signature: "0x" }), /not set up/);

  const delegated = `0xef0100${DELEGATE.slice(2)}`;
  const { sponsor: s2, calls: c2 } = fakeSponsor({
    getCode: async () => delegated,
    estimateGas: async () => {
      throw Object.assign(new Error("execution reverted"), { data: "0x" });
    },
  });
  await s2.init();
  const order = { token: USDC, amountIn: 20_000_000n, minUsdcOut: 0n, deadline: 1n, nonce: 1n };
  await assert.rejects(s2.buy({ wallet: user, order, signature: "0x" }), (e) => e instanceof UserError && /would revert/.test(e.message));
  assert.equal(calls.length + c2.length, 0);
});

test("sponsor: per-wallet rate limit", async () => {
  const user = privateKeyToAccount(generatePrivateKey()).address;
  const { sponsor } = fakeSponsor({ getCode: async () => `0xef0100${DELEGATE.slice(2)}` });
  sponsor.limits.buysPerMinute = 2;
  await sponsor.init();
  sponsor.buy = Sponsor.prototype.buy.bind(sponsor);
  const order = { token: USDC, amountIn: 20_000_000n, minUsdcOut: 0n, deadline: 1n, nonce: 1n };
  const attempt = () => sponsor.buy({ wallet: user, order, signature: "0x" }).catch((e) => e.message);
  const results = [await attempt(), await attempt(), await attempt()];
  assert.match(results[2], /too many buy requests/);
  assert.ok(!/too many/.test(results[0]) && !/too many/.test(results[1]));
});

test("sponsor: dust buys are refused (they can't trade and would only burn our gas)", async () => {
  const user = privateKeyToAccount(generatePrivateKey()).address;
  const { sponsor, calls } = fakeSponsor({ getCode: async () => `0xef0100${DELEGATE.slice(2)}` });
  await sponsor.init();
  const order = { token: USDC, amountIn: 9_999_999n, minUsdcOut: 0n, deadline: 1n, nonce: 1n };
  await assert.rejects(sponsor.buy({ wallet: user, order, signature: "0x" }), /below the \$10 minimum/);
  assert.equal(calls.length, 0);
});
