// The fee router's records: every fee seen, every payout run and every transaction in it. It's what stops anything being
// paid twice. Amounts are bigints here and text in the database. Tables: migration 20261101181131_fee_router.sql.
const key = (r) => `${r.txHash}:${r.logIndex}`;

/** In memory, for tests. */
export function memoryLedger() {
  let cursor = null;
  const receipts = new Map();
  const runs = [];
  return {
    receipts,
    runs,
    getCursor: async () => cursor,
    setCursor: async (b) => void (cursor = b),
    addReceipts: async (rows) => {
      for (const r of rows) if (!receipts.has(key(r))) receipts.set(key(r), { ...r, runId: null });
    },
    unpaidMatched: async () => [...receipts.values()].filter((r) => r.token && r.runId === null),
    unmatchedTotal: async () => [...receipts.values()].filter((r) => !r.token && r.runId === null).reduce((a, r) => a + r.amount, 0n),
    openRun: async () => runs.find((r) => r.status !== "done") ?? null,
    createRun: async (total, picked, items) => {
      const run = { id: runs.length + 1, status: "open", total, items: items.map((it, seq) => ({ ...it, id: seq + 1, seq, status: "pending", txHash: null, rawTx: null })) };
      for (const r of picked) receipts.get(key(r)).runId = run.id;
      runs.push(run);
      return run;
    },
    saveSigned: async (item, txHash, rawTx) => Object.assign(item, { txHash, rawTx }),
    setItemStatus: async (item, status) => void (item.status = status),
    addToItem: async (item, amount) => void (item.amount += amount),
    setRunStatus: async (run, status, note) => void Object.assign(run, { status, note }),
  };
}

/** Supabase, through its REST API with the service key. `prefix` "partner_" + cursor "fees:partner:cursor" = the partner fee
 *  tables (20261107200000_partner_fees.sql), whose receipts also store quote / fee_raw / price_usd. */
export function supabaseLedger(url, serviceKey, { prefix = "", cursor = "fees:cursor" } = {}) {
  const api = async (path, { method = "GET", body, prefer } = {}) => {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`supabase ${method} ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  const toReceipt = (r) => ({ txHash: r.tx_hash, logIndex: r.log_index, amount: BigInt(r.amount), token: r.token });
  const toItem = (i) => ({ id: i.id, seq: i.seq, kind: i.kind, token: i.token, amount: BigInt(i.amount), status: i.status, txHash: i.tx_hash, rawTx: i.raw_tx });
  const CURSOR = cursor;
  const loadRun = async (run) => {
    const items = await api(`${prefix}fee_run_items?run_id=eq.${run.id}&order=seq`);
    return { id: run.id, status: run.status, total: BigInt(run.total), items: items.map(toItem) };
  };
  return {
    getCursor: async () => {
      const rows = await api(`indexer_state?key=eq.${encodeURIComponent(CURSOR)}&select=value`);
      return rows[0] ? BigInt(rows[0].value) : null;
    },
    setCursor: (b) => api("indexer_state?on_conflict=key", { method: "POST", body: { key: CURSOR, value: b.toString() }, prefer: "resolution=merge-duplicates" }),
    addReceipts: async (rows) => {
      if (!rows.length) return;
      await api(`${prefix}fee_receipts?on_conflict=tx_hash,log_index`, {
        method: "POST",
        prefer: "resolution=ignore-duplicates",
        body: rows.map((r) => ({
          tx_hash: r.txHash,
          log_index: r.logIndex,
          block_number: r.blockNumber.toString(),
          from_address: r.from,
          amount: r.amount.toString(),
          token: r.token,
          pool: r.pool,
          reason: r.reason,
          ...(r.quote === undefined ? {} : { quote: r.quote, fee_raw: r.feeRaw.toString(), price_usd: r.priceUsd ?? null }),
        })),
      });
    },
    unpaidMatched: async () => (await api(`${prefix}fee_receipts?token=not.is.null&run_id=is.null&select=tx_hash,log_index,amount,token`)).map(toReceipt),
    unmatchedTotal: async () => (await api(`${prefix}fee_receipts?token=is.null&run_id=is.null&select=amount`)).reduce((a, r) => a + BigInt(r.amount), 0n),
    openRun: async () => {
      const rows = await api(`${prefix}fee_runs?status=neq.done&order=id&limit=1`);
      return rows[0] ? loadRun(rows[0]) : null;
    },
    createRun: async (total, picked, items) => {
      const id = await api(`rpc/${prefix}fee_create_run`, {
        method: "POST",
        body: {
          p_total: total.toString(),
          p_receipts: picked.map((r) => ({ tx_hash: r.txHash, log_index: r.logIndex })),
          p_items: items.map((it) => ({ kind: it.kind, token: it.token ?? null, amount: it.amount.toString() })),
        },
      });
      return loadRun({ id, status: "open", total: total.toString() });
    },
    saveSigned: async (item, txHash, rawTx) => {
      await api(`${prefix}fee_run_items?id=eq.${item.id}`, { method: "PATCH", body: { tx_hash: txHash, raw_tx: rawTx } });
      Object.assign(item, { txHash, rawTx });
    },
    setItemStatus: async (item, status) => {
      await api(`${prefix}fee_run_items?id=eq.${item.id}`, { method: "PATCH", body: { status } });
      item.status = status;
    },
    addToItem: async (item, amount) => {
      item.amount += amount;
      await api(`${prefix}fee_run_items?id=eq.${item.id}`, { method: "PATCH", body: { amount: item.amount.toString() } });
    },
    setRunStatus: async (run, status, note) => {
      await api(`${prefix}fee_runs?id=eq.${run.id}`, { method: "PATCH", body: { status, note: note ?? null } });
      Object.assign(run, { status, note });
    },
  };
}
