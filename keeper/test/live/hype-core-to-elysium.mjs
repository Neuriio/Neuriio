// Moves HYPE from an account's HyperCore spot balance to the same address on Elysium testnet, in two hops:
//   1. HyperCore -> HyperEVM: sendAsset HYPE to HYPE's system address 0x2222…2222 (credited to the same address on
//      HyperEVM, usually within seconds)
//   2. HyperEVM -> Elysium: Elysium's rollup Inbox.depositEth (native HYPE; arrives on Elysium in ~30 s - 1 min)
// Keeps KEEP_EVM HYPE on HyperEVM for gas. Env: KEY (main key; from the keystore, never printed),
// AMOUNT (HYPE to move from HyperCore; default: all spot HYPE), KEEP_EVM (default 0.01).
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HYPE_SYSTEM = "0x2222222222222222222222222222222222222222";
const HYPE_TOKEN = "HYPE:0x7317beb7cceed72ef0b346074cc8e7ab"; // HL testnet spotMeta (index 1105, 8 wei decimals)
const INBOX = "0x11178Df40CBf87a4343f4B3F8B09B366ceFA8Ec0"; // Elysium testnet rollup Inbox on HyperEVM testnet

const hyperEvm = defineChain({
  id: 998,
  name: "HyperEVM Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.hyperliquid-testnet.xyz/evm"] } },
});
const elysium = defineChain({
  id: 99801,
  name: "Elysium Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.elysium.kinetiq.xyz"] } },
});

const account = privateKeyToAccount(process.env.KEY);
const me = account.address;
const keep = parseEther(process.env.KEEP_EVM ?? "0.01");
const transport = new HttpTransport({ isTestnet: true });
const info = new InfoClient({ transport });
const exchange = new ExchangeClient({ transport, wallet: account });
const evm = createPublicClient({ chain: hyperEvm, transport: http() });
const evmWallet = createWalletClient({ account, chain: hyperEvm, transport: http() });
const ely = createPublicClient({ chain: elysium, transport: http() });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function waitFor(what, read, before, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const now = await read().catch(() => before);
    if (now > before) return now;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- 1. HyperCore -> HyperEVM
const spot = await info.spotClearinghouseState({ user: me });
const coreHype = Number(spot.balances.find((b) => b.coin === "HYPE")?.total ?? 0);
const amount = process.env.AMOUNT ? Number(process.env.AMOUNT) : coreHype;
const amountStr = (Math.floor(amount * 1e8) / 1e8).toFixed(8); // HyperCore HYPE has 8 decimals
log(`account ${me}`);
log(`HyperCore spot HYPE: ${coreHype}; moving ${amountStr}`);
if (!(Number(amountStr) > 0) || Number(amountStr) > coreHype) throw new Error("nothing to move (or AMOUNT > balance)");

const evmBefore = await evm.getBalance({ address: me });
log(`HyperEVM before: ${formatEther(evmBefore)} HYPE`);
// sendAsset (spot -> spot), not spotSend: HyperCore refuses spotSend from "unified account" mode
// ("Action disabled when unified account is active"); sendAsset is the transfer that mode allows
await exchange.sendAsset({ destination: HYPE_SYSTEM, sourceDex: "spot", destinationDex: "spot", token: HYPE_TOKEN, amount: amountStr });
log("sendAsset to 0x2222…2222 accepted; waiting for HyperEVM credit");
const evmAfter = await waitFor("HyperEVM credit", () => evm.getBalance({ address: me }), evmBefore, 180_000);
log(`HyperEVM now: ${formatEther(evmAfter)} HYPE`);

// ---- 2. HyperEVM -> Elysium
const value = evmAfter - keep;
if (value <= 0n) throw new Error("not enough on HyperEVM after keeping gas");
const elyBefore = await ely.getBalance({ address: me });
log(`Elysium before: ${formatEther(elyBefore)} HYPE; depositing ${formatEther(value)} via Inbox.depositEth`);
const hash = await evmWallet.writeContract({
  address: INBOX,
  abi: parseAbi(["function depositEth() payable returns (uint256)"]),
  functionName: "depositEth",
  value,
});
const receipt = await evm.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`depositEth reverted: ${hash}`);
log(`depositEth confirmed on HyperEVM: ${hash}; waiting for Elysium`);
const elyAfter = await waitFor("Elysium credit", () => ely.getBalance({ address: me }), elyBefore, 600_000);
log(`Elysium now: ${formatEther(elyAfter)} HYPE (+${formatEther(elyAfter - elyBefore)})`);
log("DONE");
