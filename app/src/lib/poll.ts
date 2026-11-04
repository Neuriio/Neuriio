// One way to keep a panel fresh without wasting calls (the Conduit RPC key and Supabase quotas are shared by every
// visitor): load now, then on a timer only while the tab is visible, again when the tab is shown after a while, and
// (opt-in) right after this browser's own transactions. Hidden tabs make no calls at all.

const CHAIN_EVENT = "neuriio:chain";
/** A second read after a transaction: the RPC or the indexer can lag the receipt by a moment. */
const FOLLOW_UP_MS = 3_000;

/** Tell every open panel that this wallet's on-chain state just changed (lib/tx.ts `confirmed` calls this). */
export function chainChanged() {
  window.dispatchEvent(new Event(CHAIN_EVENT));
}

type PollOptions = {
  /** Also reload right after this browser's own transactions (balances, positions, stakes). */
  onChain?: boolean;
  /** Load straight away (default true). */
  now?: boolean;
};

/** Runs `load` now, every `everyMs` while the tab is visible (null: no timer), and when the tab is shown again after
 *  at least `everyMs` hidden. Returns the cleanup for a useEffect. */
export function poll(load: () => unknown, everyMs: number | null, { onChain = false, now = true }: PollOptions = {}): () => void {
  let last = 0;
  const run = () => {
    last = Date.now();
    load();
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let followUp: ReturnType<typeof setTimeout> | undefined;
  const start = () => {
    if (everyMs && !timer) timer = setInterval(run, everyMs);
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const visible = () => document.visibilityState === "visible";
  const onVisibility = () => {
    if (!visible()) return stop();
    if (!everyMs || Date.now() - last >= everyMs) run();
    start();
  };
  const onTx = () => {
    run();
    clearTimeout(followUp);
    followUp = setTimeout(run, FOLLOW_UP_MS);
  };

  if (now) run();
  if (visible()) start();
  document.addEventListener("visibilitychange", onVisibility);
  if (onChain) window.addEventListener(CHAIN_EVENT, onTx);
  return () => {
    stop();
    clearTimeout(followUp);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener(CHAIN_EVENT, onTx);
  };
}
