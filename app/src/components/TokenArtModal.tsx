// "Token art" (user, 2026-11-08): a coin's creator sets its picture, description and links on Ascend without leaving Neuriio.
// Opens from the coin's header (creator only) and from /art. Starts from the creator's X picture and launch profile; two
// silent signatures from their Neuriio wallet (lib/tokenArt.ts). Only works on app.neuriio.xyz (Ascend's Turnstile key).
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { ImageUp, X } from "lucide-react";
import { erc20Abi, type Address } from "viem";
import { elysiumTestnet } from "../chain";
import type { TokenStat } from "../lib/explore";
import { useCreatorProfile } from "./ProfileModal";
import { pub } from "../lib/launch";
import { ART_HOST, artFields, currentArt, artMessage, ART_LIMITS, ASCEND_TURNSTILE_SITE_KEY, claimArt, claimMessage, imageProblem, pinArt, sha256Hex } from "../lib/tokenArt";
import { turnstileToken } from "../lib/turnstile";
import { elysiumProvider, walletClientFor } from "../lib/tx";

const CHAIN_ID = elysiumTestnet.id; // Elysium mainnet, 99901

type Stage = { kind: "idle" } | { kind: "busy"; label: string } | { kind: "done"; verified: boolean } | { kind: "error"; text: string };

/** X serves small pictures by default; the 400x400 one is the same image. */
const bigX = (url: string | null) => (url ? url.replace(/_(normal|bigger|mini|200x200)(\.\w+)$/, "_400x400$2") : null);

