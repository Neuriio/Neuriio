import deployment from "../../../deployments/elysium-testnet.json";

export const ELYSIUM_RPCS = [
  "https://testnet-rpc.elysium.kinetiq.xyz",
  "https://elysium-testnet-rpc.hypedexer.com/", // same chain, third-party node (fallback)
];

export const HL_TESTNET = true;

/** Supabase project (launch passes, registration, points). The anon key isn't needed: functions use the Privy token. */
export const SUPABASE_URL = "https://yviymgfgaepmtijgyyyo.supabase.co";

/**
 * Builder code on every Hyperliquid order placed through Neuriio, at the minimum fee (1 = 0.1 bp = 0.001%). It isn't
 * revenue: the indexer counts only fills carrying a builder fee, so it's how trades earn points. Pass to
 * `new TradeHub({ builder: HL_BUILDER })`; users approve it silently at setup (hub.signBuilderApproval).
 * The builder account needs >= 100 USDC perps account value (testnet: the burner/inventory account).
 */
export const HL_BUILDER = {
  address: deployment.hlBuilder as `0x${string}`,
  fees: { perp: 1, spot: 1, outcome: 1 },
};

/** Always listed in the account panel, in this order, for both Elysium and HyperCore. */
export const SHOWN_TOKENS = ["HYPE", "KNTQ", "USDC"];

/**
 * ERC-20s the Neuriio wallet can hold on Elysium testnet. Native (gas) HYPE is added on top.
 * HYPE/USDC here are our mock test tokens (the pool trades them); KNTQ is the real testnet KNTQ,
 * bridged from HyperEVM through Elysium's canonical bridge (L2GatewayRouter.calculateL2TokenAddress).
 */
export const ELYSIUM_TOKENS = [
  { symbol: "HYPE", address: deployment.tHYPE as `0x${string}`, decimals: 18 },
  { symbol: "KNTQ", address: "0x9856148d9CAcf40F12BCAA9357ca016Ba5B0ED19" as `0x${string}`, decimals: 18 },
  { symbol: "USDC", address: deployment.tUSDC as `0x${string}`, decimals: 6 },
] as const;

export { deployment };
