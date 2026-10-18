// FTF ("Friends Turned Fam") client: talks to the `ftf` Edge Function with the Privy login (supabase/functions/ftf).
// Forming: the founder names it + invites 3 people -> each accepts from their notifications (an off-chain "yes", no
// transaction) -> with 4 in, the founder adds category, profile and picture -> gets a signed pass -> Launchpad.launchFtf.
// `?demo`: an in-memory stand-in (invites are accepted after a few seconds).
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { usePrivy } from "@privy-io/react-auth";
import type { CategoryId, SectorId } from "./launch";
import { SUPABASE_URL } from "./config";

export const DEMO = import.meta.env.DEV && new URLSearchParams(location.search).has("demo");

export type FtfMember = {
  x_user_id: string;
  role: "founder" | "member";
  status: "invited" | "requested" | "accepted" | "declined";
  x_handle?: string;
  x_name?: string | null;
  x_pfp_url?: string | null;
};
export type FtfDraft = {
  id: string;
  founder: string;
  name: string;
  ticker: string;
  status: string;
  sector: SectorId | null;
  category: CategoryId | null;
  pfpUrl: string | null;
  about: string | null;
  links: { label: string; url: string }[];
};
export type FtfView = { draft: FtfDraft | null; members: FtfMember[] };
export type FtfPassResponse = {
  pass: {
    founder: `0x${string}`;
    name: string;
    ticker: string;
    memberXIds: string[];
    members: `0x${string}`[];
    profileHash: `0x${string}`;
    deadline: string;
  };
  signature: `0x${string}`;
  launchpad: `0x${string}`; // the NeuriioPad the pass is signed for
};
type NoticeFrom = { x_user_id: string; x_handle?: string; x_name?: string | null; x_pfp_url?: string | null };
export type Notice =
  | { kind: "invite" | "request"; draftId: string; name: string; ticker: string; from: NoticeFrom; at: string }
  /** admins only: someone asked for testnet HYPE (HypeButton) */
  | { kind: "hype"; id: number; wallet: string; from: NoticeFrom; at: string };

/** Your latest manual request, and whether you've had your one faucet claim. */
/** `claimed`: this X account got its 0.2 HYPE from the faucet; `usdcClaimed`: its 1,000 test USDC. */
export type HypeStatus = { status: "none" | "pending" | "sent" | "dismissed"; at: string | null; claimed?: boolean; usdcClaimed?: boolean };
export type HypeClaim =
  | { status: "sent"; tx: string; hypeTx?: string; usdcTx?: string }
  | { status: "claimed" }
  | { status: "fallback"; usdcTx?: string };

export const FTF_NAME_RE = /^[A-Za-z0-9_.&'-]+( [A-Za-z0-9_.&'-]+)*$/;
export const FTF_TICKER_RE = /^[A-Z0-9]{2,10}$/;

/** One call to the `ftf` function. Throws the function's own message on failure. */
export async function ftfCall<T>(getToken: () => Promise<string | null>, action: string, body: Record<string, unknown> = {}): Promise<T> {
  if (DEMO) return demoCall(action, body) as T;
  const token = await getToken();
  if (!token) throw new Error("Log in first");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ftf`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

/** Reads a picked file as base64 (without the data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Couldn't read that picture"));
    r.readAsDataURL(file);
  });
}

// ------------------------------------------------------------------ notifications (shared store)

let notices: Notice[] = [];
const listeners = new Set<() => void>();
let refreshFn: (() => void) | null = null;
const emit = () => listeners.forEach((l) => l());

/** Polls the inbox (every 20 s) while logged in; mount once near the top of the app. */
export function useNotificationsPoller() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const on = DEMO || (ready && authenticated);
  const refresh = useCallback(() => {
    if (!on) return;
    ftfCall<{ items: Notice[] }>(getAccessToken, "inbox").then(
      (r) => {
        notices = r.items;
        emit();
      },
      () => {},
    );
  }, [on, getAccessToken]);
  useEffect(() => {
    if (!on) {
      notices = [];
      emit();
      return;
    }
    refreshFn = refresh;
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => {
      clearInterval(id);
      refreshFn = null;
    };
  }, [on, refresh]);
}

export function useNotifications() {
  const items = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => notices,
  );
  return { items, refresh: () => refreshFn?.() };
}

// ------------------------------------------------------------------ demo stand-in

const demo: { view: FtfView; timers: number[] } = { view: { draft: null, members: [] }, timers: [] };
let demoNotices: Notice[] = [
  {
    kind: "invite",
    draftId: "demo-other",
    name: "Night Owls",
    ticker: "OWL",
    from: { x_user_id: "2001", x_handle: "chartwizard", x_name: "Chart Wizard", x_pfp_url: null },
    at: new Date().toISOString(),
  },
];

function demoCall(action: string, body: Record<string, unknown>): unknown {
  const v = demo.view;
  const snapshot = () => JSON.parse(JSON.stringify(demo.view));
  switch (action) {
    case "inbox":
      return { items: demoNotices };
    case "hypeStatus":
      return { status: "none", at: null, claimed: false, usdcClaimed: false };
    case "claimHype":
      return { status: "sent", tx: "0x" + "ab".repeat(32), hypeTx: "0x" + "ab".repeat(32), usdcTx: "0x" + "cd".repeat(32) };
    case "hype":
      return { status: "pending", at: new Date().toISOString() };
    case "mine":
      return snapshot();
    case "create":
      demo.view = {
        draft: { id: "demo", founder: "1", name: String(body.name), ticker: String(body.ticker).toUpperCase(), status: "open", sector: null, category: null, pfpUrl: null, about: null, links: [] },
        members: [{ x_user_id: "1", role: "founder", status: "accepted", x_handle: "neuriio" }],
      };
      return snapshot();
    case "invite": {
      const handle = String(body.handle).replace(/^@/, "");
      const m: FtfMember = { x_user_id: `d-${handle}`, role: "member", status: "invited", x_handle: handle };
      v.members.push(m);
      demo.timers.push(window.setTimeout(() => (m.status = "accepted"), 2500 + Math.random() * 3000)); // they accept
      return snapshot();
    }
    case "remove":
      v.members = v.members.filter((m) => m.x_user_id !== body.xUserId);
      return snapshot();
    case "profile":
      Object.assign(v.draft!, { sector: body.sector, category: body.category, about: body.about, links: body.links });
      return snapshot();
    case "pfp":
      v.draft!.pfpUrl = `data:${body.contentType};base64,${body.base64}`;
      return snapshot();
    case "accept":
    case "decline":
    case "approve":
      demoNotices = demoNotices.filter((n) => n.kind === "hype" || n.draftId !== body.draftId || (body.xUserId && n.from.x_user_id !== body.xUserId));
      return snapshot();
    case "cancel":
      demo.view = { draft: null, members: [] };
      return snapshot();
    default:
      throw new Error(`demo: ${action} isn't simulated`);
  }
}
