// Explore, the Stake tab: the picked X token. Staking opens once it graduates; stakers share 40% of its pool fees in USDC.
// Neuriio Minted is what will track a user's Neuriio: a tally (nothing on-chain) that converts into the token when it
// launches (user, 2026-11-01): 100 for every $1 a staker earns, and staking is the only way to get it (lib/neuriio.ts).
// Stake / Unstake / Claim, wired to NeuriioStaking (lib/stake.ts). Rewards drip in over an hour, so the earned amounts
// are re-read every few seconds. `?demo`: sample numbers, simulated actions.
import { useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { formatEther, formatUnits, parseEther, type Address } from "viem";
import { DEMO, displayName, isOurs, tickerOf, type TokenStat } from "../lib/explore";
import { NotTradable } from "./OrderCard";
import { QUOTE } from "../lib/config";
import { amount as fmtAmount } from "../lib/format";
import { useNeuriio } from "../lib/neuriio";
import { elysiumProvider } from "../lib/tx";
import { claimStaking, friendlyStakeError, stake, stakePosition, unstake, type StakePosition } from "../lib/stake";
import { poll } from "../lib/poll";

type Tab = "stake" | "unstake" | "claim";
const TABS: { id: Tab; label: string }[] = [
  { id: "stake", label: "Stake" },
  { id: "unstake", label: "Unstake" },
  { id: "claim", label: "Claim" },
];
type Status = { kind: "idle" } | { kind: "busy"; label: string } | { kind: "done"; text: string } | { kind: "error"; text: string };

export function StakeCard({ t }: { t: TokenStat | null }) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy");
  const me: Me = {
    account: (DEMO ? "0x000000000000000000000000000000000000dE00" : wallet?.address) as Address | undefined,
    loggedIn: DEMO || (ready && authenticated && !!wallet),
    login,
    provider: () => elysiumProvider(wallet!),
  };
  // a token launched elsewhere: the same box as Buy / Sell (user, 2026-11-06); staking opens once it's approved for trading
  if (t && !isOurs(t)) return <NotTradable t={t} />;
  return (
    <div className="ex-stake">
      {t ? (
        <StakeHalf
          key={t.address}
          me={me}
          token={t.address as Address}
          title={`Stake ${displayName(t)}`}
          unit={tickerOf(t.symbol)}
          earns="40% of its pool fees"
        />
      ) : (
        <p className="ex-empty">Pick a token.</p>
      )}
    </div>
  );
}

type Me = { account?: Address; loggedIn: boolean; login: () => void; provider: () => ReturnType<typeof elysiumProvider> };

