/** A required Edge Function secret (throws at startup if it's missing). */
export const env = (k: string): string => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing secret ${k}`);
  return v;
};
