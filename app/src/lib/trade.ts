// Buying/selling launched tokens from Explore with the Neuriio (Privy) wallet.
//   on the bonding curve: Launchpad.buy / sell   (quotes: previewBuy / previewSell; fee 0.75%)
//   graduated:            SwapRouter.buy / sell  (quotes: quoteBuy / quoteSell;     fee 0.25%)
// Quotes are exact on-chain previews (price impact + fee included). Sells approve the exact amount first.
import { createWalletClient, custom, erc20Abi, parseAbi, type Address, type EIP1193Provider } from "viem";
import { elysiumTestnet } from "../chain";
import { deployment } from "./config";
import { LAUNCHPAD, pub } from "./launch";

export const ROUTER = deployment.swapRouter as Address;
export const SLIPPAGE_BPS = 100n; // 1%

const padAbi = parseAbi([
  "function buy(address token, uint256 minTokensOut, uint256 deadline) payable returns (uint256)",
  "function sell(address token, uint256 tokensIn, uint256 minHypeOut, uint256 deadline) returns (uint256)",
  "function previewBuy(address token, uint256 value) view returns (uint256 tokensOut, uint256 hypeIn, uint256 fee, uint256 refund)",
  "function previewSell(address token, uint256 tokensIn) view returns (uint256 hypeOut, uint256 fee)",
]);
const routerAbi = parseAbi([
  "function buy(address token, uint256 minTokensOut, address to, uint256 deadline) payable returns (uint256)",
  "function sell(address token, uint256 tokensIn, uint256 minHypeOut, address to, uint256 deadline) returns (uint256)",
  "function quoteBuy(address token, uint256 hypeIn) view returns (uint256)",
  "function quoteSell(address token, uint256 tokensIn) view returns (uint256)",
]);

export type Side = "buy" | "sell";
export type Quote = { out: bigint; refund: bigint }; // refund: HYPE sent back when a buy sells out the curve

/** Exact amount out for `amountIn` (HYPE wei to buy, token wei to sell). */
export async function quote(token: Address, graduated: boolean, side: Side, amountIn: bigint): Promise<Quote> {
  if (amountIn === 0n) return { out: 0n, refund: 0n };
  if (graduated) {
    const out = await pub.readContract({
      address: ROUTER,
      abi: routerAbi,
      functionName: side === "buy" ? "quoteBuy" : "quoteSell",
      args: [token, amountIn],
    });
    return { out, refund: 0n };
  }
  if (side === "buy") {
    const [tokensOut, , , refund] = await pub.readContract({ address: LAUNCHPAD, abi: padAbi, functionName: "previewBuy", args: [token, amountIn] });
    return { out: tokensOut, refund };
  }
  const [hypeOut] = await pub.readContract({ address: LAUNCHPAD, abi: padAbi, functionName: "previewSell", args: [token, amountIn] });
  return { out: hypeOut, refund: 0n };
}

export async function balances(wallet: Address, token: Address) {
  const [hype, tokens] = await Promise.all([
    pub.getBalance({ address: wallet }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
  ]);
  return { hype, tokens };
}

export const minOut = (out: bigint) => (out * (10_000n - SLIPPAGE_BPS)) / 10_000n;

/** Sends the trade (approving first for sells) and waits for it. `onStage` drives the button label. */
export async function trade(
  provider: EIP1193Provider,
  account: Address,
  args: { token: Address; graduated: boolean; side: Side; amountIn: bigint; minOut: bigint },
  onStage: (s: "approving" | "confirming") => void,
) {
  const wallet = createWalletClient({ account, chain: elysiumTestnet, transport: custom(provider) });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const { token, graduated, side, amountIn } = args;
  if (side === "sell") {
    const spender = graduated ? ROUTER : LAUNCHPAD;
    const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, spender] });
    if (allowance < amountIn) {
      onStage("approving");
      const h = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amountIn] });
      await pub.waitForTransactionReceipt({ hash: h });
    }
  }
  onStage("confirming");
  const hash = graduated
    ? side === "buy"
      ? await wallet.writeContract({ address: ROUTER, abi: routerAbi, functionName: "buy", args: [token, args.minOut, account, deadline], value: amountIn })
      : await wallet.writeContract({ address: ROUTER, abi: routerAbi, functionName: "sell", args: [token, amountIn, args.minOut, account, deadline] })
    : side === "buy"
      ? await wallet.writeContract({ address: LAUNCHPAD, abi: padAbi, functionName: "buy", args: [token, args.minOut, deadline], value: amountIn })
      : await wallet.writeContract({ address: LAUNCHPAD, abi: padAbi, functionName: "sell", args: [token, amountIn, args.minOut, deadline] });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted");
  return hash;
}

/** Readable errors for the common failures. */
export function friendlyTradeError(message: string) {
  if (/AlreadyGraduated/i.test(message)) return "This token just graduated to its pool. Try again.";
  if (/Slippage/i.test(message)) return "Price moved more than 1%. Try again.";
  if (/insufficient funds|exceeds the balance/i.test(message)) return "Not enough HYPE (including gas).";
  if (/rejected|denied/i.test(message)) return "Cancelled.";
  if (/Expired/i.test(message)) return "Took too long. Try again.";
  return message.split("\n")[0].slice(0, 140);
}
