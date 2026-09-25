// JSON over HTTP between the app and the sponsor. bigint fields travel as decimal strings.
const big = (v) => (v === undefined || v === null ? v : BigInt(v));
const map = (o, f, keys) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, keys.includes(k) ? f(v) : v])) : o);

const ORDER = ["amountIn", "minUsdcOut", "deadline", "nonce"];
const SESSION = ["validUntil", "maxPerBuy", "maxPerDay", "nonce"];
const AUTH = ["chainId", "nonce"];

export const toWire = (p) => JSON.stringify(p, (_, v) => (typeof v === "bigint" ? v.toString() : v));

export const fromWire = (text) => {
  const p = JSON.parse(text);
  return {
    ...p,
    order: map(p.order, big, ORDER),
    session: p.session && { ...map(p.session, big, SESSION), epoch: Number(p.session.epoch) },
    authorization: p.authorization && { ...map(p.authorization, Number, AUTH), v: undefined }, // yParity is enough
  };
};

/** Browser/app client for the sponsor service. */
export class SponsorClient {
  constructor(url) {
    this.url = url.replace(/\/$/, "");
  }

  async _post(path, payload) {
    const res = await fetch(`${this.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: toWire(payload) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `sponsor ${res.status}`);
    return body;
  }

  setup(request) {
    return this._post("/setup", request);
  }

  async buy(signed) {
    const r = await this._post("/buy", signed);
    return { ...r, depositId: BigInt(r.depositId) };
  }
}
