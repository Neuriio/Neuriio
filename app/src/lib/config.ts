// The USDC world (2026-10-17): tokens are priced and traded in test USDC. Push this app together with
// ./script/supabase-deploy.sh switch (go-live); the live site is still the HYPE world (elysium-testnet-hype.json) until
// then. Data requests name this world's registry (lib/explore.ts), so it lists the right tokens before the switch too.
import type { Address } from "viem";
import deployment from "../../../deployments/elysium-testnet.json";

/** What launched tokens trade against and are priced in: test USDC, counted as $1. (Supabase's `price_hype` /
 *  `volume_hype` columns and the app's `hypeUsd` props now carry this quote, not HYPE.) */
export const QUOTE = { symbol: "USDC", address: deployment.usdc as Address, decimals: 6, usd: 1 } as const;

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
 * USDC is our test USDC (what every token trades against); KNTQ is the real testnet KNTQ,
 * bridged from HyperEVM through Elysium's canonical bridge (L2GatewayRouter.calculateL2TokenAddress).
 */
export const ELYSIUM_TOKENS = [
  { symbol: "KNTQ", address: "0x9856148d9CAcf40F12BCAA9357ca016Ba5B0ED19" as `0x${string}`, decimals: 18 },
  { symbol: "USDC", address: QUOTE.address, decimals: QUOTE.decimals },
] as const;

export { deployment };
