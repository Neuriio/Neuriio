// Sending transactions from the Neuriio (Privy embedded) wallet on Elysium: one place for switching the wallet to
// Elysium, building the wallet client and waiting for a successful receipt (launches, trades, approvals, claims).
import type { ConnectedWallet } from "@privy-io/react-auth";
import { createWalletClient, custom, type Address, type EIP1193Provider, type Hash } from "viem";
import { elysiumTestnet } from "../chain";
import { keyedFor, pub, viaKey } from "./launch";
import { chainChanged } from "./poll";

/** The Privy wallet's provider, switched to Elysium. */
export async function elysiumProvider(wallet: ConnectedWallet): Promise<EIP1193Provider> {
  await wallet.switchChain(elysiumTestnet.id);
  return (await wallet.getEthereumProvider()) as EIP1193Provider;
}

export const walletClientFor = (provider: EIP1193Provider, account: Address) =>
  createWalletClient({ account, chain: elysiumTestnet, transport: custom(provider) });

/** The nonce for the transaction after `hash` (just confirmed). Right after a transaction, Elysium's RPC can briefly
 *  still report the old count, and a follow-up sent with it is rejected: approve-then-act flows pass this instead. */
export async function nonceAfter(hash: Hash) {
  return (await pub.getTransaction({ hash })).nonce + 1;
}

/** Waits for a transaction and throws if it reverted. */
export async function confirmed(hash: Hash) {
  // our key while waiting and for 5 s after: the receipt and the balance reads right after come from the same up-to-date node
  const receipt = await viaKey(() => pub.waitForTransactionReceipt({ hash }));
  keyedFor(5_000);
  chainChanged(); // balances, positions and stakes re-read now (lib/poll.ts), reverted or not: gas was spent
  if (receipt.status !== "success") throw new Error("Transaction reverted");
  return receipt;
}
