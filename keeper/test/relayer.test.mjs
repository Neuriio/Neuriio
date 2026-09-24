import { test } from "node:test";
import assert from "node:assert/strict";
import { Relayer } from "../src/bridge/relayer.mjs";
import { SimHyperCore } from "../src/bridge/hl-sim.mjs";
import { MemoryStore } from "../src/store.mjs";
import { strToUsdc } from "../src/bridge/units.mjs";

const US = "0x00000000000000000000000000000000000000aa"; // our HyperCore inventory account
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b0";

/** In-memory model of FastBridge's relayer-facing surface. */
class FakeBridge {
  constructor(now) {
    this.now = now;
    this.credit = 0n;
    this.deposits = new Map();
    this.n = 0;
    this.paidOut = new Map();
    this.payoutError = null;
  }
  deposit(user, usdc, hlRecipient = user) {
    const amount = strToUsdc(usdc);
    if (amount > this.credit) throw new Error("InsufficientCredit");
    this.credit -= amount;
    const id = ++this.n;
    this.deposits.set(id, { id, user, hlRecipient, amount, createdAtMs: this.now(), status: "pending" });
    return id;
  }
  refund(id) {
    const d = this.deposits.get(id);
    d.status = "refunded";
    this.credit += d.amount;
  }
  async snapshot() {
    return { credit: this.credit, pending: [...this.deposits.values()].filter((d) => d.status === "pending") };
  }
  async markFulfilled(ids) {
    for (const id of ids) {
      if (this.deposits.get(id).status !== "pending") throw new Error(`NotPending(${id})`);
      this.deposits.get(id).status = "fulfilled";
    }
  }
  async payout(ref, to, units) {
    if (this.paidOut.has(ref)) throw new Error("AlreadyPaid");
    if (this.payoutError) throw new Error(this.payoutError);
    this.paidOut.set(ref, { to, units });
  }
  async setCredit(from, to) {
    if (this.credit !== from) throw new Error("StaleCredit");
    this.credit = to;
  }
}

function setup({ hlFunds = "10000" } = {}) {
  let t = 1_790_000_000_000;
  const now = () => t;
  const sim = new SimHyperCore({ now });
  sim.fund(US, hlFunds);
  sim.fund(ALICE, "5000");
  const hl = sim.accountView(US);
  const chain = new FakeBridge(now);
  const store = new MemoryStore();
  const logs = [];
  const relayer = new Relayer({
    chain,
    hl,
    store,
    now,
    log: (e) => logs.push(e),
    cfg: {
      refundDelayMs: 3_600_000,
      refundMarginMs: 600_000,
      resendAfterMs: 30_000,
      creditBuffer: strToUsdc("100"),
      creditStep: strToUsdc("50"),
    },
  });
  return { sim, hl, chain, store, relayer, logs, advance: (ms) => (t += ms) };
}

const usdc = (s) => strToUsdc(s);

test("first tick sets credit from HyperCore balance minus buffer", async () => {
  const { chain, relayer } = setup();
  await relayer.tick();
  assert.equal(chain.credit, usdc("9900"));
});

test("deposit is credited on HyperCore once and marked fulfilled", async () => {
  const { sim, chain, relayer, logs } = setup();
  await relayer.tick();
  const id = chain.deposit(ALICE, "999.5", BOB);
  await relayer.tick();

  assert.equal(chain.deposits.get(id).status, "fulfilled");
  assert.equal(sim.balanceOf(BOB), usdc("999.5"));
  assert.equal(sim.balanceOf(US), usdc("9000.5"));
  assert.equal(chain.credit, usdc("8900.5"), "credit = HL balance - buffer");

  await relayer.tick();
  assert.equal(sim.balanceOf(BOB), usdc("999.5"), "never credited twice");
  assert.equal(logs.filter((l) => l.ev === "deposit_credited").length, 1);
});

test("withdrawal: user sends to us on HyperCore, gets paid on Elysium exactly once", async () => {
  const { sim, chain, relayer } = setup();
  await relayer.tick();
  const { hash } = sim.transfer(ALICE, US, "500");
  await relayer.tick();
  await relayer.tick();

  assert.equal(chain.paidOut.size, 1);
  assert.deepEqual(chain.paidOut.get(hash), { to: ALICE, units: usdc("500") });
  assert.equal(chain.credit, usdc("10400"), "incoming USDC raises credit");
});

test("crash after a send landed: recovered from the ledger, not re-sent", async () => {
  const { sim, hl, chain, relayer, logs, advance } = setup();
  await relayer.tick();
  const id = chain.deposit(ALICE, "1000");
  hl.failNextSend = "after";
  await relayer.tick(); // send lands but client sees an error
  assert.equal(chain.deposits.get(id).status, "pending");

  advance(10_000);
  await relayer.tick(); // within resendAfterMs: waits
  advance(30_000);
  await relayer.tick(); // finds its own transfer in the ledger

  assert.equal(chain.deposits.get(id).status, "fulfilled");
  assert.equal(sim.balanceOf(ALICE), usdc("6000"), "credited exactly once");
  assert.ok(logs.some((l) => l.ev === "deposit_recovered"));
});

