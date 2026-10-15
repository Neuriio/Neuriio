-- Which passcode (APP_PASSCODE on the web service) each user came in with: the passcode page leaves the code in a
-- `neuriio_code` cookie, the app sends it to `register` on the user's X login, and the first one seen is kept.
-- Counts per code: select code, count(*), string_agg(u.x_handle, ', ') from access_code_users a
--   join users u using (x_user_id) group by code;
-- Holds the codes themselves, so it's read and written only by the `register` Edge Function (service role): no policies.

create table public.access_code_users (
  x_user_id text primary key references public.users (x_user_id),
  code text not null check (char_length(code) between 1 and 64),
  created_at timestamptz not null default now()
);
alter table public.access_code_users enable row level security;
