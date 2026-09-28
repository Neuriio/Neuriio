const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const usd = (n: number) => usdFmt.format(n);

/** Token amounts: more decimals for small numbers, fewer for big ones. */
export const amount = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : n >= 1 ? 4 : 6 });

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
