// The Swap page's Bridge (user, 2026-11-09): HYPE between Elysium and HyperEVM through Relay (relay.link). Relay fronts the HYPE on
// the other chain in seconds for a fee, so leaving Elysium skips the canonical ~5.5-day withdrawal. We ask Relay for a quote,
// the Neuriio (Privy) wallet sends the transaction(s) Relay returns, then we follow Relay's status until it has paid out.
import { createPublicClient, http, type Address, type EIP1193Provider, type Hash } from "viem";
import { elysiumTestnet, hyperEvm } from "../chain";
import { pub } from "./launch";
import { walletClientFor } from "./tx";

const RELAY = "https://api.relay.link";
const NATIVE = "0x0000000000000000000000000000000000000000";
export const ELYSIUM_ID = elysiumTestnet.id; // 99901
export const HYPEREVM_ID = hyperEvm.id; // 999
export const hyperPub = createPublicClient({ chain: hyperEvm, transport: http() });
const clientFor = (chainId: number) => (chainId === HYPEREVM_ID ? hyperPub : pub);

type RelayTx = { to: Address; data?: `0x${string}`; value?: string; chainId: number; gas?: string };
type RelayStep = { id: string; kind: string; action?: string; requestId?: string; items?: { data: RelayTx }[] };
export type BridgeQuote = {
  steps: RelayStep[];
  amountIn: number;
  amountOut: number;
  costPct: number | null; // what the whole trip costs, as % of what you send
  costUsd: number;
  seconds: number | null;
};

/** What `amountWei` HYPE sent from `from` gets on `to`, paid to `recipient`. */
export async function bridgeQuote(a: { user: Address; recipient: Address; from: number; to: number; amountWei: bigint }): Promise<BridgeQuote> {
  const res = await fetch(`${RELAY}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user: a.user,
      recipient: a.recipient,
      originChainId: a.from,
      destinationChainId: a.to,
      originCurrency: NATIVE,
      destinationCurrency: NATIVE,
      amount: a.amountWei.toString(),
      tradeType: "EXACT_INPUT",
    }),
  });
  const q = await res.json().catch(() => ({}));
  if (!res.ok || !q.steps) throw new Error(q.message ?? "No route right now. Try a different amount.");
  const d = q.details ?? {};
  const fees = q.fees ?? {};
  const impact = Number(d.totalImpact?.percent);
  return {
    steps: q.steps,
    amountIn: Number(d.currencyIn?.amountFormatted ?? 0),
    amountOut: Number(d.currencyOut?.amountFormatted ?? 0),
    costPct: Number.isFinite(impact) ? Math.abs(impact) : null,
    costUsd: Number(fees.relayer?.amountUsd ?? 0) + Number(fees.gas?.amountUsd ?? 0),
    seconds: d.timeEstimate ?? null,
  };
}

/** Sends the quote's transaction(s) from the Neuriio wallet (switching chains as needed), then waits for Relay to pay out.
 *  `onStatus` gets short progress lines. Resolves to Relay's request id once it reports success; throws on failure. */
/** Sends Relay's steps from `wallet` (the Neuriio wallet or an added one: lib/tradeWallet.ts), switching it to each step's chain. */
export async function bridgeSend(
  wallet: { address: Address; provider: (chainId: number) => Promise<EIP1193Provider> },
  quote: BridgeQuote,
  onStatus: (s: string) => void,
): Promise<string> {
  const account = wallet.address;
  let requestId: string | null = null;
  for (const step of quote.steps) {
    requestId = step.requestId ?? requestId;
    if (step.kind !== "transaction") throw new Error(`Relay asked for a "${step.kind}" step we don't handle`);
    for (const item of step.items ?? []) {
      const tx = item.data;
      const provider = await wallet.provider(tx.chainId);
      const chain = tx.chainId === HYPEREVM_ID ? hyperEvm : elysiumTestnet;
      onStatus("Sending…");
      const hash: Hash = await walletClientFor(provider, account).sendTransaction({
        account,
        chain,
        to: tx.to,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : 0n,
        ...(tx.gas ? { gas: BigInt(tx.gas) } : {}),
      });
      onStatus("Confirming…");
      const receipt = await clientFor(tx.chainId).waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error("Your transaction failed");
    }
  }
  if (!requestId) throw new Error("Sent, but Relay gave no request to follow");
  onStatus("Relay is paying out…");
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    const s = (await fetch(`${RELAY}/intents/status/v2?requestId=${requestId}`).then((r) => r.json()).catch(() => ({}))) as { status?: string };
    if (s.status === "success") return requestId;
    if (s.status === "failure" || s.status === "refund") throw new Error(`Relay reports "${s.status}" (request ${requestId})`);
  }
  throw new Error(`Still waiting on Relay. Track it at relay.link/transaction/${requestId}`);
}
