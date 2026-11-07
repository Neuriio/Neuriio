// The Neuriio Safe (Safe v1.3.0, 2-of-3) on Elysium, for the /safe page: Safe's own website doesn't list Elysium, so
// owners approve a Safe transaction on-chain (`approveHash`, from their own Rabby / MetaMask) and anyone executes it
// once enough have, with "pre-approved" signatures (r = owner, s = 0, v = 1). Same flow as script/SafeTx.s.sol.
import {
  concat,
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  fallback,
  http,
  keccak256,
  pad,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { elysiumTestnet } from "../chain";
import { ELYSIUM_RPC, PUBLIC_RPC, RPC_VIA_PROXY } from "./config";
import { proxyFetch } from "./rpcSession";

/** Reads: Elysium's public RPC first (it rate-limits bursts per visitor), the app's own RPC as the backup; contract
 *  reads made together go out as one multicall. */
export const safePub = createPublicClient({
  chain: elysiumTestnet,
  batch: { multicall: true },
  transport: PUBLIC_RPC ? fallback([http(PUBLIC_RPC), http(ELYSIUM_RPC, RPC_VIA_PROXY ? { fetchFn: proxyFetch } : {})]) : http(ELYSIUM_RPC, RPC_VIA_PROXY ? { fetchFn: proxyFetch } : {}),
});

/** The Neuriio Safe: 2 of 3, the treasury and the contracts' owner (user, 2026-11-05: same 3 owners as the testnet rehearsal, one
 *  Safe). Same owners + salt 0 on Safe's canonical factory give the same address on mainnet as on testnet; it exists on mainnet
 *  only once script/CreateSafe.s.sol has run there. */
export const NEURIIO_SAFE: Address = "0x68Ed49C77dF7fB4928510d5Ac65C6074674D264E";
/** Safe's canonical v1.3.0 GnosisSafeL2: every Neuriio Safe must run it (storage slot 0 of the proxy). */
export const SAFE_L2: Address = "0x3E5c63644E683549055b9Be8653de26E0B4CD36E";

export const SAFE_ABI = parseAbi([
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function approvedHashes(address owner, bytes32 hash) view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)",
  "function approveHash(bytes32 hashToApprove)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
]);

export type SafeState = { owners: Address[]; threshold: number; nonce: bigint; isSafe: boolean };

export async function readSafe(safe: Address): Promise<SafeState> {
  const [owners, threshold, nonce, slot0] = await Promise.all([
    safePub.readContract({ address: safe, abi: SAFE_ABI, functionName: "getOwners" }),
    safePub.readContract({ address: safe, abi: SAFE_ABI, functionName: "getThreshold" }),
    safePub.readContract({ address: safe, abi: SAFE_ABI, functionName: "nonce" }),
    safePub.getStorageAt({ address: safe, slot: "0x0" }),
  ]);
  const isSafe = !!slot0 && `0x${slot0.slice(-40)}`.toLowerCase() === SAFE_L2.toLowerCase();
  return { owners: [...owners], threshold: Number(threshold), nonce, isSafe };
}

/** The Safe transaction's hash for one CALL of `to` with `data` (no value, no gas refund) at `nonce`. */
export function safeTxHash(safe: Address, to: Address, data: Hex, nonce: bigint) {
  return safePub.readContract({
    address: safe,
    abi: SAFE_ABI,
    functionName: "getTransactionHash",
    args: [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce],
  });
}

/** Which owners approved `hash` on-chain. */
export async function approvalsOf(safe: Address, owners: Address[], hash: Hex) {
  const marks = await Promise.all(
    owners.map((o) => safePub.readContract({ address: safe, abi: SAFE_ABI, functionName: "approvedHashes", args: [o, hash] })),
  );
  return owners.filter((_, i) => marks[i] !== 0n);
}

/** "Pre-approved" signatures for `owners`, in the ascending order the Safe checks. An owner who sends the execution
 *  itself counts too (the Safe accepts v = 1 from msg.sender), so it needs no approveHash of its own. */
