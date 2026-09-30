// Everything the account panel shows: the Neuriio wallet's balances on Elysium and on HyperCore.
// Each venue always lists HYPE, KNTQ and USDC (true values, even $0.00), then any other token held. On Elysium that
// includes launched tokens (shown as "$TICKER", valued at their curve/pool price x HYPE's HyperCore mainnet price).
import { createPublicClient, erc20Abi, fallback, formatUnits, http, type Address } from "viem";
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { elysiumTestnet } from "../chain";
import { ELYSIUM_RPCS, ELYSIUM_TOKENS, HL_TESTNET, SHOWN_TOKENS } from "./config";
import { launchedHoldings } from "./explore";

export type TokenBalance = { symbol: string; amount: number; usd: number };
export type VenueBalance = { total: number; tokens: TokenBalance[] };
export type Balances = { total: number; elysium: VenueBalance; hypercore: VenueBalance; at: number };

const pub = createPublicClient({
  chain: elysiumTestnet,
  transport: fallback(ELYSIUM_RPCS.map((u) => http(u, { timeout: 5_000 }))),
});
const hl = new InfoClient({ transport: new HttpTransport({ isTestnet: HL_TESTNET }) });
// Elysium tokens are valued at HyperCore MAINNET prices (the pool prices off mainnet; testnet
// markets are separate, thin test markets)
const hlMainnet = new InfoClient({ transport: new HttpTransport() });

const sum = (xs: TokenBalance[]) => xs.reduce((s, t) => s + t.usd, 0);
const DUST_USD = 0.01; // extra (non-listed) tokens below this are hidden

/** HYPE, KNTQ, USDC first (always), then any other token that is held, by value. */
function arrange(byToken: Map<string, TokenBalance>): VenueBalance {
  const fixed = SHOWN_TOKENS.map((s) => byToken.get(s) ?? { symbol: s, amount: 0, usd: 0 });
  const extra = [...byToken.values()]
    .filter((t) => !SHOWN_TOKENS.includes(t.symbol) && t.amount > 0 && (t.usd >= DUST_USD || t.usd === 0))
    .sort((a, b) => b.usd - a.usd);
  const tokens = [...fixed, ...extra];
  return { total: sum(tokens), tokens };
}

/** token name -> USD price, from each TOKEN/USDC spot market on that HyperCore network.
 *  Cached 60 s per network: spotMetaAndAssetCtxs is a weight-20 call and balances refresh every 10 s. */
const priceCache = new Map<InfoClient, { at: number; prices: Promise<Map<string, number>> }>();
const PRICE_TTL_MS = 60_000;
function spotPrices(client: InfoClient) {
  const hit = priceCache.get(client);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.prices;
  const prices = loadSpotPrices(client);
  priceCache.set(client, { at: Date.now(), prices });
  prices.catch(() => priceCache.delete(client)); // don't cache failures
  return prices;
}

async function loadSpotPrices(client: InfoClient) {
  const [meta, ctxs] = await client.spotMetaAndAssetCtxs();
  const tokenName = new Map(meta.tokens.map((t) => [t.index, t.name]));
  const mark = new Map(ctxs.map((c) => [c.coin, Number(c.markPx)]));
  const price = new Map<string, number>([["USDC", 1]]);
  for (const pair of meta.universe) {
    const [base, quote] = pair.tokens;
    const px = mark.get(pair.name);
    if (quote === 0 && px) price.set(tokenName.get(base) ?? "", px);
  }
  return price;
}

async function elysium(user: Address, price: Map<string, number>): Promise<VenueBalance> {
  const [held, native, ...raw] = await Promise.all([
    launchedHoldings(user).catch(() => []), // a Supabase hiccup must not hide the rest
    pub.getBalance({ address: user }),
    ...ELYSIUM_TOKENS.map((t) => pub.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [user] })),
  ]);
  const amounts = new Map<string, number>([["HYPE", Number(formatUnits(native, 18))]]); // gas HYPE
  ELYSIUM_TOKENS.forEach((t, i) => amounts.set(t.symbol, (amounts.get(t.symbol) ?? 0) + Number(formatUnits(raw[i], t.decimals))));
  const byToken = new Map([...amounts].map(([symbol, amount]) => [symbol, { symbol, amount, usd: amount * (price.get(symbol) ?? 0) }]));
  // launched tokens: "$" keeps a ticker like HYPE apart from the real one
  const hypeUsd = price.get("HYPE") ?? 0;
  for (const { token, balance } of held) {
    const amount = Number(formatUnits(balance, 18));
    const symbol = `$${token.symbol}`;
    byToken.set(symbol, { symbol, amount, usd: amount * token.price_hype * hypeUsd });
  }
  return arrange(byToken);
}

async function hypercore(user: Address): Promise<VenueBalance> {
  const [perp, spot, price] = await Promise.all([hl.clearinghouseState({ user }), hl.spotClearinghouseState({ user }), spotPrices(hl)]);
  const byToken = new Map<string, TokenBalance>();
  for (const b of spot.balances) {
    const amount = Number(b.total);
    byToken.set(b.coin, { symbol: b.coin, amount, usd: amount * (price.get(b.coin) ?? 0) });
  }
  // USDC = spot USDC + the perps account (margin + unrealized PnL): one line
  const perpsUsd = Number(perp.marginSummary.accountValue);
  const usdc = byToken.get("USDC") ?? { symbol: "USDC", amount: 0, usd: 0 };
  byToken.set("USDC", { symbol: "USDC", amount: usdc.amount + perpsUsd, usd: usdc.usd + perpsUsd });
  return arrange(byToken);
}

export async function fetchBalances(user: Address): Promise<Balances> {
  const mainnetPrices = await spotPrices(hlMainnet);
  const [e, h] = await Promise.all([elysium(user, mainnetPrices), hypercore(user)]);
  return { total: e.total + h.total, elysium: e, hypercore: h, at: Date.now() };
}
