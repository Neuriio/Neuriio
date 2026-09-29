const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const usd = (n: number) => usdFmt.format(n);

/** Token amounts: more decimals for small numbers, fewer for big ones. */
export const amount = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : n >= 1 ? 4 : 6 });

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const SUB = "₀₁₂₃₄₅₆₇₈₉";
/** Tiny prices with the zero count as a subscript: 0.0000051234 -> "0.0₅5123" (4 significant digits). */
export function tinyPrice(n: number, prefix = "$") {
  if (!(n > 0)) return `${prefix}0`;
  if (n >= 0.01) return `${prefix}${n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 4 })}`;
  let zeros = -Math.floor(Math.log10(n)) - 1; // zeros right after the point: 0.00512 -> 2
  let digits = Math.round(n * 10 ** (zeros + 4));
  if (digits >= 10_000) {
    zeros -= 1; // rounding carried into the next digit (0.00099999 -> 0.001)
    digits = Math.round(digits / 10);
  }
  const sig = String(digits).replace(/0+$/, "");
  if (zeros < 4) return `${prefix}0.${"0".repeat(zeros)}${sig}`;
  const sub = String(zeros).split("").map((d) => SUB[Number(d)]).join("");
  return `${prefix}0.0${sub}${sig}`;
}

/** $1.2K · $34.5K · $1.23M */
export const compactUsd = (n: number) =>
  `$${n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: n >= 1_000 ? 1 : 2 })}`;
