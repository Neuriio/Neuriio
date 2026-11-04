// /safe (unlisted): the Neuriio Safe's owners approve and execute its transactions with Rabby / MetaMask, since Safe's
// own website doesn't list Elysium. An approval link names ONE call from the Safe:
//   /safe?to=<contract>&data=<calldata>&nonce=<the Safe's nonce it was made for>&note=<optional text>
// The page decodes the call (that is what gets approved; the note is just the link sender's words), shows which owners
// approved it, lets an owner approve it from their own wallet (`approveHash`), and lets anyone execute it once enough
// owners have. An owner who executes counts as an approval itself, so the last approver can "Approve & execute" at once.
import { useCallback, useEffect, useState } from "react";
import { createWalletClient, custom, getAddress, isAddress, isHex, type Address, type EIP1193Provider, type Hex } from "viem";
import { elysiumTestnet } from "../chain";
import {
  approvalsOf,
  delayWords,
  describe,
  NEURIIO_SAFE,
  preApprovedSignatures,
  readSafe,
  SAFE_ABI,
  safePub,
  safeTxHash,
  timelockReadyAt,
  type Described,
  type SafeState,
} from "../lib/safe";
import { poll } from "../lib/poll";
import { ELYSIUM_RPC, PUBLIC_RPC } from "../lib/config";

const EXPLORER = elysiumTestnet.blockExplorers.default.url;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** "about 7 minutes", "about 2 days", ... */
function aboutWords(s: number) {
  const [n, unit] = s < 5_400 ? [Math.max(1, Math.round(s / 60)), "minute"] : s < 172_800 ? [Math.round(s / 3_600), "hour"] : [Math.round(s / 86_400), "day"];
  return `about ${n} ${unit}${n === 1 ? "" : "s"}`;
}
const injected = () => (window as unknown as { ethereum?: EIP1193Provider }).ethereum;

type Link = { to: Address; data: Hex; nonce: bigint | null; note: string | null } | null;

function readLink(): { safe: Address; link: Link; bad: string | null } {
  const q = new URLSearchParams(location.search);
  const rawSafe = q.get("safe");
  const safe = rawSafe && isAddress(rawSafe) ? getAddress(rawSafe) : NEURIIO_SAFE;
  const to = q.get("to");
  const data = q.get("data");
  if (!to && !data) return { safe, link: null, bad: null };
  if (!to || !isAddress(to) || !data || !isHex(data)) return { safe, link: null, bad: "This approval link is broken." };
  const n = q.get("nonce");
  return { safe, link: { to: getAddress(to), data, nonce: n && /^\d+$/.test(n) ? BigInt(n) : null, note: q.get("note") }, bad: null };
}

/** Switches the wallet to Elysium testnet, adding the network first if the wallet doesn't know it. */
async function switchToElysium(eth: EIP1193Provider) {
  const chainId = `0x${elysiumTestnet.id.toString(16)}` as const;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    const code = (e as { code?: number; data?: { originalError?: { code?: number } } }).code;
    const inner = (e as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    if (code !== 4902 && inner !== 4902) throw e;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: "Elysium Testnet",
          nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
          rpcUrls: [PUBLIC_RPC ?? ELYSIUM_RPC],
          blockExplorerUrls: [EXPLORER],
        },
      ],
    });
  }
}

