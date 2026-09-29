import deployment from "../../../deployments/elysium-testnet.json";

export const ELYSIUM_RPCS = [
  "https://testnet-rpc.elysium.kinetiq.xyz",
  "https://elysium-testnet-rpc.hypedexer.com/", // same chain, third-party node (fallback)
];

export const HL_TESTNET = true;

/** Supabase project (launch passes, registration, points). Functions use the Privy token. */
export const SUPABASE_URL = "https://yviymgfgaepmtijgyyyo.supabase.co";
/** Publishable key: public by design (browser reads of public tables/views: token_stats, token_candles, leaderboard). */
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_FegCC3kuFI9k3EsEP2TGYA_zucL2uoq";
/** Legacy anon key (a JWT, public by design): Realtime needs it to join the private live-trade channels. */
export const SUPABASE_ANON_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2aXltZ2ZnYWVwbXRpamd5eXlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1NTUyNjAsImV4cCI6MjEwNjEzMTI2MH0.STvEmPVXmHgQVX1kGUcskYKQOWgDvA-GdO4QjSCQD44";

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
