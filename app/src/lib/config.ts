import deployment from "../../../deployments/elysium-testnet.json";

export const ELYSIUM_RPCS = [
  "https://testnet-rpc.elysium.kinetiq.xyz",
  "https://elysium-testnet-rpc.hypedexer.com/", // same chain, third-party node (fallback)
];

export const HL_TESTNET = true;

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
