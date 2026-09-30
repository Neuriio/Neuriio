-- Top 25 re-ranked every minute (was every 30 min; user, 2026-09-30). The list order still holds still between scans.
select cron.alter_job((select jobid from cron.job where jobname = 'neuriio-top-tokens'), schedule := '* * * * *');
