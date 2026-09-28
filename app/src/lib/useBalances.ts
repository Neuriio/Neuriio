import { useEffect, useState } from "react";
import type { Address } from "viem";
import { fetchBalances, type Balances } from "./balances";

/** Polls the wallet's balances while an address is known. Keeps the last good value on errors. */
export function useBalances(address: Address | undefined, everyMs = 10_000) {
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
    load();
    const id = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [address, everyMs]);

  return { balances, error };
}
