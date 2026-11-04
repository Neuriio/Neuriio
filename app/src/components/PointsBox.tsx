// Neuriio button: opens its panel. The head shows your Neuriio, a tally that converts into the token when it launches (user, 2026-11-01);
// only stakers get it (lib/neuriio.ts). Below that, how far you are from your next rank, then the 8 badges, lowest rank first: in color
// once reached, grey until then (lib/badges.ts). Logged out, the badges are blurred behind a small "Login to Account" card (text only:
// logging in happens from the Account button). `?demo`: a sample balance.
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { BADGES, rankOf } from "../lib/badges";
import { DEV_DEMO } from "../lib/explore";
import { useNeuriio } from "../lib/neuriio";
import { Morph } from "./Morph";

const whole = (n: number) => Math.floor(n).toLocaleString("en-US");
const short = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1_000}K`);

export function PointsBox() {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const locked = !DEV_DEMO && !(ready && authenticated);
  const mine = useNeuriio(locked || DEV_DEMO ? undefined : wallets.find((w) => w.walletClientType === "privy")?.address);
  const neuriio = DEV_DEMO ? 180_000 : mine;
  const { earned, next, toGo, progress } = rankOf(neuriio);

  return (
    <Morph
      label="Neuriio"
      triggerClassName="points"
      trigger={<span className="top-value">Neuriio</span>}
      head={
        <span className="points-head">
          <span>Neuriio</span>
          <span>{whole(neuriio)}</span>
        </span>
      }
      bodyClassName={`points-body${locked ? " panel-body-locked" : ""}`}
      overlay={
        locked
          ? () => (
              <div className="lock-overlay">
                <div className="lock-card">
                  <span className="lock-title">Login to Account</span>
                </div>
              </div>
            )
          : undefined
      }
    >
      <div className="points-next">
        <p>
          {next ? (
            <>
              <b>{whole(Math.ceil(toGo))}</b> to {next.name}
            </>
          ) : (
            "Top rank reached"
          )}
        </p>
        <div className="points-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label={next ? `Progress to ${next.name}` : "Top rank"}>
          <span style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
      <div className="points-grid">
        {BADGES.map((b, i) => (
          <div key={b.file} className={`points-slot${i < earned ? " is-earned" : ""}`} title={`${b.name}: ${whole(b.neuriio)} Neuriio`}>
            <img className={b.file.startsWith("star") ? "is-star" : undefined} src={`/brand/badges/${b.file}`} alt={b.name} />
            <span>{short(b.neuriio)}</span>
          </div>
        ))}
      </div>
    </Morph>
  );
}
