// The wallet Swap and Bridge trade from (user, 2026-11-11: "remove the need to login to swap and bridge ... read the wallet
// connected assets"). A wallet added with "Add wallet" (Rabby, MetaMask, Coinbase... via wagmi) needs no Neuriio login; the Neuriio
// wallet is there too when logged in. With both, the card's wallet chip switches between them; the choice is remembered in this
// browser (address only). Every transaction from an added wallet is shown and approved in that wallet.
import { useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import type { Address, EIP1193Provider } from "viem";
import { useConnections, type Connector } from "wagmi";
import { switchChain } from "wagmi/actions";
import { wagmiConfig, walletLogo } from "./wagmi";

export type TradeWallet = {
  kind: "neuriio" | "added";
  address: Address;
  /** "Neuriio", or the wallet's own name ("Rabby") */
  name: string;
  logo: string | null;
  connector?: Connector;
  /** The wallet's provider, switched to `chainId` first (an added wallet is asked to add the chain if it doesn't know it). */
  provider: (chainId: number) => Promise<EIP1193Provider>;
};

const KEY = "neuriio:trade-wallet";
const listeners = new Set<(a: string | null) => void>();
let chosen: string | null = (() => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
})();
function choose(address: string) {
  chosen = address.toLowerCase();
  try {
    localStorage.setItem(KEY, chosen);
  } catch {
    /* private mode: this tab only */
  }
  listeners.forEach((f) => f(chosen));
}

/** Every wallet that can trade here, and the one in use: the chosen one if still there, else the first added wallet (what the
 *  person just connected), else the Neuriio wallet. Shared by Swap and Bridge, so switching in one card switches both. */
export function useTradeWallet() {
  const { authenticated } = usePrivy();
  const { wallets } = useWallets();
  const connections = useConnections();
  const [pick, setPick] = useState(chosen);
  useEffect(() => {
    listeners.add(setPick);
    return () => void listeners.delete(setPick);
  }, []);
  const privy = authenticated ? wallets.find((w) => w.walletClientType === "privy") : undefined;
  const key = `${privy?.address ?? ""}|${connections.map((c) => `${c.connector.uid}:${c.accounts.join(",")}`).join(";")}`;
  const list = useMemo(() => {
    const out: TradeWallet[] = [];
    const seen = new Set<string>();
    for (const c of connections) {
      for (const a of c.accounts) {
        if (seen.has(a.toLowerCase()) || a.toLowerCase() === privy?.address.toLowerCase()) continue;
        seen.add(a.toLowerCase());
        out.push({
          kind: "added",
          address: a,
          name: c.connector.name,
          logo: walletLogo(c.connector) ?? null,
          connector: c.connector,
          provider: async (chainId) => {
            await switchChain(wagmiConfig, { chainId: chainId as (typeof wagmiConfig.chains)[number]["id"], connector: c.connector });
            return (await c.connector.getProvider()) as EIP1193Provider;
          },
        });
      }
    }
    if (privy) {
      out.push({
        kind: "neuriio",
        address: privy.address as Address,
        name: "Neuriio",
        logo: "/brand/logo.png",
        provider: async (chainId) => {
          await privy.switchChain(chainId);
          return (await privy.getEthereumProvider()) as EIP1193Provider;
        },
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const active = list.find((w) => w.address.toLowerCase() === pick) ?? list[0] ?? null;
  return { list, active, choose };
}