test("crash before a send landed: not retried until the ledger has had time to index", async () => {
  const { sim, hl, chain, relayer } = setup();
  await relayer.tick();
  const id = chain.deposit(ALICE, "1000");
  hl.failNextSend = "before";
  await relayer.tick();
  assert.equal(sim.balanceOf(ALICE), usdc("5000"));
  await relayer.tick(); // too soon to retry
  assert.equal(chain.deposits.get(id).status, "pending");
});

test("retry happens once resendAfterMs has passed", async () => {
  const { sim, hl, chain, relayer, advance } = setup();
  await relayer.tick();
  const id = chain.deposit(ALICE, "1000");
  hl.failNextSend = "before";
  await relayer.tick();
  advance(31_000);
  await relayer.tick();
  assert.equal(chain.deposits.get(id).status, "fulfilled");
  assert.equal(sim.balanceOf(ALICE), usdc("6000"));
});

test("deposits near their refund time are left for the user to refund", async () => {
  const { sim, chain, relayer, advance, logs } = setup();
  await relayer.tick();
  relayer.busy = true; // relayer offline
  const id = chain.deposit(ALICE, "1000");
  advance(3_000_001); // 50 min: inside the 10 min safety margin before the 1h refund
  relayer.busy = false;
  await relayer.tick();
  assert.equal(chain.deposits.get(id).status, "pending");
  assert.equal(sim.balanceOf(ALICE), usdc("5000"), "not sent");
  assert.ok(logs.some((l) => l.ev === "deposit_expired"));
});

test("ambiguous recovery is held for review instead of guessing", async () => {
  const { hl, chain, relayer, advance, logs, sim } = setup();
  await relayer.tick();
  const a = chain.deposit(ALICE, "1000");
  const b = chain.deposit(ALICE, "1000");
  // crash mid-batch: both logged as "sending", only one actually landed
  hl.failNextSend = "after";
  const origSend = hl.send.bind(hl);
  let calls = 0;
  hl.send = async (to, amt) => {
    if (++calls === 2) throw new Error("network error (not submitted)");
    return origSend(to, amt);
  };
  await relayer.tick();
  hl.send = origSend;
  advance(31_000);
  await relayer.tick();

  assert.equal(chain.deposits.get(a).status, "pending");
  assert.equal(chain.deposits.get(b).status, "pending");
  assert.equal(sim.balanceOf(ALICE), usdc("6000"), "no extra send while ambiguous");
  assert.ok(logs.some((l) => l.ev === "deposit_needs_review"));
});

test("failed payouts are retried and the ledger cursor doesn't skip them", async () => {
  const { sim, chain, relayer, advance, logs } = setup();
  await relayer.tick();
  chain.payoutError = "DailyCapExceeded";
  const { hash } = sim.transfer(ALICE, US, "500");
  await relayer.tick();
  assert.equal(chain.paidOut.size, 0);
  assert.ok(logs.some((l) => l.ev === "withdrawal_payout_failed"));

  advance(2 * 3_600_000); // hours later, cap resets
  chain.payoutError = null;
  await relayer.tick();
  assert.deepEqual(chain.paidOut.get(hash), { to: ALICE, units: usdc("500") });
});

test("treasury top-ups raise credit but are never paid out as withdrawals", async () => {
  const { sim, chain, relayer, logs } = setup();
  relayer.topupFrom.add(BOB.toLowerCase()); // BOB = our treasury wallet
  sim.fund(BOB, "1000");
  await relayer.tick();
  sim.transfer(BOB, US, "1000"); // top-up
  const { hash } = sim.transfer(ALICE, US, "50"); // real user withdrawal
  await relayer.tick();
  await relayer.tick();
  assert.equal(chain.paidOut.size, 1, "only Alice is paid");
  assert.ok(chain.paidOut.has(hash));
  assert.ok(logs.some((l) => l.ev === "inventory_topup" && l.usdc === "1000"));
  assert.equal(chain.credit, usdc("10950"), "top-up and withdrawal both raise credit");
});

test("credit drops to zero when HyperCore inventory is gone", async () => {
  const { sim, chain, relayer } = setup();
  await relayer.tick();
  sim.transfer(US, BOB, "9950"); // inventory drained (e.g. moved to cold storage)
  await relayer.tick();
  assert.equal(chain.credit, 0n);
});

test("stale credit read is rejected, then corrected next tick", async () => {
  const { chain, relayer } = setup();
  await relayer.tick();
  const snapshot = chain.snapshot.bind(chain);
  chain.snapshot = async () => ({ ...(await snapshot()), credit: 0n }); // stale view
  await assert.rejects(relayer.tick(), /StaleCredit/);
  assert.equal(chain.credit, usdc("9900"), "unchanged");
  chain.snapshot = snapshot;
  await relayer.tick();
  assert.equal(chain.credit, usdc("9900"));
});

test("unsent obligations reduce credit so we never over-promise", async () => {
  const { hl, chain, relayer } = setup();
  await relayer.tick();
  chain.deposit(ALICE, "4000");
  hl.failNextSend = "before"; // stays unsent this tick
  await relayer.tick();
  // HL still has 10,000; 4,000 is owed -> credit 10,000 - 4,000 - 100
  assert.equal(chain.credit, usdc("5900"));
});
