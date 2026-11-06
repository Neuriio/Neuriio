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

/** The wallets on offer; `id` is the name each announces itself under. */
export const WALLETS = [
  { id: "io.rabby", name: "Rabby", install: "https://rabby.io" },
  { id: "app.phantom", name: "Phantom", install: "https://phantom.com" },
  { id: "com.coinbase.wallet", name: "Coinbase", install: "https://www.coinbase.com/wallet" },
  { id: "io.metamask", name: "MetaMask", install: "https://metamask.io" },
] as const;
