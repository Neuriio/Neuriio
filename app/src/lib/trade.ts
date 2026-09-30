// Buying/selling launched tokens from Explore with the Neuriio (Privy) wallet.
//   on the bonding curve: Launchpad.buy / sell   (quotes: previewBuy / previewSell; fee 0.75%)
//   graduated:            SwapRouter.buy / sell  (quotes: quoteBuy / quoteSell;     fee 0.25%)
// Quotes are exact on-chain previews (price impact + fee included). Sells approve the exact amount first.
// A curve token trades on the Launchpad VERSION that launched it (`launchpad`, from token_stats / the registry); every
// graduated pool lives in the shared factory, so the one router serves them all.
import { erc20Abi, parseAbi, type Address, type EIP1193Provider } from "viem";
import { confirmed, walletClientFor } from "./tx";
import { deployment } from "./config";
import { LAUNCHPAD, launchpadAbi as padAbi, pub, REGISTRY, registryAbi } from "./launch";

export const ROUTER = deployment.swapRouter as Address;
const FACTORY = deployment.swapFactory as Address;
const WHYPE = deployment.whype as Address;
const poolAbi = parseAbi([
  "function getPair(address, address) view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
]);
export const SLIPPAGE_BPS = 100n; // 1%

const routerAbi = parseAbi([
  "function buy(address token, uint256 minTokensOut, address to, uint256 deadline) payable returns (uint256)",
  "function sell(address token, uint256 tokensIn, uint256 minHypeOut, address to, uint256 deadline) returns (uint256)",
  "function quoteBuy(address token, uint256 hypeIn) view returns (uint256)",
  "function quoteSell(address token, uint256 tokensIn) view returns (uint256)",
]);

export type Side = "buy" | "sell";

/** The token's own Launchpad version for QUOTES (legacy rows without one: the current version). */
export const padOf = (launchpad: string | null | undefined) => (launchpad ?? LAUNCHPAD) as Address;

/** The token's Launchpad as the chain says (LaunchRegistry). Anything that sends HYPE or approves tokens uses this,
 *  never the database's value, so tampered data can't redirect funds. */
async function verifiedPad(token: Address): Promise<Address> {
  const pad = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "launchpadOf", args: [token] });
  if (/^0x0{40}$/i.test(pad)) throw new Error("Unknown token");
  return pad;
}
// refund: HYPE sent back when a buy sells out the curve; spot: HYPE per token right before the trade, read on-chain
// with the quote (price impact is measured against it, never against a stored/stale price)
export type Quote = { out: bigint; refund: bigint; spot: number | null };

/** Spot price (HYPE per token) now: the curve's virtual reserves, or the pool's reserves once graduated. */
async function spotNow(token: Address, graduated: boolean, launchpad?: string | null): Promise<number | null> {
  if (!graduated) {
    const [, , vHype, vToken] = await pub.readContract({ address: padOf(launchpad), abi: padAbi, functionName: "curves", args: [token] });
    return vToken > 0n ? Number(vHype) / Number(vToken) : null;
  }
  const pair = await pub.readContract({ address: FACTORY, abi: poolAbi, functionName: "getPair", args: [token, WHYPE] });
  const [r0, r1] = await pub.readContract({ address: pair, abi: poolAbi, functionName: "getReserves" });
  const tokenIs0 = token.toLowerCase() < WHYPE.toLowerCase();
  const [tok, hype] = tokenIs0 ? [r0, r1] : [r1, r0];
  return tok > 0n ? Number(hype) / Number(tok) : null;
}

/** True if this curve buy sells the curve's last tokens, i.e. the same transaction graduates the token. */
export async function buyGraduates(token: Address, q: Quote, launchpad?: string | null): Promise<boolean> {
  if (q.refund > 0n) return true; // more HYPE than the curve had left: only happens on the graduating buy
  const [, graduated, , , , realToken] = await pub.readContract({ address: padOf(launchpad), abi: padAbi, functionName: "curves", args: [token] });
  return !graduated && q.out >= realToken;
}

/** Exact amount out for `amountIn` (HYPE wei to buy, token wei to sell). */
export async function quote(token: Address, graduated: boolean, side: Side, amountIn: bigint, launchpad?: string | null): Promise<Quote> {
  if (amountIn === 0n) return { out: 0n, refund: 0n, spot: null };
  const spot = spotNow(token, graduated, launchpad).catch(() => null);
  if (graduated) {
    const out = await pub.readContract({
      address: ROUTER,
      abi: routerAbi,
      functionName: side === "buy" ? "quoteBuy" : "quoteSell",
      args: [token, amountIn],
    });
    return { out, refund: 0n, spot: await spot };
  }
  if (side === "buy") {
    const [tokensOut, , , refund] = await pub.readContract({ address: padOf(launchpad), abi: padAbi, functionName: "previewBuy", args: [token, amountIn] });
    return { out: tokensOut, refund, spot: await spot };
  }
  const [hypeOut] = await pub.readContract({ address: padOf(launchpad), abi: padAbi, functionName: "previewSell", args: [token, amountIn] });
  return { out: hypeOut, refund: 0n, spot: await spot };
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
  args: { token: Address; launchpad?: string | null; graduated: boolean; side: Side; amountIn: bigint; minOut: bigint },
  onStage: (s: "approving" | "confirming") => void,
) {
  const wallet = walletClientFor(provider, account);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const { token, graduated, side, amountIn } = args;
  const pad = graduated ? LAUNCHPAD : await verifiedPad(token); // (graduated trades go to the router, not a Launchpad)
  if (side === "sell") {
    const spender = graduated ? ROUTER : pad;
    const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, spender] });
    if (allowance < amountIn) {
      onStage("approving");
      const h = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amountIn] });
      await confirmed(h);
    }
  }
  onStage("confirming");
  const hash = graduated
    ? side === "buy"
      ? await wallet.writeContract({ address: ROUTER, abi: routerAbi, functionName: "buy", args: [token, args.minOut, account, deadline], value: amountIn })
      : await wallet.writeContract({ address: ROUTER, abi: routerAbi, functionName: "sell", args: [token, amountIn, args.minOut, account, deadline] })
    : side === "buy"
      ? await wallet.writeContract({ address: pad, abi: padAbi, functionName: "buy", args: [token, args.minOut, deadline], value: amountIn })
      : await wallet.writeContract({ address: pad, abi: padAbi, functionName: "sell", args: [token, amountIn, args.minOut, deadline] });
  await confirmed(hash);
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
