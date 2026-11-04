// Referral codes: what's shared by the `referral` function and its tests. The Verify message must match app/src/lib/referral.ts word for
// word (a test checks), or every signature fails.

export const normalizeCode = (s: string) => s.trim().toUpperCase();
export const isCode = (s: string) => /^[A-Z0-9_]{3,20}$/.test(s);

/** What an outside wallet signs. Names the account it joins, so a signature can't be reused for another one. */
export const verifyMessage = (code: string, account: string, wallet: string) =>
  `Neuriio referral\n\nI own ${wallet} and want its trades counted for referral code ${code} on the Neuriio account ${account}.\n\nThis signature is free and moves no funds.`;
