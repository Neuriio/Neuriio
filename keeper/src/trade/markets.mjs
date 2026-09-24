// Unified market catalog: HyperCore perps, spot pairs and HIP-4 outcome markets behind one shape.
// Pure (no I/O) so it can be tested on fixtures and run in the browser.
//
//   { id, kind: "perp"|"spot"|"outcome", symbol, coin, szDecimals, maxLeverage, mid, ... }
//
// Asset ids follow HyperCore: perp = index, spot = 10000 + pair index,
// outcome = 100000000 + 10 * outcome + side. `coin` is the key used by allMids / l2Book.

export const SPOT_BASE = 10_000;
export const OUTCOME_BASE = 100_000_000;
const OUTCOME_SZ_DECIMALS = 5; // outcome markets are absent from szDecimals metadata; all are 5

const num = (v) => (v === undefined || v === null ? null : Number(v));

export function normalizeMarkets({ meta, spotMeta, outcomeMeta, mids }) {
  const markets = [];

  meta.universe.forEach((u, i) => {
    if (u.isDelisted) return;
    markets.push({
      id: i,
      kind: "perp",
      symbol: u.name,
      coin: u.name,
      szDecimals: u.szDecimals,
      maxLeverage: u.maxLeverage,
      onlyIsolated: Boolean(u.onlyIsolated),
      mid: num(mids[u.name]),
    });
  });

  const tokens = new Map(spotMeta.tokens.map((t) => [t.index, t]));
  for (const pair of spotMeta.universe) {
    const [b, q] = pair.tokens.map((t) => tokens.get(t));
    markets.push({
      id: SPOT_BASE + pair.index,
      kind: "spot",
      symbol: `${b.name}/${q.name}`,
      coin: pair.name,
      base: b.name,
      quote: q.name,
      szDecimals: b.szDecimals,
      maxLeverage: 1,
      mid: num(mids[pair.name]),
    });
  }

  if (outcomeMeta) {
    const questionOf = new Map();
    for (const q of outcomeMeta.questions) for (const o of q.namedOutcomes) questionOf.set(o, q);
    const fallbacks = new Set(outcomeMeta.questions.map((q) => q.fallbackOutcome));
    const settled = new Set(outcomeMeta.questions.flatMap((q) => q.settledNamedOutcomes));
    for (const o of outcomeMeta.outcomes) {
      if (fallbacks.has(o.outcome) || settled.has(o.outcome)) continue; // not tradable
      const question = questionOf.get(o.outcome);
      o.sideSpecs.forEach((side, i) => {
        const n = 10 * o.outcome + i;
        markets.push({
          id: OUTCOME_BASE + n,
          kind: "outcome",
          symbol: `${o.name} · ${side.name}`,
          coin: `#${n}`,
          balanceCoin: `+${n}`,
          outcome: o.outcome,
          side: side.name,
          question: question?.name ?? null,
          description: o.description,
          quote: o.quoteToken,
          szDecimals: OUTCOME_SZ_DECIMALS,
          maxLeverage: 1,
          mid: num(mids[`#${n}`]),
        });
      });
    }
  }
  return markets;
}

export class MarketCatalog {
  constructor(markets) {
    this.set(markets);
  }

  set(markets) {
    this.all = markets;
    this.byId = new Map(markets.map((m) => [m.id, m]));
    this.byKey = new Map();
    for (const m of markets) {
      this.byKey.set(m.symbol.toUpperCase(), m);
      this.byKey.set(m.coin.toUpperCase(), m);
      if (m.balanceCoin) this.byKey.set(m.balanceCoin, m);
    }
  }

  /** Look up by asset id, symbol ("HYPE", "KNTQ/USDC"), or coin ("@107", "#12090", "+12090"). */
  get(key) {
    const m = typeof key === "number" ? this.byId.get(key) : this.byKey.get(String(key).toUpperCase());
    if (!m) throw new Error(`unknown market: ${key}`);
    return m;
  }

  updateMids(mids) {
    for (const m of this.all) if (mids[m.coin] !== undefined) m.mid = Number(mids[m.coin]);
  }

  list(kind) {
    return kind ? this.all.filter((m) => m.kind === kind) : this.all;
  }
}
