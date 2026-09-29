-- Live trades for charts: the keeper watcher (keeper/watcher.mjs) broadcasts every curve/pool trade the moment its
-- block appears, on PRIVATE Realtime channels "trades:<token address>" (and "trades:all"). Anyone may RECEIVE them;
-- there is no insert policy, so only the server's secret key (which bypasses RLS) can SEND. Public channels with the
-- same name are separate, so nobody can inject fake trades into what the app listens to.
create policy "anyone can receive live trades" on realtime.messages
  for select to anon, authenticated
  using (realtime.messages.extension = 'broadcast' and realtime.topic() like 'trades:%');
