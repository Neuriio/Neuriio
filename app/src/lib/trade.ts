// Buying/selling launched tokens from Explore with the Neuriio (Privy) wallet, in USDC (2026-10-17).
// Every trade goes through the NeuriioRouter, on the bonding curve or (after graduation) in the token's pool: one
// door, 1% fee either way, and it records who traded. Quotes are exact on-chain previews (router.quoteBuy /
// quoteSell: price impact + fee included).
// Approvals are one-time: the first buy approves the router for USDC, the first sell of a token approves the router
// for that token (unlimited), both sent silently by the wallet just before the trade.
import { erc20Abi, maxUint256, parseAbi, type Address, type EIP1193Provider } from "viem";
import { confirmed, walletClientFor } from "./tx";
import { deployment, QUOTE } from "./config";
import { LAUNCHPAD, launchpadAbi as padAbi, pub } from "./launch";

export const ROUTER = deployment.router as Address;
const FACTORY = deployment.swapFactory as Address;
const poolAbi = parseAbi([
  "function getPair(address, address) view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
]);
export const SLIPPAGE_BPS = 100n; // 1%
export const FEE_BPS = 100; // 1% on every trade, curve or pool (NeuriioPad.feeBps, the pair's fee)

const routerAbi = parseAbi([
  "function buy(address token, uint256 quoteIn, uint256 minTokensOut, uint256 deadline) returns (uint256)",
  "function sell(address token, uint256 tokensIn, uint256 minQuoteOut, uint256 deadline) returns (uint256)",
  "function quoteBuy(address token, uint256 quoteIn) view returns (uint256 tokensOut, uint256 spent)",
  "function quoteSell(address token, uint256 tokensIn) view returns (uint256)",
]);

export type Side = "buy" | "sell";

/** The token's own Launchpad version for curve reads (legacy rows without one: the current version). */
export const padOf = (launchpad: string | null | undefined) => (launchpad ?? LAUNCHPAD) as Address;

// refund: USDC left unspent when a buy sells out the curve (the router sends it back); spot: USDC per token right
// before the trade, read on-chain with the quote (price impact is measured against it, never a stored/stale price)
export type Quote = { out: bigint; refund: bigint; spot: number | null };

// USDC (6 decimals) per token (18): reserves ratio x 1e12
const perToken = (quoteRaw: bigint, tokenRaw: bigint) => (tokenRaw > 0n ? (Number(quoteRaw) / Number(tokenRaw)) * 10 ** (18 - QUOTE.decimals) : null);

/** Spot price (USDC per token) now: the curve's virtual reserves, or the pool's reserves once graduated. */
async function spotNow(token: Address, graduated: boolean, launchpad?: string | null): Promise<number | null> {
  if (!graduated) {
    const [, , vQuote, vToken] = await pub.readContract({ address: padOf(launchpad), abi: padAbi, functionName: "curves", args: [token] });
    return perToken(vQuote, vToken);
  }
  const pair = await pub.readContract({ address: FACTORY, abi: poolAbi, functionName: "getPair", args: [token, QUOTE.address] });
  const [r0, r1] = await pub.readContract({ address: pair, abi: poolAbi, functionName: "getReserves" });
  const tokenIs0 = token.toLowerCase() < QUOTE.address.toLowerCase();
  const [tok, q] = tokenIs0 ? [r0, r1] : [r1, r0];
  return perToken(q, tok);
}

/** True if this curve buy sells the curve's last tokens, i.e. the same transaction graduates the token. */
export async function buyGraduates(token: Address, q: Quote, launchpad?: string | null): Promise<boolean> {
  if (q.refund > 0n) return true; // more USDC than the curve had left: only happens on the graduating buy
  const [, graduated, , , , realToken] = await pub.readContract({ address: padOf(launchpad), abi: padAbi, functionName: "curves", args: [token] });
  return !graduated && q.out >= realToken;
}

/** Exact amount out for `amountIn` (USDC base units to buy, token wei to sell), wherever the token trades now. */
export async function quote(token: Address, graduated: boolean, side: Side, amountIn: bigint, launchpad?: string | null): Promise<Quote> {
  if (amountIn === 0n) return { out: 0n, refund: 0n, spot: null };
  const spot = spotNow(token, graduated, launchpad).catch(() => null);
  if (side === "buy") {
    const [out, spent] = await pub.readContract({ address: ROUTER, abi: routerAbi, functionName: "quoteBuy", args: [token, amountIn] });
    return { out, refund: amountIn - spent, spot: await spot };
  }
  const out = await pub.readContract({ address: ROUTER, abi: routerAbi, functionName: "quoteSell", args: [token, amountIn] });
  return { out, refund: 0n, spot: await spot };
}

/** What the trade box needs: USDC to buy with, the token to sell, and HYPE for gas. */
export async function balances(wallet: Address, token: Address) {
  const [usdc, tokens, gas] = await Promise.all([
    pub.readContract({ address: QUOTE.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
    pub.getBalance({ address: wallet }),
  ]);
  return { usdc, tokens, gas };
}

export const minOut = (out: bigint) => (out * (10_000n - SLIPPAGE_BPS)) / 10_000n;

/** Sends the trade (with the one-time approval first, if it's still needed) and waits for it. `onStage` drives the
 *  button label. */
export async function trade(
  provider: EIP1193Provider,
  account: Address,
  args: { token: Address; side: Side; amountIn: bigint; minOut: bigint },
  onStage: (s: "approving" | "confirming") => void,
) {
  const wallet = walletClientFor(provider, account);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const { token, side, amountIn } = args;
  const spent = side === "buy" ? QUOTE.address : token;
  const allowance = await pub.readContract({ address: spent, abi: erc20Abi, functionName: "allowance", args: [account, ROUTER] });
  if (allowance < amountIn) {
    onStage("approving");
    const h = await wallet.writeContract({ address: spent, abi: erc20Abi, functionName: "approve", args: [ROUTER, maxUint256] });
    await confirmed(h);
  }
  onStage("confirming");
  const hash =
    side === "buy"
      ? await wallet.writeContract({ address: ROUTER, abi: routerAbi, functionName: "buy", args: [token, amountIn, args.minOut, deadline] })
      : await wallet.writeContract({ address: ROUTER, abi: routerAbi, functionName: "sell", args: [token, amountIn, args.minOut, deadline] });
  await confirmed(hash);
  return hash;
}

/** Readable errors for the common failures. */
export function friendlyTradeError(message: string) {
  if (/AlreadyGraduated/i.test(message)) return "This token just graduated to its pool. Try again.";
  if (/Slippage/i.test(message)) return "Price moved more than 1%. Try again.";
  if (/insufficient funds/i.test(message)) return "Not enough HYPE for gas.";
  if (/exceeds balance|InsufficientBalance/i.test(message)) return "Not enough balance.";
  if (/rejected|denied/i.test(message)) return "Cancelled.";
  if (/Expired/i.test(message)) return "Took too long. Try again.";
  if (/UnknownToken/i.test(message)) return "This token isn't on Neuriio.";
  return message.split("\n")[0].slice(0, 140);
}
