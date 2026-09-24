// Exact USDC conversions between on-chain base units (6 dp bigint) and HyperCore decimal strings.
export const USDC_DECIMALS = 6;

export function usdcToStr(units) {
  const s = units.toString().padStart(USDC_DECIMALS + 1, "0");
  const int = s.slice(0, -USDC_DECIMALS);
  const frac = s.slice(-USDC_DECIMALS).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

export function strToUsdc(str) {
  const [int, frac = ""] = str.split(".");
  if (frac.length > USDC_DECIMALS && /[1-9]/.test(frac.slice(USDC_DECIMALS))) throw new Error(`sub-cent precision: ${str}`);
  return BigInt(int) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.slice(0, USDC_DECIMALS).padEnd(USDC_DECIMALS, "0"));
}
