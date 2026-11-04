// Account panel: referral code (lib/referral.ts). No code yet: a field (filled in from a partner's `?ref=` link) + Apply. Once applied it's
// fixed ("Referred by CODE") and the wallets that count are listed: the Neuriio wallet automatically, each outside wallet connected on Home
// after its owner signs with Verify (checked again by the `referral` edge function). `?demo` runs it on sample wallets.
import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useConnections, useSignMessage } from "wagmi";
import { pendingCode, useReferral } from "../lib/referral";
import { shortAddress } from "../lib/format";

export type RefWallet = { address: string; name: string; status: "auto" | "verified" | "unverified"; onVerify?: () => Promise<void> };

type Props = {
  code: string | null;
  onApply: (code: string) => Promise<string | null>;
  wallets: RefWallet[];
};

export function ReferralBox({ code, onApply, wallets }: Props) {
  const [draft, setDraft] = useState(() => pendingCode() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    setBusy(true);
    setError(await onApply(draft));
    setBusy(false);
  };
  return (
    <section className="venue venue-box ref-box">
      <header>
        <span>Referral</span>
        {code && <span className="ref-by">Referred by {code}</span>}
      </header>
      {code ? (
        <>
          {wallets.map((w) => (
            <RefWalletRow key={w.address} w={w} onError={setWalletError} />
          ))}
          <p className="fees-note">{walletError ?? `Trades from these wallets count for ${code}.`}</p>
        </>
      ) : (
        <>
          <form
            className="ref-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && draft.trim()) void apply();
            }}
          >
            <input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value.toUpperCase());
                setError(null);
              }}
              placeholder="Enter code"
              maxLength={20}
              spellCheck={false}
              autoComplete="off"
              aria-label="Referral code"
            />
            <button className="fees-claim" disabled={busy || !draft.trim()}>
              {busy ? "Applying…" : "Apply"}
            </button>
          </form>
          <p className="fees-note">{error ?? "One code per account. It can't be changed once applied."}</p>
        </>
      )}
    </section>
  );
}

function RefWalletRow({ w, onError }: { w: RefWallet; onError: (message: string | null) => void }) {
  const [state, setState] = useState<"idle" | "signing" | "retry">("idle");
  const verify = async () => {
    setState("signing");
    onError(null);
    try {
      await w.onVerify!();
      setState("idle");
    } catch (e) {
      const m = (e as Error).message;
      setState("retry");
      onError(/rejected|denied/i.test(m) ? "Signing cancelled" : m.length < 80 ? m : "Couldn't verify, try again");
    }
  };
  return (
    <div className="ref-wallet">
      <span className="ref-wallet-name" title={w.address}>
        {w.name} · {shortAddress(w.address)}
      </span>
      {w.status === "unverified" ? (
        <button className="ref-verify" disabled={state === "signing"} onClick={verify} title="Sign a free message to prove this wallet is yours">
          {state === "signing" ? "Signing…" : state === "retry" ? "Retry" : "Verify"}
        </button>
      ) : (
        <span className="ref-ok">
          <Check size={12} /> {w.status === "auto" ? "Counted" : "Verified"}
        </span>
      )}
    </div>
  );
}

/** The logged-in panel's box: the account's Neuriio wallet, outside wallets already verified, and outside wallets connected on Home. */
export function LiveReferral({ account }: { account: string }) {
  const { status, apply, verify } = useReferral(account);
  const connections = useConnections();
  const { mutateAsync: signMessage } = useSignMessage();
  const wallets = useMemo<RefWallet[]>(() => {
    const seen = new Set([account.toLowerCase()]);
    const signed = (status?.wallets ?? []).filter((w) => w.kind === "signed" && !seen.has(w.address.toLowerCase()) && seen.add(w.address.toLowerCase()));
    const outside = connections.flatMap((c) =>
      c.accounts
        .filter((a) => !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()))
        .map(
          (address): RefWallet => ({
            address,
            name: c.connector.name,
            status: "unverified",
            onVerify: () => verify(address, (message) => signMessage({ account: address, connector: c.connector, message })),
          }),
        ),
    );
    return [
      { address: account, name: "Neuriio", status: "auto" },
      ...signed.map((w): RefWallet => ({ address: w.address, name: "Wallet", status: "verified" })),
      ...outside,
    ];
  }, [account, connections, status, verify, signMessage]);
  if (!status) return null;
  return <ReferralBox code={status.code} onApply={apply} wallets={wallets} />;
}

/** `?demo`: starts with no code; Apply and Verify work on sample wallets. */
export function DemoReferral() {
  const [code, setCode] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const wallets: RefWallet[] = [
    { address: "0xF1AECC201d3EEb695C0f4409dbB5e01005E8E2aE", name: "Neuriio", status: "auto" },
    { address: "0x9a3B6c1d7E4f2A8b5C0d3e6F1a4B7c2D5e8F0a3B", name: "Rabby", status: "verified" },
    {
      address: "0x4C2e8F1a9B3d6E0f7A2c5B8d1E4f7A0b3C6d9E2f",
      name: "MetaMask",
      status: verified ? "verified" : "unverified",
      onVerify: async () => {
        await new Promise((r) => setTimeout(r, 900));
        setVerified(true);
      },
    },
  ];
  return (
    <ReferralBox
      code={code}
      onApply={async (c) => {
        await new Promise((r) => setTimeout(r, 500));
        const n = c.trim().toUpperCase();
        if (!/^[A-Z0-9_]{3,20}$/.test(n)) return "Codes are 3 to 20 letters, numbers or _";
        setCode(n);
        return null;
      }}
      wallets={wallets}
    />
  );
}
