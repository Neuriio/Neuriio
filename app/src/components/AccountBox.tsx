// Account button. Clicking it opens the account panel; Escape, the × or a click
// outside closes it.
//   Logged out: the button says "Account"; the panel shows a blurred placeholder with a small centered
//   card whose Login button opens Privy (X, Google, Telegram). Every user gets a Neuriio wallet.
//   Logged in: the button shows picture + handle; the panel has the deposit address (copy) + Send (any token
//   to any address on Elysium, the Feed's send window), balances on Elysium by token, the referral code (ReferralBox),
//   private key export (Privy's own secure modal) and log out. HyperCore balances and the creator fees box were removed
//   (user, 2026-11-03).
import { useState, type ReactNode } from "react";
import { Bell, Check, Copy } from "lucide-react";
import { useNotifications } from "../lib/ftf";
import { NotificationsModal } from "./NotificationsModal";
import { SendModal } from "./SendModal";
import { useExportWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import type { Address } from "viem";
import { useBalances } from "../lib/useBalances";
import type { Balances, VenueBalance } from "../lib/balances";
import { profileOf, type Profile } from "../lib/profile";
import { amount, shortAddress, usd } from "../lib/format";
import { Morph } from "./Morph";
import { DemoReferral, LiveReferral } from "./ReferralBox";

// Dev-only preview of the logged-in panel with sample data: localhost:5173/?demo
const DEMO = import.meta.env.DEV && new URLSearchParams(location.search).has("demo");

export function AccountBox() {
  const { ready, authenticated, login } = usePrivy();
  if (DEMO) return <MorphView {...DEMO_PROPS} />;
  if (ready && authenticated) return <AccountMorph />;
  return <MorphView {...LOCKED_PROPS} locked loginReady={ready} onLogin={login} />;
}

function AccountMorph() {
  const { user, logout } = usePrivy();
  const { wallets } = useWallets();
  const { exportWallet } = useExportWallet();
  const wallet = wallets.find((w) => w.walletClientType === "privy");
  const { balances } = useBalances(wallet?.address as Address | undefined);
  return (
    <MorphView
      me={profileOf(user)}
      address={wallet?.address}
      balances={balances}
      referral={wallet ? <LiveReferral account={wallet.address} /> : undefined}
      onExport={wallet ? () => exportWallet({ address: wallet.address }) : undefined}
      onLogout={logout}
    />
  );
}

type MorphViewProps = {
  me: Profile;
  address?: string;
  balances: Balances | null;
  referral?: ReactNode;
  onExport?: () => void;
  onLogout: () => void;
  /** logged out: blurred placeholder + centered Login card */
  locked?: boolean;
  loginReady?: boolean;
  onLogin?: () => void;
};

function MorphView({ me, address, balances, referral, onExport, onLogout, locked = false, loginReady = true, onLogin }: MorphViewProps) {
  const { items } = useNotifications();
  const count = locked ? 0 : items.length;
  const [bellOpen, setBellOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  return (
    <Morph
      label="Account"
      triggerClassName={locked ? "account-trigger-locked" : ""}
      trigger={
        locked ? (
          <span className="login-text">Account</span>
        ) : (
          <span className="account-id">
            <Avatar src={me.avatar} initial={me.initial} />
            <span className="account-name">{me.name}</span>
            {count > 0 && (
              <span className="notif-count" aria-label={`${count} notifications`}>
                {count}
              </span>
            )}
          </span>
        )
      }
      head={
        locked ? (
          <span className="account-name">Account</span>
        ) : (
          <span className="account-head">
            <span className="account-id">
              <Avatar src={me.avatar} initial={me.initial} />
              <span className="account-name">{me.name}</span>
            </span>
            <button className="notif-bell" onClick={() => setBellOpen(true)} aria-label="Notifications" title="Notifications">
              <Bell size={14} />
              {count > 0 && <span className="notif-count">{count}</span>}
            </button>
          </span>
        )
      }
      bodyClassName={locked ? "panel-body-locked" : ""}
      overlay={
        locked
          ? (close) => (
              <div className="lock-overlay">
                <div className="lock-card">
                  <span className="lock-title">Log in to see your wallet</span>
                  <button
                    type="button"
                    className="lock-login"
                    disabled={!loginReady}
                    onClick={() => {
                      close();
                      onLogin?.();
                    }}
                  >
                    Login
                  </button>
                </div>
              </div>
            )
          : undefined
      }
    >
      {address ? (
        <DepositAddress address={address} onSend={locked ? undefined : () => setSendOpen(true)} />
      ) : (
        <p className="empty">Creating your wallet…</p>
      )}
      <Venue name="Elysium" v={balances?.elysium} />
      {!locked && referral}
      {!locked && <NotificationsModal open={bellOpen} onClose={() => setBellOpen(false)} />}
      {!locked && <SendModal target={sendOpen ? "address" : null} onClose={() => setSendOpen(false)} />}
      {!locked && (
        <div className="dropdown-actions">
          {onExport && (
            <button className="link-btn link-btn-small" onClick={onExport}>
              Export private key
            </button>
          )}
          <button className="link-btn" onClick={onLogout}>
            Log out
          </button>
        </div>
      )}
    </Morph>
  );
}

function Avatar({ src, initial }: { src: string | null; initial: string }) {
  const [broken, setBroken] = useState(false);
  return src && !broken ? (
    <img className="avatar" src={src} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
  ) : (
    <span className="avatar avatar-initial">{initial}</span>
  );
}

function DepositAddress({ address, onSend }: { address: string; onSend?: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="deposit">
      <button className="deposit-address" onClick={copy} title="Copy address">
        <span>{shortAddress(address)}</span>
        <span className="copy">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </span>
      </button>
      <span className="deposit-foot">
        <span className="deposit-note">Elysium Mainnet Only</span>
        {onSend && (
          <button className="feed-act feed-send" onClick={onSend}>
            Send <b>$</b>
          </button>
        )}
      </span>
    </div>
  );
}

function Venue({ name, v }: { name: string; v?: VenueBalance }) {
  return (
    <section className="venue venue-box">
      <header>
        <span>{name}</span>
        <span>{v ? usd(v.total) : "…"}</span>
      </header>
      {v && v.tokens.length === 0 && <p className="empty">No balance</p>}
      {v?.tokens.map((t) => (
        <div className="token" key={t.symbol}>
          <span>{t.symbol}</span>
          <span className="token-amt">{amount(t.amount)}</span>
          <span className="token-usd">{usd(t.usd)}</span>
        </div>
      ))}
    </section>
  );
}

const DEMO_PROPS: MorphViewProps = {
  me: { name: "@neuriio_demo", avatar: null, initial: "N" },
  address: "0xF1AECC201d3EEb695C0f4409dbB5e01005E8E2aE",
  balances: {
    total: 1834.52,
    at: 0,
    elysium: {
      total: 552.02,
      tokens: [
        { symbol: "HYPE", amount: 0, usd: 0 },
        { symbol: "KNTQ", amount: 0, usd: 0 },
        { symbol: "USDC", amount: 552.02, usd: 552.02 },
      ],
    },
    hypercore: {
      total: 1282.5,
      tokens: [
        { symbol: "HYPE", amount: 2.85, usd: 262.4 },
        { symbol: "KNTQ", amount: 0, usd: 0 },
        { symbol: "USDC", amount: 1020.1, usd: 1020.1 },
      ],
    },
  },
  referral: <DemoReferral />,
  onExport: () => alert("demo: Privy export modal opens here"),
  onLogout: () => alert("demo: logs out"),
};

/** What sits blurred behind the Login card while logged out (never real data). */
const LOCKED_PROPS: MorphViewProps = {
  me: { name: "Account", avatar: null, initial: "A" },
  address: "0x0000000000000000000000000000000000000000",
  balances: {
    total: 0,
    at: 0,
    elysium: { total: 0, tokens: ["HYPE", "KNTQ", "USDC"].map((symbol) => ({ symbol, amount: 0, usd: 0 })) },
    hypercore: { total: 0, tokens: ["HYPE", "KNTQ", "USDC"].map((symbol) => ({ symbol, amount: 0, usd: 0 })) },
  },
  onLogout: () => {},
};