function StakeHalf({
  me,
  token,
  title,
  unit,
  earns,
}: {
  me: Me;
  token: Address;
  title: string;
  unit: string;
  earns: string;
}) {
  const [tab, setTab] = useState<Tab>("stake");
  const neuriio = useNeuriio(me.account, token);
  const [amount, setAmount] = useState("");
  const [pos, setPos] = useState<StakePosition | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [nonce, setNonce] = useState(0); // bump to re-read after an action
  const { account, loggedIn } = me;

  useEffect(() => {
    if (!account || !loggedIn) return setPos(null);
    if (DEMO) return setPos(demoPosition());
    let alive = true;
    const load = () => stakePosition(account, token).then((p) => alive && setPos(p), () => {});
    const stop = poll(load, 30_000, { onChain: true }); // rewards drip in over an hour: 30 s is plenty, and right after your own stake/claim
    return () => {
      alive = false;
      stop();
    };
  }, [account, loggedIn, token, nonce]);

  const amountIn = useMemo(() => {
    try {
      return amount ? parseEther(amount as `${number}`) : 0n;
    } catch {
      return 0n;
    }
  }, [amount]);

  const have = pos ? (tab === "stake" ? pos.wallet : pos.staked) : null;
  const busy = status.kind === "busy";
  const nothing = pos !== null && pos.usdc === 0n;

  async function submit() {
    if (!account) return;
    const label = tab === "stake" ? "Staking…" : tab === "unstake" ? "Unstaking…" : "Claiming…";
    setStatus({ kind: "busy", label });
    try {
      if (DEMO) await new Promise((r) => setTimeout(r, 1000));
      else {
        const provider = await me.provider();
        if (tab === "stake") await stake(provider, account, token, amountIn, () => setStatus({ kind: "busy", label: "Approving…" }));
        else if (tab === "unstake") await unstake(provider, account, token, amountIn);
        else await claimStaking(provider, account, [token]);
      }
      const text =
        tab === "claim"
          ? `Claimed ${fmtUsdc(pos?.usdc ?? 0n)} USDC`
          : `${tab === "stake" ? "Staked" : "Unstaked"} ${fmtTokens(amountIn)} ${unit}`;
      setStatus({ kind: "done", text });
      setAmount("");
      setNonce((n) => n + 1);
    } catch (e) {
      setStatus({ kind: "error", text: friendlyStakeError((e as Error).message) });
    }
  }

  let cta = tab === "stake" ? "Stake" : tab === "unstake" ? "Unstake" : "Claim";
  let disabled = busy;
  if (!loggedIn) cta = "Log in to stake";
  else if (busy) cta = status.label;
  else if (!pos) (cta = "…"), (disabled = true);
  else if (!pos.open) (cta = "Opens after graduation"), (disabled = true);
  else if (tab === "claim" && nothing) (cta = "Nothing to claim yet"), (disabled = true);
  else if (tab !== "claim" && amountIn === 0n) (cta = "Enter an amount"), (disabled = true);
  else if (tab !== "claim" && have !== null && amountIn > have) (cta = tab === "stake" ? `Not enough ${unit}` : "More than you have staked"), (disabled = true);
  else if (!DEMO && pos.gas === 0n) (cta = "Need a little HYPE for gas"), (disabled = true);

  return (
    <section className="ex-stake-half">
      <header className="ex-stake-head">
        <span className="ex-stake-title">{title}</span>
        <span className="ex-order-bal">Staked {pos ? fmtTokens(pos.staked) : "—"}</span>
      </header>
      <div className="ex-order-tabs ex-stake-tabs" role="tablist">
        {TABS.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            className={`ex-order-tab is-stake${tab === x.id ? " is-on" : ""}`}
            onClick={() => {
              setTab(x.id);
              setAmount("");
              setStatus({ kind: "idle" });
            }}
          >
            {x.label}
          </button>
        ))}
      </div>

      {tab === "claim" ? (
        <dl className="ex-order-est">
          <div>
            <dt>USDC earned</dt>
            <dd>{pos ? fmtUsdc(pos.usdc) : "—"}</dd>
          </div>
          <div>
            <dt>Paid out</dt>
            <dd>USDC to your wallet</dd>
          </div>
        </dl>
      ) : (
        <>
          <span className="ex-order-input">
            <input
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              disabled={!pos?.open}
              onChange={(e) => {
                setAmount(e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"));
                setStatus({ kind: "idle" });
              }}
            />
            <button
              className="ex-range ex-stake-max"
              disabled={!pos?.open || !have}
              onClick={() => have && setAmount(formatEther(have))}
              title={have !== null ? `${tab === "stake" ? "In your wallet" : "Staked"}: ${fmtTokens(have)}` : undefined}
            >
              Max
            </button>
            <span className="ex-order-unit">{unit}</span>
          </span>
          <p className="ex-stake-earns">Stakers earn {earns}</p>
        </>
      )}
      <p className="ex-stake-earns">Neuriio Minted: {fmtAmount(neuriio)}</p>

      {status.kind === "done" && <p className="ex-order-msg price-up">{status.text}</p>}
      {status.kind === "error" && <p className="ex-order-msg price-down">{status.text}</p>}

      <button className="ex-order-cta is-stake" disabled={disabled} onClick={loggedIn ? submit : me.login}>
        {cta}
      </button>
    </section>
  );
}

const fmtTokens = (wei: bigint) => fmtAmount(Number(formatEther(wei)));
const fmtUsdc = (units: bigint) =>
  Number(formatUnits(units, QUOTE.decimals)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: units < 10_000n ? 6 : 2 });

/** ?demo: a staker of the picked token. */
function demoPosition(): StakePosition {
  return { open: true, wallet: parseEther("2500000"), staked: parseEther("1000000"), totalStaked: parseEther("40000000"), usdc: 3_210_000n, gas: parseEther("0.2") };
}
