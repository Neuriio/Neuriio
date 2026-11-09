// /swap (user, 2026-11-09): a Swap / Bridge toggle above the card. Swap = SwapCard (HYPE / USDC / KNTQ on Elysium); Bridge =
// BridgeCard (HYPE Elysium <-> HyperEVM through Relay). ?mode=bridge opens on Bridge.
import { useState } from "react";
import { BridgeCard } from "./BridgeCard";
import { SwapCard } from "./SwapCard";

type Mode = "swap" | "bridge";

export function SwapPage() {
  const [mode, setMode] = useState<Mode>(() => (new URLSearchParams(location.search).get("mode") === "bridge" ? "bridge" : "swap"));
  const pick = (m: Mode) => {
    setMode(m);
    const u = new URL(location.href);
    if (m === "bridge") u.searchParams.set("mode", "bridge");
    else u.searchParams.delete("mode");
    history.replaceState(null, "", u.pathname + u.search);
  };
  return (
    <div className="sw-page">
      <div className="sw-mode" role="tablist" aria-label="Swap or bridge">
        {(["swap", "bridge"] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={`sw-mode-btn${mode === m ? " is-on" : ""}`} onClick={() => pick(m)}>
            {m === "swap" ? "Swap" : "Bridge"}
          </button>
        ))}
      </div>
      {mode === "swap" ? <SwapCard /> : <BridgeCard />}
    </div>
  );
}
