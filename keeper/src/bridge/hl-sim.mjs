// In-memory HyperCore USDC ledger for tests and local runs. Same interface as HlTransfers.
import { strToUsdc, usdcToStr } from "./units.mjs";

export class SimHyperCore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.balances = new Map(); // address -> units
    this.entries = [];
    this.n = 0;
  }

  fund(addr, usdc) {
    const a = addr.toLowerCase();
    this.balances.set(a, (this.balances.get(a) ?? 0n) + strToUsdc(usdc));
  }

  balanceOf(addr) {
    return this.balances.get(addr.toLowerCase()) ?? 0n;
  }

  /** User-side action: send USDC between HyperCore accounts (what usdSend does). */
  transfer(from, to, usdc) {
    const f = from.toLowerCase();
    const t = to.toLowerCase();
    const amt = strToUsdc(usdc);
    if (this.balanceOf(f) < amt) throw new Error("insufficient HyperCore balance");
    this.balances.set(f, this.balanceOf(f) - amt);
    this.balances.set(t, this.balanceOf(t) + amt);
    const hash = `0x${(++this.n).toString(16).padStart(64, "0")}`;
    this.entries.push({ hash, time: this.now(), from: f, to: t, usdc: usdcToStr(amt) });
    return { hash };
  }

  /** Relayer-facing view of one account. */
  accountView(account) {
    const sim = this;
    return {
      account,
      failNextSend: null, // "before" | "after" to simulate errors
      async balance() {
        return usdcToStr(sim.balanceOf(account));
      },
      async send(to, amount) {
        const mode = this.failNextSend;
        this.failNextSend = null;
        if (mode === "before") throw new Error("network error (not submitted)");
        const res = sim.transfer(account, to, amount);
        if (mode === "after") throw new Error("timeout (but it landed)");
        return res;
      },
      async ledger(sinceMs) {
        const a = account.toLowerCase();
        return sim.entries.filter((e) => e.time >= sinceMs && (e.from === a || e.to === a));
      },
    };
  }
}
