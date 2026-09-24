// FastBridge relayer: moves USDC between Elysium and users' own HyperCore accounts.
//
// Every tick, in order:
//   1. Deposits  — credit each pending FastBridge deposit on HyperCore, then mark it fulfilled.
//   2. Withdraws — pay out on Elysium for every USDC transfer users sent to our HyperCore account.
//   3. Credit    — keep on-chain `credit` = HyperCore balance − unsent obligations − buffer,
//                  so the contract never accepts a deposit we can't deliver.
//
// Money-safety rules:
//   - Write-ahead log: a deposit is recorded as "sending" before the HyperCore transfer. After a
//     crash, "sending" entries are checked against the HyperCore ledger instead of re-sent blindly.
//   - Deposits close to their refund time are never sent (the user may be refunding on-chain).
//   - Payouts are keyed by HyperCore tx hash; the contract also rejects duplicates.
import { usdcToStr, strToUsdc } from "./units.mjs";

export class Relayer {
  /**
   * @param {object} o
   * @param {object} o.chain  { snapshot(), markFulfilled(ids), payout(ref, to, units), setCredit(from, to) }
   * @param {object} o.hl     { account, balance(), send(to, amountStr), ledger(sinceMs) }
   * @param {object} o.store  { data, save() }
   * @param {object} o.cfg    { refundDelayMs, refundMarginMs, resendAfterMs, creditBuffer (units), creditStep (units),
   *                            topupFrom?: string[] (treasury addresses whose transfers are inventory top-ups, not withdrawals) }
   */
  constructor({ chain, hl, store, cfg, log = (e) => console.log(JSON.stringify(e)), now = Date.now }) {
    Object.assign(this, { chain, hl, store, cfg, log, now });
    store.data.sending ??= {};
    store.data.sent ??= {};
    store.data.paid ??= {};
    store.data.failedPayouts ??= {};
    store.data.attributed ??= {}; // ledger hashes already matched to a deposit
    store.data.topups ??= {}; // inventory top-ups from treasury addresses (never paid out)
    this.topupFrom = new Set((cfg.topupFrom ?? []).map((a) => a.toLowerCase()));
    store.data.cursorMs ??= now() - 60_000;
    this.busy = false;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const snap = await this.chain.snapshot(); // { credit, pending: [{id, hlRecipient, amount, createdAtMs}] }
      // look back far enough to verify any unconfirmed send and catch late-indexed transfers
      const oldestPending = Math.min(...snap.pending.map((p) => p.createdAtMs));
      const since = Math.min(this.store.data.cursorMs, Number.isFinite(oldestPending) ? oldestPending : Infinity);
      const ledger = await this.hl.ledger(since - 60_000);
      const handled = await this._deposits(snap.pending, ledger);
      await this._withdrawals(ledger);
      await this._credit(snap, handled);
      const cutoff = this.now() - 3 * 3_600_000;
      for (const [h, t] of Object.entries(this.store.data.attributed)) if (t < cutoff) delete this.store.data.attributed[h];
      this.store.save();
    } finally {
      this.busy = false;
    }
  }

  // ---------------------------------------------------------------- 1. Elysium -> HyperCore

  async _deposits(pending, ledger) {
    const d = this.store.data;
    const toMark = [];
    for (const dep of pending) {
      const key = String(dep.id);
      if (d.sent[key]) {
        toMark.push(dep.id);
        continue;
      }
      if (d.sending[key]) {
        const { match, ambiguous } = this._findOutgoing(ledger, dep);
        if (ambiguous) {
          // Several identical transfers could be ours: never guess with money. Hold for review.
          this.log({ ev: "deposit_needs_review", id: dep.id, candidates: ambiguous });
          continue;
        }
        if (match) {
          this._recordSent(key, match.hash);
          this.log({ ev: "deposit_recovered", id: dep.id, hash: match.hash });
          toMark.push(dep.id);
          continue;
        }
        // Not in the ledger yet. A send that errored client-side may still land, so give the
        // ledger time to index it before retrying; otherwise we could credit twice.
        if (this.now() - d.sending[key].at < this.cfg.resendAfterMs) continue;
      }
      const age = this.now() - dep.createdAtMs;
      if (age > this.cfg.refundDelayMs - this.cfg.refundMarginMs) {
        if (!d.sending[key]) this.log({ ev: "deposit_expired", id: dep.id, note: "left for user refund" });
        continue;
      }

      const amount = usdcToStr(dep.amount);
      d.sending[key] = { to: dep.hlRecipient, amount, at: this.now() };
      this.store.save();
      try {
        const res = await this.hl.send(dep.hlRecipient, amount);
        this._recordSent(key, res.hash);
        this.log({ ev: "deposit_credited", id: dep.id, to: dep.hlRecipient, amount, hash: res.hash });
        toMark.push(dep.id);
      } catch (e) {
        // keep the "sending" entry: next tick verifies against the ledger before retrying
        this.log({ ev: "deposit_send_failed", id: dep.id, error: e.message });
      }
    }
    if (toMark.length) {
      await this.chain.markFulfilled(toMark);
      for (const id of toMark) delete d.sent[String(id)];
      this.store.save();
      this.log({ ev: "deposits_marked", ids: toMark });
    }
    return new Set(toMark);
  }

  _recordSent(key, hash) {
    const d = this.store.data;
    d.sent[key] = { hash };
    if (hash) d.attributed[hash] = this.now();
    delete d.sending[key];
    this.store.save();
  }

  /** Our outgoing transfer for `dep`, if exactly one unattributed ledger entry fits. */
  _findOutgoing(ledger, dep) {
    const want = usdcToStr(dep.amount);
    const hits = ledger.filter(
      (e) =>
        e.from === this.hl.account.toLowerCase() &&
        e.to === dep.hlRecipient.toLowerCase() &&
        e.usdc === want &&
        e.time >= dep.createdAtMs &&
        !this.store.data.attributed[e.hash],
    );
    const twins = Object.values(this.store.data.sending).filter((s) => s.to === dep.hlRecipient && s.amount === want);
    if (hits.length > 1 || (hits.length === 1 && twins.length > 1)) return { ambiguous: hits.map((h) => h.hash) };
    return { match: hits[0] };
  }

  // ---------------------------------------------------------------- 2. HyperCore -> Elysium

  async _withdrawals(ledger) {
    const d = this.store.data;
    const me = this.hl.account.toLowerCase();
    let maxTime = d.cursorMs;
    for (const e of ledger) {
      if (e.to !== me || e.from === me) continue;
      maxTime = Math.max(maxTime, e.time);
      if (d.paid[e.hash] || d.topups[e.hash]) continue;
      if (this.topupFrom.has(e.from)) {
        // Funding our own inventory looks exactly like a user withdrawal on the ledger.
        d.topups[e.hash] = { from: e.from, usdc: e.usdc };
        delete d.failedPayouts[e.hash];
        this.log({ ev: "inventory_topup", hash: e.hash, from: e.from, usdc: e.usdc });
        continue;
      }
      try {
        await this.chain.payout(e.hash, e.from, strToUsdc(e.usdc));
        d.paid[e.hash] = { to: e.from, usdc: e.usdc };
        delete d.failedPayouts[e.hash];
        this.log({ ev: "withdrawal_paid", hash: e.hash, to: e.from, usdc: e.usdc });
      } catch (err) {
        if (/AlreadyPaid/.test(err.message)) {
          d.paid[e.hash] = { to: e.from, usdc: e.usdc };
          continue;
        }
        // caps / liquidity: retried every tick, surfaced for manual action
        d.failedPayouts[e.hash] = { to: e.from, usdc: e.usdc, error: err.message };
        this.log({ ev: "withdrawal_payout_failed", hash: e.hash, error: err.message });
      }
    }
    // Cursor only bounds how much history we fetch (d.paid dedupes). Never skip past a transfer
    // whose payout failed; otherwise trail `now` by a window that covers ledger indexing delay.
    const oldestFailed = Math.min(...ledger.filter((e) => d.failedPayouts[e.hash]).map((e) => e.time));
    d.cursorMs = Number.isFinite(oldestFailed) ? oldestFailed : Math.max(maxTime, this.now() - 10 * 60_000);
    this.store.save();
  }

  // ---------------------------------------------------------------- 3. credit

  /** @param {Set<number>} handled deposits already paid on HyperCore (reflected in the balance) */
  async _credit(snap, handled) {
    const balance = strToUsdc(await this.hl.balance());
    // Obligations not yet paid on HyperCore. "sending" entries count too: if one did land, it is
    // subtracted twice for a tick, which only errs toward less credit.
    const unsent = snap.pending.filter((p) => !handled.has(p.id)).reduce((s, p) => s + p.amount, 0n);
    let target = balance - unsent - this.cfg.creditBuffer;
    if (target < 0n) target = 0n;
    const diff = target > snap.credit ? target - snap.credit : snap.credit - target;
    // shrink immediately; grow in steps to avoid churn
    if (target < snap.credit || diff >= this.cfg.creditStep) {
      await this.chain.setCredit(snap.credit, target);
      this.log({ ev: "credit_set", from: usdcToStr(snap.credit), to: usdcToStr(target), hlBalance: usdcToStr(balance) });
    }
  }
}
