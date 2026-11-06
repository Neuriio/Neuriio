// Connecting people's own wallets (Rabby, Phantom, Coinbase, MetaMask) for the portfolio, through wagmi. Connecting only shares an
// address and keys stay in the wallet. The one thing ever asked of these wallets is the referral Verify signature (ReferralBox): a plain
// message, free, that moves nothing. Never a transaction. All four announce
// themselves through EIP-6963, so wagmi finds whichever are installed without any wallet SDK. Remembered in this browser: address only.
import { createConfig, http } from "wagmi";
import { elysiumTestnet } from "../chain";
import { ELYSIUM_RPC, RPC_VIA_PROXY } from "./config";
import { proxyFetch } from "./rpcSession";

export const wagmiConfig = createConfig({
  chains: [elysiumTestnet],
  connectors: [],
  multiInjectedProviderDiscovery: true,
  transports: { [elysiumTestnet.id]: http(ELYSIUM_RPC, RPC_VIA_PROXY ? { fetchFn: proxyFetch } : {}) },
});

/** The wallets on offer; `id` is the name each announces itself under. `logo`: each wallet's current app icon (public/wallets,
 *  from RainbowKit's maintained set, 2026-11-05), shown whether or not the wallet is installed. */
export const WALLETS = [
  { id: "io.rabby", name: "Rabby", install: "https://rabby.io", logo: "/wallets/rabby.svg" },
  { id: "app.phantom", name: "Phantom", install: "https://phantom.com", logo: "/wallets/phantom.svg" },
  { id: "com.coinbase.wallet", name: "Coinbase", install: "https://www.coinbase.com/wallet", logo: "/wallets/coinbase.svg" },
  { id: "io.metamask", name: "MetaMask", install: "https://metamask.io", logo: "/wallets/metamask.svg" },
] as const;

/** A connected wallet's logo: ours for the wallets we list, else the icon the wallet announced (if any). */
export const walletLogo = (connector: { id: string; icon?: string }) => WALLETS.find((w) => w.id === connector.id)?.logo ?? connector.icon;
