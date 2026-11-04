// The Feed's portfolio (user, 2026-11-02): the balance across your wallets, then your tokens on Elysium as tiles, plus adding a wallet.
// Adding one only shares its address (lib/wagmi.ts): keys stay in the wallet, and nothing here asks it to sign or send (only the referral Verify in Account asks for a free signature).
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import type { Address } from "viem";
import { type Connector, useConnect, useConnections, useConnectors, useDisconnect } from "wagmi";
import { ExternalLink, LoaderCircle, Plus, X } from "lucide-react";
import { DEMO, tickerOf } from "../lib/explore";
import { compactUsd, shortAddress, usd } from "../lib/format";
import { DEMO_HISTORY, DEMO_PORTFOLIO, fetchPortfolio, recordSnapshot, type Portfolio, type Snapshot } from "../lib/portfolio";
import { WALLETS } from "../lib/wagmi";
import { DotNumber } from "./DotNumber";

export function PortfolioPanel() {
  const { authenticated } = usePrivy();
  const { wallets } = useWallets();
  const neuriio = authenticated ? (wallets.find((w) => w.walletClientType === "privy")?.address as Address | undefined) : undefined;
  const connections = useConnections();
  const added = useMemo(() => {
    const seen = new Set<string>();
    return connections.flatMap((c) =>
      c.accounts
        .filter((a) => a.toLowerCase() !== neuriio?.toLowerCase() && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()))
        .map((address) => ({ address, connector: c.connector })),
    );
  }, [connections, neuriio]);
  const addresses = useMemo(() => [...(neuriio ? [neuriio] : []), ...added.map((a) => a.address)] as Address[], [neuriio, added]);
  const key = addresses.map((a) => a.toLowerCase()).sort().join(",");

  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (DEMO) {
      setPortfolio(DEMO_PORTFOLIO);
      setHistory(DEMO_HISTORY);
      return;
    }
    setPortfolio(null);
    if (!addresses.length) return;
    let alive = true;
    const load = () =>
      fetchPortfolio(addresses).then(
        (p) => {
          if (!alive) return;
          setPortfolio(p);
          setHistory(recordSnapshot(p.parts, key));
        },
        () => {},
      );
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [key]);

  const nobody = !DEMO && !addresses.length;
  return (
    <div className="pf">
      <div className="pf-wallets">
        {neuriio && (
          <span className="pf-wallet" title={neuriio}>
            <img className="pf-wallet-logo" src="/brand/logo.png" alt="" />
            Neuriio · {shortAddress(neuriio)}
          </span>
        )}
        {added.map((a) => (
          <WalletChip key={a.address} address={a.address} connector={a.connector} />
        ))}
        <button className="pf-add" onClick={() => setAdding(true)}>
          <Plus size={12} /> Add wallet
        </button>
      </div>
      <BalanceCard portfolio={portfolio} history={history} empty={nobody} />
      <TokenTiles tokens={portfolio?.elysium ?? null} />
      <AddWalletModal open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

function WalletChip({ address, connector }: { address: string; connector: Connector }) {
  const { mutate: disconnect } = useDisconnect();
  return (
    <span className="pf-wallet" title={address}>
      {connector.name} · {shortAddress(address)}
      <button className="pf-wallet-x" aria-label={`Remove ${address}`} onClick={() => disconnect({ connector })}>
        <X size={11} />
      </button>
    </span>
  );
}

// ------------------------------------------------------------------ balance

const money = (n: number) => (n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);

function BalanceCard({ portfolio, history, empty }: { portfolio: Portfolio | null; history: Snapshot[]; empty: boolean }) {
  const first = history[0];
  const total = portfolio?.total ?? 0;
  const before = first ? first.usdc + first.hype + first.tokens : 0;
  const change = history.length > 1 && before > 0 ? total - before : null;
  return (
    <section className="pf-card pf-balance" aria-label="Portfolio balance">
      <header className="pf-head">
        <span className="pf-title">Portfolio</span>
      </header>
      <div className="pf-total">
        <DotNumber text={portfolio ? money(total) : empty ? "$0" : "..."} label={portfolio ? usd(total) : "Loading"} />
        {change !== null && (
          <span className="pf-change">
            <b className={change >= 0 ? "is-up" : "is-down"}>
              {change >= 0 ? "↑" : "↓"} {Math.abs((change / before) * 100).toFixed(1)}%
            </b>
            <span>
              {change >= 0 ? "+" : "-"}
              {compactUsd(Math.abs(change))} since {new Date(`${first.day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
            </span>
          </span>
        )}
      </div>
      {empty ? <p className="pf-empty">Log in or add a wallet to see your balance.</p> : <BalanceLine history={history} />}
    </section>
  );
}

const totalOf = (d: Snapshot) => d.usdc + d.hype + d.tokens;
const timeOf = (d: Snapshot) => Date.parse(`${d.day}T00:00:00Z`);
const shortDay = (d: Snapshot) => new Date(timeOf(d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A round number at or above `v`, so the axis halves read cleanly. */
function roundUp(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 1.5, 2, 3, 4, 5, 6, 8, 10].find((m) => m * p >= v) ?? 10) * p;
}

/** The balance over time, from $0. With only today so far, a flat line. */
function BalanceLine({ history }: { history: Snapshot[] }) {
  if (!history.length) return <div className="pf-line" />;
  const top = roundUp(Math.max(...history.map(totalOf)));
  const [from, to] = [timeOf(history[0]), timeOf(history[history.length - 1])];
  const xAt = (d: Snapshot) => (to > from ? ((timeOf(d) - from) / (to - from)) * 100 : 100);
  const yAt = (d: Snapshot) => (1 - totalOf(d) / top) * 100;
  const points = history.length > 1 ? history.map((d) => `${xAt(d)},${yAt(d)}`) : [`0,${yAt(history[0])}`, `100,${yAt(history[0])}`];
  const last = history[history.length - 1];
  const middle = history[Math.floor((history.length - 1) / 2)];
  const dates = history.length > 2 ? [history[0], middle, last] : history.length === 2 ? [history[0], last] : [last];
  return (
    <div className="pf-line" role="img" aria-label={`Balance over time, now ${usd(totalOf(last))}`}>
      <div className="pf-line-y" aria-hidden>
        {[top, top / 2, 0].map((v) => (
          <span key={v}>{compactUsd(v)}</span>
        ))}
      </div>
      <div className="pf-line-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          <polyline points={points.join(" ")} />
        </svg>
        <span className="pf-line-dot" style={{ left: "100%", top: `${yAt(last)}%` }} />
      </div>
      <div className={`pf-line-x${dates.length === 1 ? " is-one" : ""}`} aria-hidden>
        {dates.map((d) => (
          <span key={d.day}>{shortDay(d)}</span>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ tiles

type TileItem = { symbol: string | null; usd: number; share: number; weight: number }; // symbol null: a blank placeholder
type Tile = TileItem & { x: number; y: number; w: number; h: number };
const MAX_TILES = 6;
const SLOTS = 7; // fewer tokens than this: blank tiles fill the rest, showing how it looks with more
const SLOT_WEIGHTS = [5, 4, 3, 3, 2.5, 2, 2];

/** Lays tiles out by weight, splitting along the longer side. */
export function layoutTiles(items: TileItem[], x = 0, y = 0, w = 100, h = 100): Tile[] {
  if (!items.length) return [];
  if (items.length === 1) return [{ ...items[0], x, y, w, h }];
  const all = items.reduce((a, i) => a + i.weight, 0);
  let cut = 1;
  for (let so = items[0].weight; cut < items.length - 1 && so + items[cut].weight / 2 < all / 2; cut++) so += items[cut].weight;
  const a = items.slice(0, cut);
  const part = a.reduce((s, i) => s + i.weight, 0) / all;
  if (w >= h) return [...layoutTiles(a, x, y, w * part, h), ...layoutTiles(items.slice(cut), x + w * part, y, w * (1 - part), h)];
  return [...layoutTiles(a, x, y, w, h * part), ...layoutTiles(items.slice(cut), x, y + h * part, w, h * (1 - part))];
}

function TokenTiles({ tokens }: { tokens: Portfolio["elysium"] | null }) {
  const tiles = useMemo(() => {
    const held = tokens ?? [];
    const total = held.reduce((a, t) => a + t.usd, 0);
    const shareOf = (v: number) => (total ? (v / total) * 100 : 0);
    if (held.length >= SLOTS) {
      // real tokens only: sized by the square root of value with a floor, so a small holding can still be read
      const shown = held.slice(0, MAX_TILES).map((t) => ({ symbol: t.symbol, usd: t.usd }));
      const rest = held.slice(MAX_TILES).reduce((a, t) => a + t.usd, 0);
      shown.push({ symbol: `+${held.length - MAX_TILES} more`, usd: rest });
      const floor = Math.sqrt(shown[0].usd) * 0.45;
      return layoutTiles(shown.map((t) => ({ ...t, share: shareOf(t.usd), weight: Math.max(Math.sqrt(t.usd), floor) || 1 })));
    }
    return layoutTiles(
      SLOT_WEIGHTS.map((weight, i) => {
        const t = held[i];
        return { symbol: t?.symbol ?? null, usd: t?.usd ?? 0, share: t ? shareOf(t.usd) : 0, weight };
      }),
    );
  }, [tokens]);
  return (
    <section className="pf-card pf-tokens" aria-label="Tokens on Elysium">
      <header className="pf-head">
        <span className="pf-title">Tokens on Elysium</span>
      </header>
      <div className="pf-tiles">
        {tiles.map((t, i) => (
          <div
            key={t.symbol ?? `blank-${i}`}
            className={`pf-tile${t.symbol ? ` is-tone-${i % 6}` : " is-blank"}`}
            style={{ left: `${t.x}%`, top: `${t.y}%`, width: `${t.w}%`, height: `${t.h}%` }}
            title={t.symbol ? `${t.symbol}: ${usd(t.usd)}` : undefined}
            aria-hidden={!t.symbol}
          >
            <div className="pf-tile-in">
              {t.symbol && (
                <>
                  <span className="pf-tile-name">{t.symbol.startsWith("$") ? tickerOf(t.symbol.slice(1)) : t.symbol}</span>
                  <span className="pf-tile-foot">
                    <b>{compactUsd(t.usd)}</b>
                    <i>{t.share.toFixed(t.share < 10 ? 1 : 0)}%</i>
                  </span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ adding a wallet

function AddWalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const connectors = useConnectors();
  const connections = useConnections();
  const { mutate: connect, isPending, variables, error, reset } = useConnect();
  useEffect(() => {
    if (!open) return;
    reset();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  const rejected = error && /rejected|denied/i.test(error.message);
  return createPortal(
    <div className="nt-backdrop" data-morph-keep onClick={onClose}>
      <div className="nt-modal pf-modal" role="dialog" aria-modal="true" aria-label="Add a wallet" onClick={(e) => e.stopPropagation()}>
        <header className="nt-head">
          <span className="nt-title">Add a wallet</span>
          <button className="ex-modal-close" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <ul className="pf-options">
          {WALLETS.map((w) => {
            const c = connectors.find((x) => x.id === w.id);
            const on = connections.some((x) => x.connector.id === w.id);
            const busy = isPending && (variables?.connector as { id?: string } | undefined)?.id === w.id;
            return (
              <li key={w.id}>
                {c ? (
                  <button className="pf-option" disabled={isPending || on} onClick={() => connect({ connector: c }, { onSuccess: onClose })}>
                    {c.icon ? <img src={c.icon} alt="" /> : <span className="pf-option-icon">{w.name[0]}</span>}
                    <span>{w.name}</span>
                    <em>{on ? "Added" : busy ? <LoaderCircle size={13} className="spin" /> : "Connect"}</em>
                  </button>
                ) : (
                  <a className="pf-option" href={w.install} target="_blank" rel="noreferrer">
                    <span className="pf-option-icon">{w.name[0]}</span>
                    <span>{w.name}</span>
                    <em>
                      Install <ExternalLink size={11} />
                    </em>
                  </a>
                )}
              </li>
            );
          })}
        </ul>
        {error && <p className="lp-warn">{rejected ? "Connection cancelled." : "Couldn't connect that wallet. Open it and try again."}</p>}
        <p className="pf-safe">Adding a wallet only shares its address so we can show its balance. Your keys stay in your wallet, and we'll never ask you to sign anything here.</p>
      </div>
    </div>,
    document.body,
  );
}
