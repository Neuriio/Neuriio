// Sending transactions from the Neuriio (Privy embedded) wallet on Elysium: one place for switching the wallet to
// Elysium, building the wallet client and waiting for a successful receipt (launches, trades, approvals, claims).
import type { ConnectedWallet } from "@privy-io/react-auth";
import { createWalletClient, custom, type Address, type EIP1193Provider, type Hash } from "viem";
import { elysiumTestnet } from "../chain";
import { pub } from "./launch";

/** The Privy wallet's provider, switched to Elysium. */
export async function elysiumProvider(wallet: ConnectedWallet): Promise<EIP1193Provider> {
  await wallet.switchChain(elysiumTestnet.id);
  return (await wallet.getEthereumProvider()) as EIP1193Provider;
}

export const walletClientFor = (provider: EIP1193Provider, account: Address) =>
  createWalletClient({ account, chain: elysiumTestnet, transport: custom(provider) });

/** Waits for a transaction and throws if it reverted. */
export async function confirmed(hash: Hash) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted");
  return receipt;
}
