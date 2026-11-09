import { defineChain } from "viem";
import { ELYSIUM_RPC, EXPLORER } from "./lib/config";

/** Elysium mainnet (chain 99901). Named `elysiumTestnet` for history: every import still uses that name. */
export const elysiumTestnet = defineChain({
  id: 99901,
  name: "Elysium",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: [ELYSIUM_RPC] } }, // Privy's embedded wallet sends through this too
  blockExplorers: { default: { name: "Elysium Explorer", url: EXPLORER } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } }, // Ascend's docs list it on mainnet
});
export const elysium = elysiumTestnet;

/** HyperEVM (chain 999), for the Swap page's bridge (user, 2026-11-09): the Neuriio wallet signs Relay deposits here. */
export const hyperEvm = defineChain({
  id: 999,
  name: "HyperEVM",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.hyperliquid.xyz/evm"] } },
  blockExplorers: { default: { name: "HyperEVM Scan", url: "https://hyperevmscan.io" } },
});
