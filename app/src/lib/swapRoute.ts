// The /swap page's routes (user, 2026-11-08: HYPE, USDC and KNTQ only, no fee of ours for now): which Uniswap v4 pools a swap
// goes through and the Universal Router call for it. Pure (only viem), so a mainnet-fork script can test the exact calls.
// Pools picked 2026-11-08 from every Initialize on Elysium's PoolManager, by what they actually quote:
//  - HYPE/USDC: native HYPE / USDC, 1% fee, tickSpacing 200, no hook (the deepest of 14; $10 -> 0.1359 HYPE)
//  - KNTQ/USDC: USDC / KNTQ, 2% fee, tickSpacing 200, no hook (thin: $10 quotes fine, $100 doesn't)
//  - HYPE/KNTQ: its two pools quote nothing, so HYPE <-> KNTQ goes through USDC (two hops in one transaction)
import { encodeAbiParameters, encodePacked, zeroAddress, type Address } from "viem";

export const NATIVE = zeroAddress; // native HYPE, as Uniswap v4 names it
export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
export type Hop = { key: PoolKey; zeroForOne: boolean; from: Address; to: Address };

const lc = (a: string) => a.toLowerCase();
const keyOf = (a: Address, b: Address, fee: number, tickSpacing: number): PoolKey => {
  const [currency0, currency1] = lc(a) < lc(b) ? [a, b] : [b, a];
  return { currency0, currency1, fee, tickSpacing, hooks: zeroAddress };
};

/** The hops from `pay` to `receive` (NATIVE for HYPE), or null if there's no route. */
export function routeOf(pay: Address, receive: Address, t: { usdc: Address; kntq: Address }): Hop[] | null {
  const pools = [keyOf(NATIVE, t.usdc, 10_000, 200), keyOf(t.usdc, t.kntq, 20_000, 200)];
  const hop = (from: Address, to: Address): Hop | null => {
    const key = pools.find((k) => [lc(k.currency0), lc(k.currency1)].sort().join() === [lc(from), lc(to)].sort().join());
    return key ? { key, zeroForOne: lc(key.currency0) === lc(from), from, to } : null;
  };
  if (lc(pay) === lc(receive)) return null;
  const direct = hop(pay, receive);
  if (direct) return [direct];
  const a = hop(pay, t.usdc);
  const b = hop(t.usdc, receive);
  return a && b ? [a, b] : null;
}

const poolKeyType = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;
const singleType = [
  {
    type: "tuple",
    components: [
      { name: "poolKey", type: "tuple", components: poolKeyType },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "minHopPriceX36", type: "uint256" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

/** One V4_SWAP for Universal Router 2.2.0 (the same encoding as lib/trade.ts): a SWAP_EXACT_IN_SINGLE per hop, then
 *  SETTLE_ALL (pay `amountIn` of the first hop's input) and TAKE_ALL (at least `minOut` of the last hop's output). A second
 *  hop's amountIn is 0 = OPEN_DELTA: everything the first hop produced. A native HYPE input is paid as the call's value. */
export function swapCall(hops: Hop[], amountIn: bigint, minOut: bigint) {
  const params = hops.map((h, i) =>
    encodeAbiParameters(singleType, [
      {
        poolKey: h.key,
        zeroForOne: h.zeroForOne,
        amountIn: i === 0 ? amountIn : 0n,
        amountOutMinimum: i === hops.length - 1 ? minOut : 0n,
        minHopPriceX36: 0n,
        hookData: "0x",
      },
    ]),
  );
  const pay = hops[0].from;
  const get = hops[hops.length - 1].to;
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [pay, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [get, minOut]);
  const actionTypes = [...hops.map(() => "uint8" as const), "uint8" as const, "uint8" as const];
  const actions = encodePacked(actionTypes, [...hops.map(() => 0x06), 0x0c, 0x0f]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [...params, settle, take]]);
  return { commands: "0x10" as const, inputs: [input], value: pay === NATIVE ? amountIn : 0n };
}
