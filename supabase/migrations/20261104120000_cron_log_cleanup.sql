-- pg_cron keeps a row for every run of every job forever: by 2026-11-04 that was ~100k rows / 27 MB, more than half the
-- database (neuriio-top-tokens runs every minute). Keep 7 days of run history; clear the rest daily at 04:41 UTC.
select cron.schedule(
  'neuriio-cron-log-cleanup',
  '41 4 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$
);

-- and clear the backlog now
delete from cron.job_run_details where end_time < now() - interval '7 days';
