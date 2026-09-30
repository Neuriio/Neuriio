// Send (Feed): tip a poster any token the Neuriio wallet holds on Elysium: gas HYPE, the listed ERC-20s
// (config ELYSIUM_TOKENS) and every launched token it holds (read on-chain).
// A plain transfer from the wallet to the poster's wallet; the sender pays a little HYPE gas.
import { erc20Abi, parseEther, type Address, type EIP1193Provider, type Hash } from "viem";
import { ELYSIUM_TOKENS } from "./config";
import { pub } from "./launch";
import { displayName, launchedHoldings } from "./explore";
import { confirmed, walletClientFor } from "./tx";

export type SendToken = {
  key: string; // "native" or the token address
  symbol: string;
  label: string; // what the list shows (e.g. "@handle" for a launched token)
  address: Address | null; // null = native HYPE
  decimals: number;
  balance: bigint;
  pfp: string | null;
  launched: boolean;
};

/** Native HYPE kept back for gas when sending "Max" HYPE. */
export const GAS_RESERVE = parseEther("0.0005");

/** Everything the wallet can send, with non-zero balances only; HYPE first, then listed tokens, then launched ones. */
export async function sendableTokens(wallet: Address): Promise<SendToken[]> {
  const [native, listed, held] = await Promise.all([
    pub.getBalance({ address: wallet }),
    Promise.all(ELYSIUM_TOKENS.map((t) => pub.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }))),
    launchedHoldings(wallet).catch(() => []),
  ]);
  const out: SendToken[] = [
    { key: "native", symbol: "HYPE", label: "HYPE", address: null, decimals: 18, balance: native, pfp: null, launched: false },
    ...ELYSIUM_TOKENS.map((t, i) => ({
      key: t.address.toLowerCase(),
      symbol: t.symbol,
      label: t.symbol === "HYPE" ? "tHYPE" : t.symbol, // the mock ERC-20 HYPE, not gas HYPE
      address: t.address,
      decimals: t.decimals,
      balance: listed[i],
      pfp: null,
      launched: false,
    })),
    ...held.map(({ token: t, balance }) => ({
      key: t.address.toLowerCase(),
      symbol: t.symbol,
      label: displayName(t),
      address: t.address as Address,
      decimals: 18,
      balance,
      pfp: t.x_pfp_url,
      launched: true,
    })),
  ];
  return out.filter((t) => t.balance > 0n);
}

/** Sends `amount` (base units) of the token to `to`; waits for the transaction. */
export async function sendToken(provider: EIP1193Provider, from: Address, to: Address, token: SendToken, amount: bigint): Promise<Hash> {
  const client = walletClientFor(provider, from);
  const hash = token.address
    ? await client.writeContract({ address: token.address, abi: erc20Abi, functionName: "transfer", args: [to, amount] })
    : await client.sendTransaction({ to, value: amount });
  await confirmed(hash);
  return hash;
}
