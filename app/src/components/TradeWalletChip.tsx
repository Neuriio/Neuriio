// Top right of the Swap and Bridge cards (user, 2026-11-11): the wallet the card trades from (lib/tradeWallet.ts), in Home's chip
// style. With two wallets (an added one + the Neuriio one) the chip switches between them; "+ Add wallet" opens Home's picker.
import { useState } from "react";
import { ArrowLeftRight, Plus, X } from "lucide-react";
import { useDisconnect } from "wagmi";
import { shortAddress } from "../lib/format";
import type { TradeWallet } from "../lib/tradeWallet";
import { AddWalletModal } from "./PortfolioPanel";

export function TradeWalletChip({ list, active, onChoose }: { list: TradeWallet[]; active: TradeWallet | null; onChoose: (address: string) => void }) {
  const [adding, setAdding] = useState(false);
  const { mutate: disconnect } = useDisconnect();
  const other = active ? list.find((w) => w !== active) : undefined;
  const hasAdded = list.some((w) => w.kind === "added");
  return (
    <span className="tw">
      {active && (
        <span className="pf-wallet tw-chip" title={active.address}>
          <button
            className="tw-switch"
            disabled={!other}
            onClick={() => other && onChoose(other.address)}
            title={other ? `Switch to ${other.name} · ${shortAddress(other.address)}` : undefined}
            aria-label={other ? `Trading from ${active.name}. Switch to ${other.name}` : `Trading from ${active.name}`}
          >
            {active.logo && <img className="pf-wallet-logo" src={active.logo} alt="" />}
            {active.name} · {shortAddress(active.address)}
            {other && <ArrowLeftRight size={10} className="tw-swap-icon" />}
          </button>
          {active.kind === "added" && active.connector && (
            <button className="pf-wallet-x" aria-label={`Remove ${active.address}`} onClick={() => disconnect({ connector: active.connector! })}>
              <X size={11} />
            </button>
          )}
        </span>
      )}
      {!hasAdded && (
        <button className="pf-add" onClick={() => setAdding(true)}>
          <Plus size={12} /> {active ? "Add" : "Add wallet"}
        </button>
      )}
      <AddWalletModal open={adding} onClose={() => setAdding(false)} />
    </span>
  );
}
