// Explore, far right (beside the order card), split in half (user, 2026-10-17):
//   top:    the picked X token. Staking opens once it graduates; stakers share 40% of its pool fees in USDC and mint
//           Neuriio on every $1 they earn.
//   bottom: Neuriio (minted only by staking X tokens). Stakers share 50% of every curve fee and 40% of every pool
//           fee, in USDC. Neuriio claimed from X staking is staked here automatically.
// Each half: Stake / Unstake / Claim, wired to NeuriioStaking (lib/stake.ts). Rewards drip in over an hour, so the
// earned amounts are re-read every few seconds. `?demo`: sample numbers, simulated actions.
import { useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { formatEther, formatUnits, parseEther, type Address } from "viem";
import { DEMO, displayName, tickerOf, type TokenStat } from "../lib/explore";
import { QUOTE } from "../lib/config";
import { amount as fmtAmount } from "../lib/format";
import { elysiumProvider } from "../lib/tx";
import { claimStaking, friendlyStakeError, NEURIIO, stake, stakePosition, unstake, type StakePosition } from "../lib/stake";

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
          mints
        />
      ) : (
        <p className="ex-empty">Pick a token.</p>
      )}
      <StakeHalf me={me} token={NEURIIO} title="Stake Neuriio" unit="Neuriio" earns="50% curve · 40% pool fees" />
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
  mints = false,
}: {
  me: Me;
  token: Address;
  title: string;
  unit: string;
  earns: string;
  mints?: boolean; // an X token: its stakers also earn Neuriio
}) {
  const [tab, setTab] = useState<Tab>("stake");
  const [amount, setAmount] = useState("");
  const [pos, setPos] = useState<StakePosition | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [nonce, setNonce] = useState(0); // bump to re-read after an action
  const { account, loggedIn } = me;

  useEffect(() => {
    if (!account || !loggedIn) return setPos(null);
    if (DEMO) return setPos(demoPosition(mints));
    let alive = true;
    const load = () => stakePosition(account, token).then((p) => alive && setPos(p), () => {});
    load();
    const id = setInterval(load, 10_000); // rewards drip in over an hour: every 10 s is plenty (the RPC rate-limits)
    return () => {
      alive = false;
      clearInterval(id);
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
  const nothing = pos !== null && pos.usdc === 0n && pos.neuriio === 0n;

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
          ? `Claimed ${fmtUsdc(pos?.usdc ?? 0n)} USDC${mints && pos && pos.neuriio > 0n ? ` · ${fmtTokens(pos.neuriio)} Neuriio staked` : ""}`
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
          {mints ? (
            <div>
              <dt title="Claiming stakes it for you">Neuriio minted</dt>
              <dd>{pos ? fmtTokens(pos.neuriio) : "—"}</dd>
            </div>
          ) : (
            <div>
              <dt>Paid out</dt>
              <dd>USDC to your wallet</dd>
            </div>
          )}
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
          <dl className="ex-order-est">
            <div>
              <dt>Stakers earn</dt>
              <dd>{earns}</dd>
            </div>
          </dl>
        </>
      )}

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

/** ?demo: a staker of the picked token and of Neuriio. */
function demoPosition(mints: boolean): StakePosition {
  return mints
    ? { open: true, wallet: parseEther("2500000"), staked: parseEther("1000000"), totalStaked: parseEther("40000000"), usdc: 3_210_000n, neuriio: parseEther("321"), gas: parseEther("0.2") }
    : { open: true, wallet: 0n, staked: parseEther("640"), totalStaked: parseEther("25000"), usdc: 1_870_000n, neuriio: 0n, gas: parseEther("0.2") };
}
