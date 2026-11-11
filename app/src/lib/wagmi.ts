// Connecting people's own wallets (Rabby, Phantom, Coinbase, MetaMask), through wagmi: the portfolio shows their balances, and
// (user, 2026-11-11) Swap and Bridge can trade from them with no Neuriio login (lib/tradeWallet.ts). Keys stay in the wallet and
// every transaction is shown and approved in the wallet itself; the referral Verify (ReferralBox) is a free plain-message signature.
// All four announce themselves through EIP-6963, so wagmi finds whichever are installed without any wallet SDK. Remembered in this
// browser: address only.
import { createConfig, http } from "wagmi";
import { elysiumTestnet, hyperEvm } from "../chain";
import { ELYSIUM_RPC, RPC_VIA_PROXY } from "./config";
import { proxyFetch } from "./rpcSession";

/** Elysium as a wallet adds it: Kinetiq's public RPC (live since the 2026-11-09 public launch), since a wallet can't use our /rpc
 *  proxy (it needs this site's session cookie). Our own reads still go through the proxy (the transport below). */
export const ELYSIUM_WALLET_RPC = "https://rpc.elysium.kinetiq.xyz";
const elysiumForWallets = { ...elysiumTestnet, rpcUrls: { default: { http: [ELYSIUM_WALLET_RPC] } } } as const;

export const wagmiConfig = createConfig({
  chains: [elysiumForWallets, hyperEvm],
  connectors: [],
  multiInjectedProviderDiscovery: true,
  transports: {
    [elysiumTestnet.id]: http(ELYSIUM_RPC, RPC_VIA_PROXY ? { fetchFn: proxyFetch } : {}),
    [hyperEvm.id]: http(),
  },
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
