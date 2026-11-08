// /art (user, 2026-11-08): a creator sets their coin's art on Ascend. Reachable while the rest of the site is paused (like
// /safe), because Ascend's Turnstile key only works on app.neuriio.xyz. Log in with X -> your coin (from our own data) ->
// the Token art window. No chain reads until you press Set.
import { useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { Avatar } from "./Avatar";
import { TokenArtModal } from "./TokenArtModal";
import { tokenOfCreatorWallet, type TokenStat } from "../lib/explore";
import { currentArt } from "../lib/tokenArt";

export function ArtPage() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const wallet = authenticated ? wallets.find((w) => w.walletClientType === "privy") : undefined;
  const [coin, setCoin] = useState<TokenStat | null | undefined>(undefined);
  const [art, setArt] = useState<"none" | "set" | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!wallet) return setCoin(undefined);
    let alive = true;
    tokenOfCreatorWallet(wallet.address).then((t) => alive && setCoin(t), () => alive && setCoin(null));
    return () => {
      alive = false;
    };
  }, [wallet?.address]);
  useEffect(() => {
    if (!coin) return setArt(null);
    currentArt(coin.address).then(
      (a) => setArt(a && a.creator.toLowerCase() === coin.creator.toLowerCase() ? "set" : "none"),
      () => setArt("none"),
    );
  }, [coin, open]);

  return (
    <main className="art-page">
      <section className="panel art-card">
        <img src="/brand/mark.png" alt="Neuriio" className="art-logo" />
        <h1 className="art-h1">Token art</h1>
        {!ready ? (
          <p className="art-note">Loading…</p>
        ) : !authenticated ? (
          <>
            <p className="art-note">Log in with the X account you launched with to set your coin's picture on Ascend.</p>
            <button className="lock-login" onClick={login}>
              Log in with X
            </button>
          </>
        ) : coin === undefined ? (
          <p className="art-note">Finding your coin…</p>
        ) : coin === null ? (
          <>
            <p className="art-note">This account hasn't launched a coin on Neuriio.</p>
            <button className="art-link" onClick={logout}>
              Log out
            </button>
          </>
        ) : (
          <>
            <div className="art-coin">
              <Avatar handle={coin.handle} pfp={coin.x_pfp_url} size={44} />
              <span>
                <b>${coin.symbol ?? coin.handle}</b>
                <span>@{coin.handle}</span>
              </span>
            </div>
            {art === "set" ? (
              <p className="art-note">Your coin's art is set on Ascend.</p>
            ) : (
              <button className="lock-login" disabled={art === null || !wallet} onClick={() => setOpen(true)}>
                {art === null ? "Checking…" : "Set token art"}
              </button>
            )}
            <button className="art-link" onClick={logout}>
              Log out
            </button>
          </>
        )}
      </section>
      {open && coin && wallet && <TokenArtModal t={coin} wallet={wallet} onClose={() => setOpen(false)} />}
    </main>
  );
}
