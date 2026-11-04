// Launch check (user, 2026-11-01): who bought a token right after it launched, and which of them are tied together. Pure (no I/O); the
// chain reads are in check.mjs. Timing alone proves nothing, since unrelated snipers buy early too, so a wallet only counts as linked
// with real evidence: the same transaction, a shared funder, or a transfer between them.

/** Groups wallets joined by any chain of edges: address -> group number (from 1), for groups of 2 or more. */
export function groupsOf(addresses, edges) {
  const parent = new Map(addresses.map((a) => [a, a]));
  const find = (a) => {
    while (parent.get(a) !== a) {
      parent.set(a, parent.get(parent.get(a)));
      a = parent.get(a);
    }
    return a;
  };
  for (const e of edges) {
    if (parent.has(e.a) && parent.has(e.b)) parent.set(find(e.a), find(e.b));
  }
  const members = new Map();
  for (const a of addresses) members.set(find(a), [...(members.get(find(a)) ?? []), a]);
  const out = new Map();
  let n = 0;
  for (const group of members.values()) {
    if (group.length < 2) continue;
    n++;
    for (const a of group) out.set(a, n);
  }
  return out;
}

/** Edges for wallets receiving tokens in one transaction. */
export function sameTxEdges(receipts) {
  const byTx = new Map();
  for (const r of receipts) byTx.set(r.txHash, new Set([...(byTx.get(r.txHash) ?? []), r.wallet]));
  const edges = [];
  for (const [txHash, wallets] of byTx) {
    const [first, ...rest] = wallets;
    for (const b of rest) edges.push({ a: first, b, reason: "same_tx", via: txHash });
  }
  return edges;
}

/**
 * Edges from USDC funding: a wallet that funded another directly, or a funder shared by two or more wallets. `funding` is
 * [{ from, to }]; `ignored` is what can't tell anything: contracts, bridges, and hubs that pay out to everyone.
 */
export function fundingEdges(funding, wallets, ignored = new Set()) {
  const inGroup = new Set(wallets);
  const byFunder = new Map();
  const edges = [];
  for (const { from, to } of funding) {
    if (from === to || !inGroup.has(to)) continue;
    if (inGroup.has(from)) edges.push({ a: from, b: to, reason: "funded_directly", via: from });
    else if (!ignored.has(from)) byFunder.set(from, new Set([...(byFunder.get(from) ?? []), to]));
  }
  for (const [funder, funded] of byFunder) {
    const [first, ...rest] = funded;
    for (const b of rest) edges.push({ a: first, b, reason: "same_funder", via: funder });
  }
  return edges;
}

/** Funders shared by two or more of `wallets`: the only ones worth checking whether they're a hub. */
export function sharedFunders(funding, wallets) {
  const inGroup = new Set(wallets);
  const byFunder = new Map();
  for (const { from, to } of funding) {
    if (!inGroup.has(to) || inGroup.has(from)) continue;
    byFunder.set(from, new Set([...(byFunder.get(from) ?? []), to]));
  }
  return [...byFunder].filter(([, funded]) => funded.size >= 2).map(([funder]) => funder);
}

const pctOf = (amount, supply) => (supply > 0n ? Number((amount * 1_000_000n) / supply) / 10_000 : 0);

/**
 * What the widget shows. `bought`: address -> tokens received in the window. `holdings`: address -> tokens held or staked now.
 * The creator's own first buy is shown apart, and only counts with the others if it's linked to them.
 */
export function summarize({ bought, creator, edges, holdings, supply, windowSeconds }) {
  const addresses = [...bought.keys()];
  const groups = groupsOf(addresses, edges);
  const reasons = new Map();
  for (const e of edges) {
    for (const a of [e.a, e.b]) {
      if (groups.has(a)) reasons.set(a, new Set([...(reasons.get(a) ?? []), e.reason]));
    }
  }
  const wallets = addresses
    .map((address) => ({
      address,
      pct: pctOf(bought.get(address), supply),
      heldPct: pctOf(holdings.get(address) ?? 0n, supply),
      group: groups.get(address) ?? null,
      creator: address === creator,
      reasons: [...(reasons.get(address) ?? [])],
      tokens: bought.get(address),
    }))
    .sort((x, y) => (x.tokens === y.tokens ? 0 : x.tokens > y.tokens ? -1 : 1))
    .map(({ tokens, ...w }) => w);
  const sum = (list, key) => pctOf(list.reduce((a, w) => a + (key === "held" ? holdings.get(w.address) ?? 0n : bought.get(w.address)), 0n), supply);
  const early = wallets.filter((w) => !w.creator || w.group !== null);
  const linked = wallets.filter((w) => w.group !== null);
  const me = wallets.find((w) => w.creator);
  return {
    status: linked.length ? "linked" : early.length ? "fast" : "none",
    window_seconds: windowSeconds,
    early_wallets: early.length,
    early_pct: sum(early, "bought"),
    linked_wallets: linked.length,
    linked_pct: sum(linked, "bought"),
    held_pct: sum(linked.length ? linked : early, "held"),
    creator_pct: me && me.group === null ? me.pct : 0,
    wallets,
  };
}
