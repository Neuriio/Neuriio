// Keeps the HyperCore perp hedge matched to the PropAMM pool's base inventory.
//
// Reconcile loop (idempotent): read pool inventory + perp position -> order the difference.
// Missed events, restarts and partial fills self-heal on the next pass. If the hedge can't
// keep up (exchange down, no fills), the pool is paused before exposure grows.
import { planHedge, unhedgedNotional } from "./planner.mjs";

export class Hedger {
  /**
   * @param {object} o
   * @param {() => Promise<number>} o.getPoolBase  pool base inventory, whole tokens
   * @param {() => Promise<void>} o.pausePool
   * @param {object} o.exchange                     SimExchange | HyperliquidExchange
   * @param {object} o.cfg  { hedgeRatio, maxSlippageBps, minNotional, maxUnhedgedUsd, graceMs, maxOrdersPerPass, dryRun }
   * @param {(e: object) => void} [o.log]
   * @param {() => number} [o.now]
   */
  constructor({ getPoolBase, pausePool, exchange, cfg, log = (e) => console.log(JSON.stringify(e)), now = Date.now }) {
    Object.assign(this, { getPoolBase, pausePool, exchange, cfg, log, now });
    this.busy = false;
    this.dirty = false;
    this.breachSince = null;
    this.paused = false;
  }

  /** Safe to call from every Swap event and a timer; passes never overlap. */
  async reconcile(reason = "timer") {
    if (this.busy) {
      this.dirty = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.dirty = false;
        await this._pass(reason);
        reason = "coalesced";
      } while (this.dirty);
    } finally {
      this.busy = false;
    }
  }

  async _pass(reason) {
    const { szDecimals } = await this.exchange.meta();
    const { hedgeRatio, maxSlippageBps, minNotional, maxOrdersPerPass = 3, dryRun } = this.cfg;

    let state;
    for (let i = 0; i < maxOrdersPerPass; i++) {
      state = await this._state();
      const plan = planHedge({ ...state, hedgeRatio, szDecimals, minNotional, maxSlippageBps });
      if (!plan) break;

      if (dryRun) {
        this.log({ ev: "hedge_planned", reason, ...state, ...plan });
        break;
      }
      let fill;
      try {
        fill = await this.exchange.placeIoc(plan);
      } catch (e) {
        fill = { filledSz: 0, error: e.message };
      }
      this.log({ ev: "hedge_order", reason, ...state, ...plan, ...fill });
      if (!fill.filledSz) break; // no progress this pass; risk check below decides what to do
    }

    state = await this._state();
    await this._risk(state);
  }

  async _state() {
    const [poolBase, perpPosition, mid] = await Promise.all([
      this.getPoolBase(),
      this.exchange.getPosition(),
      this.exchange.getMid(),
    ]);
    return { poolBase, perpPosition, mid };
  }

  async _risk(state) {
    const unhedged = unhedgedNotional({ ...state, hedgeRatio: this.cfg.hedgeRatio });
    if (unhedged <= this.cfg.maxUnhedgedUsd) {
      this.breachSince = null;
      return;
    }
    this.breachSince ??= this.now();
    const breachMs = this.now() - this.breachSince;
    this.log({ ev: "unhedged_breach", unhedgedUsd: Math.round(unhedged), breachMs });
    if (breachMs >= this.cfg.graceMs && !this.paused && !this.cfg.dryRun) {
      await this.pausePool();
      this.paused = true;
      this.log({ ev: "pool_paused", unhedgedUsd: Math.round(unhedged) });
    }
  }
}
