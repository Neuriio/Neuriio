// Creator fees: 80% of every fee a launched token generates (curve 0.75%, pool 0.25%) builds up in the FeeVault as
// HYPE on Elysium (an FTF's share is split equally between its 4 members). `claim` sends it to the Neuriio wallet.
import { parseAbi, type Address, type EIP1193Provider, zeroAddress } from "viem";
import { confirmed, walletClientFor } from "./tx";
import { deployment } from "./config";
import { LAUNCHPAD, launchpadAbi, pub } from "./launch";

export const FEE_VAULT = deployment.feeVault as Address;

const vaultAbi = parseAbi([
  "function creatorBalance(address) view returns (uint256)",
  "function creatorEarned(address token) view returns (uint256)",
  "function claim(address to) returns (uint256)",
]);

/** HYPE (wei) waiting to be claimed, and whether this wallet launched its own token. */
export async function creatorFees(wallet: Address) {
  const [claimable, token] = await Promise.all([
    pub.readContract({ address: FEE_VAULT, abi: vaultAbi, functionName: "creatorBalance", args: [wallet] }),
    pub.readContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: "tokenOfCreator", args: [wallet] }),
  ]);
  return { claimable, launched: token !== zeroAddress };
}

/** Lifetime creator fees a token has earned (HYPE wei, all its creators together). */
export function tokenCreatorEarned(token: Address) {
  return pub.readContract({ address: FEE_VAULT, abi: vaultAbi, functionName: "creatorEarned", args: [token] });
}

/** Claims everything to the wallet itself; waits for the transaction. */
export async function claimCreatorFees(provider: EIP1193Provider, account: Address) {
  const hash = await walletClientFor(provider, account).writeContract({ address: FEE_VAULT, abi: vaultAbi, functionName: "claim", args: [account] });
  await confirmed(hash);
  return hash;
}
