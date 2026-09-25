// Testnet check: a Privy "Neuriio wallet" runs the one-click flow we already built.
//   sign in -> Neuriio wallet created -> test deposit (faucet) -> setup with NO prompts
//   -> one-click 3x BTC -> close + withdraw everything back to Elysium
// Needs the bots (./script/run-bots.sh burner) and ./script/privy-check.sh running.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { usePrivy, useSign7702Authorization, useSignTypedData, useWallets } from "@privy-io/react-auth";
import { createPublicClient, formatUnits, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { TradeHub } from "../../keeper/src/trade/hub.mjs";
import { OneClick } from "../../keeper/src/oneclick/oneclick.mjs";
import { isDelegatedTo, prepareSetup } from "../../keeper/src/oneclick/account.mjs";
import { SponsorClient } from "../../keeper/src/oneclick/wire.mjs";
import { makeTransport } from "../../keeper/src/rpc.mjs";
import { elysiumTestnet } from "./chain.js";

const SPONSOR_URL = "http://localhost:8787";
const FAUCET_URL = "http://localhost:8788";
const MARKET = "BTC"; // testnet HYPE perp book is one-sided
const BACKUP_RPC = "https://elysium-testnet-rpc.hypedexer.com/"; // same chain, third-party node
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (x) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
const DOMAIN_FIELDS = [["name", "string"], ["version", "string"], ["chainId", "uint256"], ["verifyingContract", "address"], ["salt", "bytes32"]];

/**
 * The Privy embedded wallet as the "main" wallet the one-click code expects: an object with
 * `address`, `signTypedData(args)` and `signAuthorization(args)`. Hyperliquid's SDK reads the same
 * shape as a viem local account. Every signature is silent (showWalletUIs: false).
 */
function usePrivyMain(address) {
  const { signTypedData } = useSignTypedData();
  const { signAuthorization } = useSign7702Authorization();
  return useMemo(() => {
    if (!address) return null;
    return {
      address,
      async signTypedData({ domain, types, primaryType, message }) {
        const EIP712Domain = types.EIP712Domain ?? DOMAIN_FIELDS.filter(([k]) => domain[k] !== undefined).map(([name, type]) => ({ name, type }));
        const { signature } = await signTypedData(plain({ domain, types: { ...types, EIP712Domain }, primaryType, message }), {
          address,
          uiOptions: { showWalletUIs: false },
        });
        return signature;
      },
      async signAuthorization({ address: contract, chainId, nonce }) {
        const a = await signAuthorization({ contractAddress: contract, chainId, nonce }, { address });
        return { address: a.address ?? contract, chainId: Number(a.chainId), nonce: Number(a.nonce), r: a.r, s: a.s, yParity: Number(a.yParity) };
      },
    };
  }, [address, signTypedData, signAuthorization]);
}

export function PrivyCheck() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const main = usePrivyMain(embedded?.address);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const ctx = useRef(null);
  const say = (line, ok) => setLog((l) => [...l, { t: new Date().toLocaleTimeString(), line, ok }]);

  const storeKey = embedded ? `neuriio_check_${embedded.address.toLowerCase()}` : null;
  const keys = () => JSON.parse(sessionStorage.getItem(storeKey) ?? "null");

  async function init() {
    if (ctx.current) return ctx.current;
    const cfg = await fetch(`${FAUCET_URL}/config`).then((r) => r.json());
    const pub = createPublicClient({ chain: elysiumTestnet, transport: makeTransport(`${cfg.rpcUrl},${BACKUP_RPC}`, { statsEveryMs: 0 }) });
    const hub = await new TradeHub({ testnet: true }).init();
    const sponsor = new SponsorClient(SPONSOR_URL);
    const oc = await new OneClick({ pub, hub, sponsor, bridge: cfg.bridge, inventory: cfg.inventory }).init();
    return (ctx.current = { cfg, pub, hub, sponsor, oc });
  }

  const step = (name, fn) => async () => {
    setBusy(true);
    say(`▶ ${name}`);
    try {
      await fn(await init());
    } catch (e) {
      console.error(e);
      say(`✖ ${name}: ${e.shortMessage ?? e.message}`, false);
    } finally {
      setBusy(false);
    }
  };

  const balances = async ({ pub, cfg }) => {
    const [hype, tHype, tUsdc] = await Promise.all([
      pub.getBalance({ address: main.address }),
      pub.readContract({ address: cfg.hype, abi: erc20, functionName: "balanceOf", args: [main.address] }),
      pub.readContract({ address: cfg.usdc, abi: erc20, functionName: "balanceOf", args: [main.address] }),
    ]);
    return { hype, tHype, tUsdc };
  };

  const deposit = step("Test deposit (faucet mints 3 tHYPE)", async (c) => {
    const r = await fetch(`${FAUCET_URL}/mint?to=${main.address}`, { method: "POST" }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    const b = await balances(c);
    say(`✔ deposited: ${formatUnits(b.tHype, 18)} tHYPE, gas HYPE ${formatUnits(b.hype, 18)}`, true);
  });

  const setup = step("One-time setup (should show NO pop-ups)", async ({ pub, cfg, hub, sponsor }) => {
    const t0 = Date.now();
    const { deviceKey, request } = await prepareSetup({ main, pub, delegate: cfg.delegate, caps: { maxPerBuy: 500_000_000n, maxPerDay: 1_000_000_000n } });
    say(`  signed 7702 authorization + device session (${request.authorization ? "new delegation" : "already delegated"})`);
    const r = await sponsor.setup(request);
    const delegated = await isDelegatedTo(pub, main.address, cfg.delegate);
    if (!delegated) throw new Error(`sponsor tx ${r.hash} landed but wallet is not delegated`);
    say(`  ✔ wallet delegated to NeuriioAccount (tx ${r.hash})`, true);
    const agentInfo = await hub.signAgentApproval(main, "neuriio-1click");
    sessionStorage.setItem(storeKey, JSON.stringify({ deviceKey, agentKey: agentInfo.key, approval: agentInfo.approval }));
    say(`✔ setup done in ${((Date.now() - t0) / 1000).toFixed(1)}s; HL agent ${agentInfo.address} signed (submitted after 1st deposit)`, true);
  });

  const buy = step(`One click: 3x ${MARKET} long with 1.5 tHYPE`, async (c) => {
    const k = keys();
    if (!k) throw new Error("run setup first");
    const args = { user: main.address, payToken: c.cfg.hype, amountIn: parseUnits("1.5", 18), market: MARKET, leverage: 3, slippageBps: 100 };
    const q = await c.oc.quote(args);
    if (!q.ok) throw new Error(q.error);
    say(`  button: "${MARKET} · est. ${q.est.amount}" | $${q.usdc.toFixed(2)} USDC | HL activation $${q.fees.hyperliquidActivationUsd}`);
    const t0 = Date.now();
    const r = await c.oc.buy({
      ...args,
      quote: q, // the quote the button shows: reused on click while fresh
      device: privateKeyToAccount(k.deviceKey),
      agent: privateKeyToAccount(k.agentKey),
      agentApproval: k.approval,
      onStage: (s, info) => say(`  … ${s}${s === "bridging" ? ` deposit #${info.depositId}` : ""}`),
    });
    say(`✔ filled ${JSON.stringify(r.fill)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`, true);
  });

  const cleanup = step("Cleanup: close + withdraw everything to Elysium", async (c) => {
    const k = keys();
    const agent = privateKeyToAccount(k.agentKey);
    try {
      await c.hub.closePosition(agent, main.address, MARKET);
      say(`  closed ${MARKET}`);
    } catch (e) {
      say(`  (no ${MARKET} position: ${e.message.split("\n")[0]})`);
    }
    await sleep(1500);
    const all = Math.floor((await c.hub.usdcBalances(main.address)).perp * 100) / 100;
    if (all < 0.01) return say("✔ nothing to withdraw", true);
    const before = (await balances(c)).tUsdc;
    // usdSend needs the MAIN key: signed silently by the Privy wallet
    await new ExchangeClient({ transport: new HttpTransport({ isTestnet: true }), wallet: main }).usdSend({ destination: c.cfg.inventory, amount: all.toFixed(2) });
    say(`  sent $${all.toFixed(2)} to the bridge on Hyperliquid, waiting for payout…`);
    for (let i = 0; i < 90; i++) {
      const b = await balances(c);
      if (b.tUsdc > before) {
        return say(`✔ ${formatUnits(b.tUsdc - before, 6)} tUSDC back on Elysium; gas HYPE ever held: ${formatUnits(b.hype, 18)}`, true);
      }
      await sleep(1000);
    }
    throw new Error("payout not seen after 90s (check the relayer log)");
  });

  useEffect(() => {
    if (embedded) say(`Neuriio wallet ${embedded.address} (Privy embedded)`);
  }, [embedded?.address]);

  if (!ready) return <p style={s.page}>Loading Privy…</p>;
  return (
    <div style={s.page}>
      <h1 style={{ fontSize: 20 }}>Neuriio · Privy wallet testnet check</h1>
      {!authenticated ? (
        <button style={s.btn} onClick={login}>Sign in</button>
      ) : (
        <>
          <p>
            Signed in as {user?.twitter?.username ? `@${user.twitter.username}` : user?.wallet?.address}.{" "}
            <button style={s.link} onClick={logout}>Sign out</button>
          </p>
          {!embedded ? (
            <p>Creating your Neuriio wallet…</p>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button style={s.btn} disabled={busy} onClick={deposit}>1 · Deposit</button>
              <button style={s.btn} disabled={busy} onClick={setup}>2 · Setup</button>
              <button style={s.btn} disabled={busy} onClick={buy}>3 · Buy {MARKET}</button>
              <button style={s.btn} disabled={busy} onClick={cleanup}>4 · Cleanup</button>
            </div>
          )}
        </>
      )}
      <pre style={s.log}>
        {log.map((l, i) => (
          <div key={i} style={{ color: l.ok === false ? "#c0392b" : l.ok ? "#1e8449" : undefined }}>
            {l.t}  {l.line}
          </div>
        ))}
      </pre>
    </div>
  );
}

const s = {
  page: { fontFamily: "system-ui, sans-serif", maxWidth: 820, margin: "24px auto", padding: "0 16px" },
  btn: { padding: "10px 16px", fontSize: 15, borderRadius: 8, border: "1px solid #888", cursor: "pointer" },
  link: { background: "none", border: "none", color: "#2563eb", cursor: "pointer", padding: 0 },
  log: { background: "#f4f4f5", padding: 12, borderRadius: 8, minHeight: 160, whiteSpace: "pre-wrap", fontSize: 13 },
};
