import { useEffect, useState } from "react";
import type { Address } from "viem";
import { fetchBalances, type Balances } from "./balances";
import { poll } from "./poll";

/** The wallet's balances while an address is known: read on open, right after this browser's own transactions, when
 *  the tab is shown again, and every `everyMs` while visible (catches tokens someone else sent). Hidden tabs don't
 *  read. Keeps the last good value on errors. */
export function useBalances(address: Address | undefined, everyMs = 60_000) {
  const [balances, setBalances] = useState<Balances | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBalances(null);
    if (!address) return;
    let alive = true;
    const load = () =>
      fetchBalances(address)
        .then((b) => alive && (setBalances(b), setError(null)))
        .catch((e: Error) => alive && setError(e.message));
    const stop = poll(load, everyMs, { onChain: true });
    return () => {
      alive = false;
      stop();
    };
  }, [address, everyMs]);

  return { balances, error };
}
