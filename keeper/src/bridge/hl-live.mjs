// Live HyperCore USDC transfers for the relayer's inventory account.
// usdSend must be signed by the account's MAIN key (API agents can't move funds), so this key is
// hot: keep only a working balance on this account and top it up from cold storage.
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";

export class HlTransfers {
  constructor({ mainKey, testnet = false }) {
    const wallet = privateKeyToAccount(mainKey);
    const transport = new HttpTransport({ isTestnet: testnet });
    this.account = wallet.address;
    this.info = new InfoClient({ transport });
    this.exchange = new ExchangeClient({ transport, wallet });
  }

  /** Withdrawable USDC in the perps account (what usdSend spends from). */
  async balance() {
    const st = await this.info.clearinghouseState({ user: this.account });
    return st.withdrawable;
  }

  async send(to, amount) {
    const res = await this.exchange.usdSend({ destination: to, amount });
    if (res.status !== "ok") throw new Error(`usdSend failed: ${JSON.stringify(res)}`);
    // usdSend's response carries no hash; the relayer's ledger check attributes it later.
    return { hash: null };
  }

  /** USDC moves in/out of this account, normalised to { hash, time, from, to, usdc }. */
  async ledger(sinceMs) {
    const rows = await this.info.userNonFundingLedgerUpdates({ user: this.account, startTime: sinceMs });
    const out = [];
    for (const r of rows) {
      const d = r.delta;
      if (d.type === "internalTransfer") {
        out.push({ hash: r.hash, time: r.time, from: d.user.toLowerCase(), to: d.destination.toLowerCase(), usdc: d.usdc });
      } else if (d.type === "send" && d.token === "USDC" && d.destinationDex === "" && d.sourceDex === "") {
        out.push({ hash: r.hash, time: r.time, from: d.user.toLowerCase(), to: d.destination.toLowerCase(), usdc: d.amount });
      }
    }
    return out;
  }
}