export function preApprovedSignatures(owners: Address[]): Hex {
  const sorted = [...owners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return concat(sorted.map((o) => concat([pad(o, { size: 32 }), pad("0x0", { size: 32 }), "0x01"])));
}

// ------------------------------------------------------------------ what a call does, in words

const CALLS = parseAbi([
  "function pause()",
  "function unpause()",
  "function setGuardian(address guardian)",
  "function setFee(uint16 feeBps)",
  "function setLaunchSigner(address signer)",
  "function setVirtualQuote(uint256 virtualQuote)",
  "function setFeeVault(address feeVault)",
  "function setWallets(address treasury, address buyback)",
  "function setLaunchpad(address launchpad, bool approved)",
  "function setAdapter(address adapter)",
  "function setReservedTickers(string[] tickers, bool reserved)",
  "function setVault(address vault, bool allowed)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
  "function transfer(address to, uint256 amount)",
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt)",
  "function cancel(bytes32 id)",
]);

const WORDS: Record<string, string> = {
  pause: "Pause launches and buys (emergency stop; sells stay open)",
  unpause: "Unpause launches and buys",
  setGuardian: "Change who can pause at once",
  setFee: "Change the trading fee",
  setLaunchSigner: "Change the launch-pass signing key",
  setVirtualQuote: "Change the starting curve size for new launches",
  setFeeVault: "Send fees to a different fee vault",
  setWallets: "Change the treasury and buyback wallets",
  setLaunchpad: "Approve or revoke a launchpad version",
  setAdapter: "Plug an adapter into the NeuriioLauncher (where launches go: Ascend)",
  setReservedTickers: "Reserve or free tickers nobody can launch",
  setVault: "Approve or remove a fee vault for minting",
  transferOwnership: "Start handing ownership to a new owner",
  acceptOwnership: "Accept ownership",
  transfer: "Send tokens",
  schedule: "Schedule through the timelock",
  execute: "Run a timelocked action (once its delay has passed)",
  cancel: "Cancel a scheduled timelock action",
};

export type Described = { words: string; fn: string; args: string[]; target?: Address; inner?: Described; delay?: bigint };

/** The call decoded (what is actually approved); null if this page doesn't know the function. */
export function describe(data: Hex): Described | null {
  try {
    const { functionName, args = [] } = decodeFunctionData({ abi: CALLS, data });
    const d: Described = {
      words: WORDS[functionName] ?? functionName,
      fn: functionName,
      args: (args as readonly unknown[]).map((a) => (typeof a === "bigint" ? a.toString() : String(a))),
    };
    if (functionName === "schedule" || functionName === "execute") {
      const [target, , inner] = args as unknown as readonly [Address, bigint, Hex];
      d.target = target;
      d.inner = describe(inner) ?? { words: "An unknown call (check the raw data)", fn: inner.slice(0, 10), args: [] };
      if (functionName === "schedule") d.delay = (args as readonly unknown[])[5] as bigint;
    }
    return d;
  } catch {
    return null;
  }
}

const TIMELOCK_ABI = parseAbi(["function getTimestamp(bytes32 id) view returns (uint256)"]);

/** For a timelock `execute(...)` call: 0n = not scheduled, 1n = already ran, else the unix time it can run from
 *  (OpenZeppelin's TimelockController). null if `data` isn't an execute call. */
export async function timelockReadyAt(timelock: Address, data: Hex): Promise<bigint | null> {
  let args: readonly unknown[];
  try {
    const d = decodeFunctionData({ abi: CALLS, data });
    if (d.functionName !== "execute") return null;
    args = d.args;
  } catch {
    return null;
  }
  const [target, value, payload, predecessor, salt] = args as readonly [Address, bigint, Hex, Hex, Hex];
  const id = keccak256(
    encodeAbiParameters(parseAbiParameters("address, uint256, bytes, bytes32, bytes32"), [target, value, payload, predecessor, salt]),
  ); // the timelock's hashOperation
  return safePub.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: "getTimestamp", args: [id] });
}

/** "10 minutes", "2 days", ... */
export function delayWords(s: bigint) {
  const n = Number(s);
  if (n % 86_400 === 0) return `${n / 86_400} day${n === 86_400 ? "" : "s"}`;
  if (n % 3_600 === 0) return `${n / 3_600} hour${n === 3_600 ? "" : "s"}`;
  if (n % 60 === 0) return `${n / 60} minute${n === 60 ? "" : "s"}`;
  return `${n} seconds`;
}
