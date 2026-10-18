import { defineChain } from "viem";
import { ELYSIUM_RPC } from "./lib/config";

export const elysiumTestnet = defineChain({
  id: 99801,
  name: "Elysium Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: [ELYSIUM_RPC] } }, // Privy's embedded wallet sends through this too
  blockExplorers: { default: { name: "Elysium Explorer", url: "https://elysium.kinetiq.xyz/testnet-explorer" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } }, // deployed on testnet (checked 2026-09-30)
  testnet: true,
});
