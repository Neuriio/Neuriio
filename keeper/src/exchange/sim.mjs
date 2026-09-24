// In-memory stand-in for HyperCore perps. Same interface as the Hyperliquid adapter,
// so the hedger can be tested end-to-end without a funded account.

export class SimExchange {
  constructor({ mid, szDecimals = 2, takerFeeBps = 4.5, fillRatio = 1 }) {
    this.mid = mid;
    this.szDecimals = szDecimals;
    this.takerFeeBps = takerFeeBps;
    this.fillRatio = fillRatio; // < 1 simulates partial fills
    this.position = 0;
    this.feesPaid = 0;
    this.orders = [];
  }

  async meta() {
    return { szDecimals: this.szDecimals };
  }

  async getMid() {
    return this.mid;
  }

  async getPosition() {
    return this.position;
  }

  /** IOC: fills at mid if the limit allows it, otherwise nothing. */
  async placeIoc({ isBuy, sz, limitPx }) {
    const size = Number(sz);
    const crosses = isBuy ? Number(limitPx) >= this.mid : Number(limitPx) <= this.mid;
    const filled = crosses ? Math.floor(size * this.fillRatio * 10 ** this.szDecimals + 1e-9) / 10 ** this.szDecimals : 0;
    this.position = +(this.position + (isBuy ? filled : -filled)).toFixed(this.szDecimals);
    this.feesPaid += filled * this.mid * (this.takerFeeBps / 10_000);
    const res = { filledSz: filled, avgPx: filled ? this.mid : 0 };
    this.orders.push({ isBuy, sz, limitPx, ...res });
    return res;
  }
}
