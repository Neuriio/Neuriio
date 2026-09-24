// One view of a user's HyperCore account: perp positions, spot balances and outcome positions,
// each with live value and PnL. Pure: takes raw API responses, returns plain numbers.

export function summarizePortfolio({ perpState, spotState, catalog }) {
  const n = (v) => (v === null || v === undefined ? null : Number(v));

  const perps = perpState.assetPositions.map(({ position: p }) => {
    const m = safeGet(catalog, p.coin);
    const size = n(p.szi);
    return {
      symbol: p.coin,
      side: size > 0 ? "long" : "short",
      size: Math.abs(size),
      entryPx: n(p.entryPx),
      markPx: m?.mid ?? null,
      positionValue: n(p.positionValue),
      unrealizedPnl: n(p.unrealizedPnl),
      roePct: n(p.returnOnEquity) * 100,
      liquidationPx: n(p.liquidationPx),
      leverage: p.leverage.value,
      marginMode: p.leverage.type,
      marginUsed: n(p.marginUsed),
      fundingSinceOpen: -n(p.cumFunding.sinceOpen), // API reports paid as positive
    };
  });

  const spot = [];
  const outcomes = [];
  for (const b of spotState.balances) {
    const total = n(b.total);
    if (!total) continue;
    if (b.coin.startsWith("+")) {
      const m = safeGet(catalog, b.coin);
      const value = m?.mid != null ? total * m.mid : null;
      outcomes.push({
        symbol: m?.symbol ?? b.coin,
        question: m?.question ?? null,
        shares: total,
        price: m?.mid ?? null,
        value,
        cost: n(b.entryNtl),
        pnl: value != null ? value - n(b.entryNtl) : null,
        payoutIfWins: total, // settles to 1 USDC per share
      });
    } else if (b.coin.startsWith("o")) {
      outcomes.push({ symbol: b.coin, settled: true, shares: total, cost: n(b.entryNtl) });
    } else {
      const px = b.coin === "USDC" ? 1 : spotPrice(catalog, b.coin);
      const value = px != null ? total * px : null;
      spot.push({
        coin: b.coin,
        total,
        onHold: n(b.hold),
        price: px,
        value,
        cost: b.coin === "USDC" ? total : n(b.entryNtl),
        pnl: value != null && b.coin !== "USDC" ? value - n(b.entryNtl) : null,
      });
    }
  }

  const sum = (xs, k) => xs.reduce((s, x) => s + (x[k] ?? 0), 0);
  return {
    perpAccountValue: n(perpState.marginSummary.accountValue),
    withdrawable: n(perpState.withdrawable),
    perps,
    spot,
    outcomes,
    totals: {
      unrealizedPnl: sum(perps, "unrealizedPnl") + sum(spot, "pnl") + sum(outcomes, "pnl"),
      netValue: n(perpState.marginSummary.accountValue) + sum(spot, "value") + sum(outcomes, "value"),
    },
  };
}

function safeGet(catalog, key) {
  try {
    return catalog.get(key);
  } catch {
    return null;
  }
}

function spotPrice(catalog, coin) {
  for (const q of ["USDC", "USDH", "USDT0", "USDE"]) {
    const m = safeGet(catalog, `${coin}/${q}`);
    if (m?.mid) return m.mid;
  }
  return null;
}
