// HyperCore perps adapter. Positions are read for the vault's master account; orders are
// signed by a trade-only API agent (it cannot withdraw), mirroring the ElysiumCoreWriter model.
// When ElysiumCoreWriter ships, a sibling adapter emits on-chain intents instead.
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";

export class HyperliquidExchange {
  /**
   * @param {object} o
   * @param {string} o.coin         perp name, e.g. "HYPE"
   * @param {string} o.account      master account whose position we hedge
   * @param {string} [o.agentKey]   API agent private key (omit for read-only / dry-run)
   * @param {boolean} [o.testnet]
   */
  constructor({ coin, account, agentKey, testnet = false }) {
    this.coin = coin;
    this.account = account;
    const transport = new HttpTransport({ isTestnet: testnet });
    this.info = new InfoClient({ transport });
    this.exchange = agentKey ? new ExchangeClient({ transport, wallet: privateKeyToAccount(agentKey) }) : null;
  }

  async meta() {
    if (this._meta) return this._meta;
    const { universe } = await this.info.meta();
    const asset = universe.findIndex((u) => u.name === this.coin);
    if (asset < 0) throw new Error(`perp ${this.coin} not found`);
    this._meta = { asset, szDecimals: universe[asset].szDecimals };
    return this._meta;
  }

  async getMid() {
    const mids = await this.info.allMids();
    const mid = Number(mids[this.coin]);
    if (!(mid > 0)) throw new Error(`no mid for ${this.coin}`);
    return mid;
  }

  async getPosition() {
    const state = await this.info.clearinghouseState({ user: this.account });
    const p = state.assetPositions.find((ap) => ap.position.coin === this.coin);
    return p ? Number(p.position.szi) : 0;
  }

  async placeIoc({ isBuy, sz, limitPx }) {
    if (!this.exchange) throw new Error("read-only: no agent key configured");
    const { asset } = await this.meta();
    const res = await this.exchange.order({
      orders: [{ a: asset, b: isBuy, p: limitPx, s: sz, r: false, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
    });
    const st = res.response.data.statuses[0];
    if (st.filled) return { filledSz: Number(st.filled.totalSz), avgPx: Number(st.filled.avgPx) };
    return { filledSz: 0, avgPx: 0, error: st.error };
  }
}
