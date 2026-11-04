-- Launch tiles (user, 2026-11-01): Meme Account and Founders. Off-chain only: the launcher's Category enum is frozen, so they go on-chain
-- as Creator and Builder (chainCategory in supabase/functions/_shared/launchPass.ts). FTF drafts store them in this type.
alter type public.creator_category add value if not exists 'meme_account';
alter type public.creator_category add value if not exists 'founders';
