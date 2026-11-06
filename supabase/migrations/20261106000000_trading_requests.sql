-- APPLIED 2026-11-06 (by the user in the SQL editor, so not in Supabase's migration list).
-- "Apply For Trading" (user, 2026-11-05): a coin launched elsewhere on Ascend isn't tradable through Neuriio; a logged-in user can
-- ask for it to be, and the request shows in the admins' notifications (app_config.trading_admins: comma-separated X user IDs;
-- starts with @von_hl, 338648879), who dismiss it once handled. One open request per user per coin.
-- Written and read only by the `ftf` Edge Function (service role): no policies.

create table public.trading_requests (
  id bigint generated always as identity primary key,
  x_user_id text not null references public.users (x_user_id),
  token text not null check (token ~ '^0x[0-9a-f]{40}$'), -- lower case
  status text not null default 'pending' check (status in ('pending', 'done')),
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create unique index trading_requests_one_pending on public.trading_requests (x_user_id, token) where status = 'pending';
create index trading_requests_pending on public.trading_requests (created_at desc) where status = 'pending';

alter table public.trading_requests enable row level security;
revoke all on public.trading_requests from anon, authenticated;

insert into public.app_config (key, value) values ('trading_admins', '338648879') on conflict (key) do nothing;
