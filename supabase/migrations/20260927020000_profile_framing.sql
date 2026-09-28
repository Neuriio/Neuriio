-- "Thesis" -> "profile": a creator's profile says who they are + links to their work (about, links). Tokens are
-- memes, not investments; nothing here promises value. The on-chain field is now `profileHash`.

alter table public.theses rename to creator_profiles;
alter policy "theses are public" on public.creator_profiles rename to "creator profiles are public";
alter table public.creator_profiles rename constraint theses_pkey to creator_profiles_pkey;
alter table public.creator_profiles rename constraint theses_x_user_id_fkey to creator_profiles_x_user_id_fkey;

alter table public.tokens rename column thesis_hash to profile_hash;
alter table public.launch_passes rename column thesis_hash to profile_hash;
alter table public.launch_passes rename constraint launch_passes_thesis_hash_fkey to launch_passes_profile_hash_fkey;

-- The public user card view was called `profiles`; rename it so it isn't confused with creator profiles.
alter view public.profiles rename to user_cards;
