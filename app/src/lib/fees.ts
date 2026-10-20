// Creator fees: the creator's share of a launched token's fees (10% of every 1% fee, on the curve and in the pool: user,
// 2026-10-20) builds up in NeuriioFees in USDC on Elysium (an FTF's share is split equally between its 4 members).
// `claim` sends it to the Neuriio wallet.
import { parseAbi, type Address, type EIP1193Provider, zeroAddress } from "viem";
import { confirmed, walletClientFor } from "./tx";
import { deployment } from "./config";
import { pub, REGISTRY, registryAbi } from "./launch";

export const FEE_VAULT = deployment.feeVault as Address;
/** Every FeeVault we ever pointed fees at, current first. A replaced vault keeps its creators' balances claimable, so
 *  balances and lifetime earnings add up across all of them. */
const FEE_VAULTS: Address[] = [
  FEE_VAULT,
  ...(((deployment as { feeVaults?: string[] }).feeVaults ?? []) as Address[]).filter((v) => v.toLowerCase() !== FEE_VAULT.toLowerCase()),
];

const vaultAbi = parseAbi([
  "function creatorBalance(address) view returns (uint256)",
  "function creatorEarned(address token) view returns (uint256)",
  "function claim(address to) returns (uint256)",
  "function totalFees() view returns (uint256)",
]);

/** USDC (base units) waiting to be claimed, and whether this wallet launched its own token. */
export async function creatorFees(wallet: Address) {
  const [balances, token] = await Promise.all([
    Promise.all(FEE_VAULTS.map((v) => pub.readContract({ address: v, abi: vaultAbi, functionName: "creatorBalance", args: [wallet] }))),
    pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "tokenOfCreator", args: [wallet] }),
  ]);
  return { claimable: balances.reduce((a, b) => a + b, 0n), launched: token !== zeroAddress };
}

/** Lifetime creator fees a token has earned (USDC base units, all its creators together). */
export async function tokenCreatorEarned(token: Address) {
  const all = await Promise.all(FEE_VAULTS.map((v) => pub.readContract({ address: v, abi: vaultAbi, functionName: "creatorEarned", args: [token] })));
  return all.reduce((a, b) => a + b, 0n);
}

/** Every fee the platform has taken, lifetime (USDC base units, every vault: curve and pool, all tokens). */
export async function platformFees() {
  const all = await Promise.all(FEE_VAULTS.map((v) => pub.readContract({ address: v, abi: vaultAbi, functionName: "totalFees" })));
  return all.reduce((a, b) => a + b, 0n);
}

/** Claims to the wallet itself from every vault that holds a balance for the wallet (usually just the current one). */
export async function claimCreatorFees(provider: EIP1193Provider, account: Address) {
  let hash: `0x${string}` | null = null;
  for (const v of FEE_VAULTS) {
    const bal = await pub.readContract({ address: v, abi: vaultAbi, functionName: "creatorBalance", args: [account] });
    if (bal === 0n) continue;
    hash = await walletClientFor(provider, account).writeContract({ address: v, abi: vaultAbi, functionName: "claim", args: [account] });
    await confirmed(hash);
  }
  return hash;
}