export function TokenArtModal({ t, wallet, onClose }: { t: TokenStat; wallet: ConnectedWallet; onClose: () => void }) {
  const account = wallet.address as Address;
  const { profile } = useCreatorProfile(t); // their launch profile: the description and links to start from
  const onHost = location.hostname === ART_HOST;
  const [file, setFile] = useState<{ blob: Blob; name: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(bigX(t.x_pfp_url));
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState(t.kind === "ftf" ? "" : t.handle);
  const [telegram, setTelegram] = useState("");
  useEffect(() => {
    if (!profile) return;
    setDescription((d) => d || profile.about);
    setWebsite((w) => w || (profile.links.find((l) => !/(x|twitter)\.com\/|t\.me\//i.test(l.url))?.url ?? ""));
    setTelegram((g) => g || (profile.links.find((l) => /t\.me\//i.test(l.url))?.url ?? ""));
  }, [profile]);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const busy = stage.kind === "busy";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose, busy]);
  useEffect(() => () => void (file && preview?.startsWith("blob:") && URL.revokeObjectURL(preview)), [file, preview]);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    const problem = await imageProblem(f);
    if (problem) return setStage({ kind: "error", text: problem });
    setFile({ blob: f, name: f.name });
    setPreview(URL.createObjectURL(f));
    setStage({ kind: "idle" });
  };

  const left = useMemo(() => ART_LIMITS.description - description.length, [description]);

  async function publish() {
    try {
      // the picture: the one they chose, else their X picture (X allows app.neuriio.xyz to read it)
      setStage({ kind: "busy", label: "Getting the picture…" });
      let image = file;
      if (!image) {
        const url = bigX(t.x_pfp_url);
        if (!url) throw new Error("Choose a picture first.");
        const res = await fetch(url);
        if (!res.ok) throw new Error("Couldn't load your X picture. Choose one instead.");
        image = { blob: await res.blob(), name: "x-picture.jpg" };
        const problem = await imageProblem(image.blob);
        if (problem) throw new Error(problem);
      }
      // the coin's own name and ticker, as Ascend's app sends them
      const [onchainName, onchainSymbol] = await Promise.all([
        pub.readContract({ address: t.address as Address, abi: erc20Abi, functionName: "name" }),
        pub.readContract({ address: t.address as Address, abi: erc20Abi, functionName: "symbol" }),
      ]);
      const symbol = onchainSymbol.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, ART_LIMITS.symbol) || "TOKEN";
      const checked = artFields({ name: (onchainName.trim() || symbol).slice(0, ART_LIMITS.name), symbol, description, website, twitter, telegram });
      if (!checked.ok) throw new Error(checked.error);

      const client = walletClientFor(await elysiumProvider(wallet), account);
      setStage({ kind: "busy", label: "Signing…" });
      const expires = Math.floor(Date.now() / 1000) + 600;
      const imageSha256 = await sha256Hex(await image.blob.arrayBuffer());
      const signature = await client.signMessage({ account, message: artMessage({ creator: account, chainId: CHAIN_ID, ...checked.fields, imageSha256, expires }) });
      setStage({ kind: "busy", label: "Security check…" });
      const turnstile = await turnstileToken(ASCEND_TURNSTILE_SITE_KEY, "art-turnstile-slot");
      setStage({ kind: "busy", label: "Uploading…" });
      const pinned = await pinArt({ file: image.blob, fileName: image.name, fields: checked.fields, creator: account, chainId: CHAIN_ID, expires, signature, turnstile });
      setStage({ kind: "busy", label: "Attaching to your coin…" });
      const claim = await client.signMessage({ account, message: claimMessage({ chainId: CHAIN_ID, token: t.address, metadataCid: pinned.metadataCid }) });
      const verified = await claimArt(t.address, { chainId: CHAIN_ID, metadataCid: pinned.metadataCid, creator: account, signature: claim });
      setStage({ kind: "done", verified });
    } catch (e) {
      const m = (e as Error).message ?? String(e);
      setStage({ kind: "error", text: /rejected|denied/i.test(m) ? "Cancelled." : m.split("\n")[0].slice(0, 160) });
    }
  }

  return createPortal(
    <div className="nt-backdrop" onClick={() => !busy && onClose()}>
      <div className="nt-modal art-modal" role="dialog" aria-modal="true" aria-label="Token art" onClick={(e) => e.stopPropagation()}>
        <header className="nt-head">
          <span className="nt-title">Token art</span>
          <button className="ex-modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <X size={14} />
          </button>
        </header>

        {stage.kind === "done" ? (
          <div className="art-done">
            {preview && <img src={preview} alt="" className="art-preview" />}
            <p className="art-done-title">{stage.verified ? "Your picture is set" : "Your picture is saved"}</p>
            <p className="art-note">
              {stage.verified ? "It shows on Ascend and on Neuriio now." : "Ascend is still checking it. It usually shows within a minute."}
            </p>
            <button className="lock-login" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            <p className="art-note">Your coin's picture, description and links on Ascend. Shown wherever the coin is listed.</p>
            <label className="art-pic">
              {preview ? <img src={preview} alt="" className="art-preview" /> : <span className="art-preview art-preview-empty" />}
              <span className="art-pic-text">
                <b>{file ? file.name : "Your X picture"}</b>
                <span>
                  <ImageUp size={13} aria-hidden /> Choose another (PNG, JPEG, GIF or WebP, under 2 MB)
                </span>
              </span>
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden disabled={busy} onChange={(e) => pick(e.target.files?.[0])} />
            </label>

            <label className="art-field">
              <span>
                Description <i>{left}</i>
              </span>
              <textarea rows={3} maxLength={ART_LIMITS.description} value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <div className="art-row">
              <label className="art-field">
                <span>Website</span>
                <input value={website} placeholder="https://" disabled={busy} onChange={(e) => setWebsite(e.target.value)} />
              </label>
              <label className="art-field">
                <span>X</span>
                <input value={twitter} placeholder="@handle" disabled={busy} onChange={(e) => setTwitter(e.target.value)} />
              </label>
            </div>
            <label className="art-field">
              <span>Telegram</span>
              <input value={telegram} placeholder="group or handle" disabled={busy} onChange={(e) => setTelegram(e.target.value)} />
            </label>

            <p className="art-warn">This is final: once it's attached, you can't change it yourself. Free, no gas.</p>
            {stage.kind === "error" && <p className="art-msg price-down">{stage.text}</p>}
            {!onHost && <p className="art-msg">Works on {ART_HOST} only (Ascend's security check).</p>}
            <button className="lock-login" disabled={busy || !onHost} onClick={publish}>
              {stage.kind === "busy" ? stage.label : "Set token art"}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The coin header's "Token art" button: only its creator sees it, and only until their art is attached on Ascend. */
export function TokenArtButton({ t }: { t: TokenStat }) {
  const { authenticated } = usePrivy();
  const { wallets } = useWallets();
  const wallet = authenticated ? wallets.find((w) => w.walletClientType === "privy") : undefined;
  const mine = !!wallet && !!t.creator && wallet.address.toLowerCase() === t.creator.toLowerCase();
  const [has, setHas] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!mine) return;
    let alive = true;
    currentArt(t.address).then(
      (a) => alive && setHas(!!a && a.creator.toLowerCase() === t.creator!.toLowerCase()),
      () => alive && setHas(false),
    );
    return () => {
      alive = false;
    };
  }, [mine, t.address, t.creator, open]);
  if (!mine || has !== false || !wallet) return null;
  return (
    <>
      <button className="ex-profile-btn" onClick={() => setOpen(true)}>
        <ImageUp size={13} aria-hidden /> Token art
      </button>
      {open && <TokenArtModal t={t} wallet={wallet} onClose={() => setOpen(false)} />}
    </>
  );
}
