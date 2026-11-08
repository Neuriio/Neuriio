// Elysium MAINNET, the Ascend world (2026-11-04): tokens launch through our NeuriioLauncher into Ascend's Uniswap v4 pools and
// trade there in USDC. Our contract addresses are null in deployments/elysium-mainnet.json until they're deployed; until then
// launching, trading and staking can't work (demo mode `?demo` still does). The testnet world (elysium-testnet.json) is retired.
import type { Address } from "viem";
import deployment from "../../../deployments/elysium-mainnet.json";

const addr = (a: string | null | undefined) => (a ?? "0x0000000000000000000000000000000000000000") as Address;

/** What launched tokens trade against and are priced in: USDC (bridged Circle USDC), counted as $1. (Supabase's `price_hype` /
 *  `volume_hype` columns and the app's `hypeUsd` props carry this quote, not HYPE: old names.) */
export const QUOTE = { symbol: "USDC", address: deployment.usdc as Address, decimals: 6, usd: 1 } as const;

/** Our contracts (null until deployed: reads then go to the zero address and fail quietly). */
export const LAUNCHER = addr(deployment.launcher);
export const STAKING = addr(deployment.staking);
export const DEPLOYED = !!deployment.launcher;
/** Ascend's mainnet contracts (its docs, Mainnet contracts). */
export const ASCEND = Object.fromEntries(
  Object.entries(deployment.ascend).filter(([, v]) => typeof v === "string"),
) as Record<"launchpad" | "escrowFactory" | "seatFactory" | "poolManager" | "universalRouter" | "v4Quoter" | "stateView" | "permit2" | "multicall3", Address>;
export const EXPLORER = deployment.explorer;

/** Elysium mainnet RPC for the app's reads and the wallet's sends (chain.ts).
 *  Production: our own /rpc proxy (app/api/rpc.ts, user 2026-11-04, modelled on Ascend's): the provider's key never reaches the
 *  browser; reads need a short-lived session cookie (lib/rpcSession.ts runs an invisible Turnstile check for it).
 *  Local dev (or VITE_RPC_PROXY=off): straight to the provider with VITE_ELYSIUM_RPC from app/.env.local (the bare Conduit key
 *  or a full URL, e.g. Alchemy's); never in git. Elysium has no public RPC, so there's no keyless fallback. */
const MAINNET_RPC_BASE = "https://rpc-elysium-mainnet.t.conduit.xyz";
/** A keyless public RPC to try first, if Elysium publishes one (VITE_ELYSIUM_PUBLIC_RPC); null: our proxy / key only. */
const publicSetting = (import.meta.env.VITE_ELYSIUM_PUBLIC_RPC ?? "").trim();
export const PUBLIC_RPC: string | null = publicSetting && publicSetting !== "off" ? publicSetting : null;
/** Whether chain requests go through our /rpc proxy: production unless VITE_RPC_PROXY=off; in dev only with VITE_RPC_PROXY=on
 *  (then app/api/_dev.ts stands in for Vercel). */
const proxySetting = (import.meta.env.VITE_RPC_PROXY ?? "").trim();
export const RPC_VIA_PROXY = proxySetting === "on" || (!import.meta.env.DEV && proxySetting !== "off");
const rpcSetting = (import.meta.env.VITE_ELYSIUM_RPC ?? "").trim();
export const ELYSIUM_RPC: string = RPC_VIA_PROXY
  ? `${location.origin}/rpc`
  : !rpcSetting
    ? MAINNET_RPC_BASE
    : /^https?:\/\//.test(rpcSetting)
      ? rpcSetting
      : `${MAINNET_RPC_BASE}/${rpcSetting.replace(/^\/+/, "")}`; // a bare key

export const HL_TESTNET = false;

/** NeuriioSwap (src/trade/NeuriioSwap.sol, user 2026-11-07): trades tokens launched elsewhere in their own pools, with our 0.5%
 *  on top, in HYPE. From deployments/elysium-mainnet.json "swap": 0x630B…4946, live on the site since 2026-11-08 (user: "its all
 *  audited and approved"). Local dev can override it with VITE_NEURIIO_SWAP in app/.env.local. A token whose pool it hasn't
 *  approved stays "Token Not Tradable". */
const swapSetting = import.meta.env.DEV ? (import.meta.env.VITE_NEURIIO_SWAP ?? "").trim() : "";
export const NEURIIO_SWAP: Address | null = (swapSetting || (deployment as { swap?: string | null }).swap || null) as Address | null;


/** Supabase project (launch passes, registration, points). Functions use the Privy token. */
export const SUPABASE_URL = "https://yviymgfgaepmtijgyyyo.supabase.co";
/** Publishable key: public by design (browser reads of public tables/views: token_stats, token_candles, leaderboard). */
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_FegCC3kuFI9k3EsEP2TGYA_zucL2uoq";

/**
 * Builder code on every Hyperliquid order placed through Neuriio, at the minimum fee (1 = 0.1 bp = 0.001%). It isn't
 * revenue: the indexer counts only fills carrying a builder fee, so it's how trades earn points. Pass to
 * `new TradeHub({ builder: HL_BUILDER })`; users approve it silently at setup (hub.signBuilderApproval).
 * The builder account needs >= 100 USDC perps account value (testnet: the burner/inventory account).
 */
export const HL_BUILDER = {
  address: ((deployment as { hlBuilder?: string }).hlBuilder ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
  fees: { perp: 1, spot: 1, outcome: 1 },
};

/** Always listed in the account panel, in this order, for both Elysium and HyperCore. */
export const SHOWN_TOKENS = ["HYPE", "KNTQ", "USDC"];

/**
 * ERC-20s the Neuriio wallet can hold on Elysium mainnet. Native (gas) HYPE is added on top.
 * USDC is bridged Circle USDC (what every token trades against); KNTQ is Kinetiq's token (Ascend's pair-asset list).
 */
export const ELYSIUM_TOKENS = [
  { symbol: "KNTQ", address: "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0" as `0x${string}`, decimals: 18 },
  { symbol: "USDC", address: QUOTE.address, decimals: QUOTE.decimals },
] as const;

/**
 * Our builder address = the fee router's wallet (user, 2026-11-04): Ascend pays our 0.5% here, per token, from each token's
 * escrow. Explore's "Platform fees" counter is everything that has arrived, as the fee router records it (Supabase
 * `platform_fees()`), and links to this wallet on the explorer.
 */
export const FEE_WALLET: Address | null = deployment.builder as Address;

export { deployment };
