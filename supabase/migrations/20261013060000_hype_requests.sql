-- Testnet HYPE requests: a logged-in user asks for testnet HYPE from the header button; the request shows up in the
-- admins' notifications (app_config.hype_admins: comma-separated X user IDs) with the wallet to send to, and the admin
-- marks it sent (or dismisses it). One open request per user; a new one is allowed 24 h after the last was sent.
-- Written and read only by the `ftf` Edge Function (service role): no policies.

create table public.hype_requests (
  id bigint generated always as identity primary key,
  x_user_id text not null references public.users (x_user_id),
  wallet text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'dismissed')),
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create unique index hype_requests_one_pending on public.hype_requests (x_user_id) where status = 'pending';
create index hype_requests_user on public.hype_requests (x_user_id, created_at desc);
alter table public.hype_requests enable row level security;

insert into public.app_config (key, value) values ('hype_admins', '338648879') -- @von_hl
on conflict (key) do nothing;