export function SafePage() {
  const [{ safe, link, bad }] = useState(readLink);
  const [state, setState] = useState<SafeState | null>(null);
  const [hash, setHash] = useState<Hex | null>(null);
  const [approved, setApproved] = useState<Address[]>([]);
  const [account, setAccount] = useState<Address | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; tx?: Hex } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [readyAt, setReadyAt] = useState<bigint | null>(null); // a timelock execute: when it can run
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const action: Described | null = link ? describe(link.data) : null;
  const done = !!(link && state && link.nonce !== null && state.nonce > link.nonce); // the Safe moved past this link

  const load = useCallback(async () => {
    try {
      const s = await readSafe(safe);
      setState(s);
      setNow(Math.floor(Date.now() / 1000));
      if (!link || !s.isSafe) return;
      const nonce = link.nonce ?? s.nonce;
      if (nonce < s.nonce) return; // done: nothing to approve
      const h = await safeTxHash(safe, link.to, link.data, nonce); // a later nonce too: owners can approve ahead
      setHash(h);
      setApproved(await approvalsOf(safe, s.owners, h));
      setReadyAt(await timelockReadyAt(link.to, link.data).catch(() => null));
      setLoadErr(null);
    } catch (e) {
      setLoadErr((e as Error).message.split("\n")[0]);
    }
  }, [safe, link]);

  useEffect(() => {
    return poll(load, 10_000);
  }, [load]);

  // keep the connected account in sync with the wallet
  useEffect(() => {
    const eth = injected();
    if (!eth) return;
    eth.request({ method: "eth_accounts" }).then((a) => setAccount(((a as string[])[0] && getAddress((a as string[])[0])) || null), () => {});
    const onAccounts = (a: string[]) => setAccount(a[0] ? getAddress(a[0]) : null);
    eth.on?.("accountsChanged", onAccounts);
    return () => eth.removeListener?.("accountsChanged", onAccounts);
  }, []);

  async function connect() {
    const eth = injected();
    if (!eth) return setMsg({ ok: false, text: "No wallet found: open this page in a browser with Rabby or MetaMask." });
    try {
      const a = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      setAccount(a[0] ? getAddress(a[0]) : null);
      setMsg(null);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message.split("\n")[0] });
    }
  }

  async function send(label: string, write: (w: ReturnType<typeof createWalletClient>, from: Address) => Promise<Hex>) {
    const eth = injected();
    if (!eth || !account) return;
    setBusy(label);
    setMsg(null);
    try {
      await switchToElysium(eth);
      const w = createWalletClient({ chain: elysiumTestnet, transport: custom(eth) });
      const tx = await write(w, account);
      const r = await safePub.waitForTransactionReceipt({ hash: tx, pollingInterval: 1_000 });
      setMsg(r.status === "success" ? { ok: true, text: `${label}: done.`, tx } : { ok: false, text: `${label} reverted.`, tx });
      await load();
    } catch (e) {
      const m = (e as { shortMessage?: string; message: string }).shortMessage ?? (e as Error).message;
      setMsg({ ok: false, text: /rejected|denied/i.test(m) ? "Cancelled in the wallet." : m.split("\n")[0] });
    } finally {
      setBusy(null);
    }
  }

  const isOwner = !!(account && state?.owners.some((o) => o.toLowerCase() === account.toLowerCase()));
  const iApproved = !!(account && approved.some((o) => o.toLowerCase() === account.toLowerCase()));
  const count = approved.length + (isOwner && !iApproved ? 1 : 0); // what an execution by this account would carry
  const enough = !!state && approved.length >= state.threshold;
  // why it can't be executed yet: the Safe runs its transactions in order, and a timelocked action runs only once its
  // delay has passed. Owners can approve meanwhile; with enough approvals, Execute is still a step of its own.
  const ahead = link && state && link.nonce !== null && link.nonce > state.nonce ? Number(link.nonce - state.nonce) : 0;
  const then = enough
    ? " Approved: one step left, Execute, which shows up here once it can run (any wallet can click it)."
    : " Owners can approve it now.";
  const wait = ahead
    ? `In line: the Safe runs its transactions in order, so ${ahead === 1 ? "the one before this" : `the ${ahead} before this`} must be executed first.${then}`
    : readyAt === 0n
      ? `Not scheduled in the timelock yet: the schedule step must be executed first.${then}`
      : readyAt === 1n
        ? "The timelock already ran this action: executing it again would fail."
        : readyAt !== null && readyAt > BigInt(now)
          ? `The timelock lets this run from ${new Date(Number(readyAt) * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} (in ${aboutWords(Number(readyAt) - now)}).${then}`
          : null;
  const lastOne = !wait && !!state && !enough && isOwner && !iApproved && count >= state.threshold;

  const approve = () =>
    send("Approve", (w, from) =>
      w.writeContract({ account: from, chain: elysiumTestnet, address: safe, abi: SAFE_ABI, functionName: "approveHash", args: [hash!] }),
    );

  const execute = () =>
    send("Execute", (w, from) => {
      const signers = [...new Set([...approved, ...(isOwner ? [from] : [])])];
      return w.writeContract({
        account: from,
        chain: elysiumTestnet,
        address: safe,
        abi: SAFE_ABI,
        functionName: "execTransaction",
        args: [link!.to, 0n, link!.data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", preApprovedSignatures(signers)],
      });
    });


  return (
    <div className="safe-page">
      <div className="safe-card">
        <header className="safe-head">
          <img src="/brand/mark.png" alt="" className="safe-mark" />
          <h1>Neuriio Safe</h1>
          <span className="safe-net">Elysium Testnet</span>
        </header>

        <dl className="safe-facts">
          <div>
            <dt>Safe</dt>
            <dd>
              <a href={`${EXPLORER}/address/${safe}`} target="_blank" rel="noreferrer">
                {short(safe)}
              </a>
            </dd>
          </div>
          <div>
            <dt>Approvals needed</dt>
            <dd>{state ? `${state.threshold} of ${state.owners.length}` : "…"}</dd>
          </div>
          <div>
            <dt>Transactions so far</dt>
            <dd>{state ? state.nonce.toString() : "…"}</dd>
          </div>
        </dl>

        {state && !state.isSafe && <p className="safe-msg is-bad">This address isn't a Safe running Safe's official code.</p>}
        {bad && <p className="safe-msg is-bad">{bad}</p>}
        {loadErr && !state && <p className="safe-msg is-bad">Couldn't read the Safe: {loadErr}</p>}

        {link ? (
          <section className="safe-action">
            <h2>Action to approve</h2>
            {action ? (
              <>
                <p className="safe-words">{action.words}</p>
                {action.inner && (
                  <p className="safe-inner">
                    {action.fn === "schedule" ? "Will run after " + delayWords(action.delay ?? 0n) + ": " : "The action: "}
                    <strong>{action.inner.words}</strong> on{" "}
                    <a href={`${EXPLORER}/address/${action.target}`} target="_blank" rel="noreferrer">
                      {short(action.target!)}
                    </a>
                  </p>
                )}
                <p className="safe-call">
                  <code>
                    {action.fn}({action.args.map((a) => (a.length > 24 ? short(a) : a)).join(", ")})
                  </code>{" "}
                  on{" "}
                  <a href={`${EXPLORER}/address/${link.to}`} target="_blank" rel="noreferrer">
                    {short(link.to)}
                  </a>
                </p>
              </>
            ) : (
              <p className="safe-msg is-bad">This page can't read this call. Don't approve it unless you know exactly what it does.</p>
            )}
            {link.note && <p className="safe-note">Note from whoever sent this link (not checked): {link.note}</p>}
            <details className="safe-raw">
              <summary>Raw data</summary>
              <code>{link.data}</code>
              {hash && <code>Safe transaction hash {hash}</code>}
            </details>
          </section>
        ) : (
          !bad && <p className="safe-empty">Open an approval link to see an action to approve.</p>
        )}

        {link && done && <p className="safe-msg is-ok">This action was already executed (or replaced): the Safe has moved on.</p>}
        {link && !done && state && wait && <p className="safe-msg is-wait">{wait}</p>}

        {link && !done && state && (
          <ul className="safe-owners">
            {state.owners.map((o) => {
              const ok = approved.some((a) => a.toLowerCase() === o.toLowerCase());
              const me = account?.toLowerCase() === o.toLowerCase();
              return (
                <li key={o} className={ok ? "is-ok" : undefined}>
                  <span className="safe-tick">{ok ? "✓" : "–"}</span>
                  <a href={`${EXPLORER}/address/${o}`} target="_blank" rel="noreferrer">
                    {short(o)}
                  </a>
                  {me && <span className="safe-you">you</span>}
                  <span className="safe-state">{ok ? "approved" : "waiting"}</span>
                </li>
              );
            })}
          </ul>
        )}

        {link && !done && hash && (
          <div className="safe-buttons">
            {!account ? (
              <button className="safe-btn" onClick={connect}>
                Connect wallet
              </button>
            ) : (
              <>
                <span className="safe-account">Connected {short(account)}{isOwner ? "" : " (not an owner)"}</span>
                {lastOne ? (
                  <button className="safe-btn" disabled={!!busy || !action} onClick={execute}>
                    {busy ?? "Approve & execute"}
                  </button>
                ) : (
                  <>
                    {isOwner && !iApproved && (
                      <button className="safe-btn" disabled={!!busy || !action} onClick={approve}>
                        {busy === "Approve" ? "Approving…" : "Approve"}
                      </button>
                    )}
                    {enough && !wait && (
                      <button className="safe-btn" disabled={!!busy} onClick={execute}>
                        {busy === "Execute" ? "Executing…" : "Execute"}
                      </button>
                    )}
                    {!enough && iApproved && <span className="safe-account">Waiting for another owner.</span>}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {msg && (
          <p className={`safe-msg ${msg.ok ? "is-ok" : "is-bad"}`}>
            {msg.text}{" "}
            {msg.tx && (
              <a href={`${EXPLORER}/tx/${msg.tx}`} target="_blank" rel="noreferrer">
                View transaction
              </a>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
