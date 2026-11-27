-- Delivery-only fallback schedule (Issue #26). NOT applied by CI or migrations: review, then run manually
-- in the Supabase SQL Editor ONLY AFTER the route (?mode=deliver) is deployed to Production.
-- Uses the existing Vault secret `contentpilot_sports_news_cron_bearer` (same value as Vercel CRON_SECRET).
-- No plaintext secret appears here. No RSS, no LLM: the route only sends already-approved deliveries.

-- ===== SETUP (idempotent: cron.schedule with an existing job name updates that job) =====
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule('contentpilot-sports-delivery', '* * * * *', $job$
  select net.http_post(
    url := 'https://contentpilot-social.vercel.app/api/cron/sports-news',
    params := '{"mode":"deliver","source":"supabase-cron"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || s.decrypted_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 70000
  )
  from vault.decrypted_secrets s
  where s.name = 'contentpilot_sports_news_cron_bearer'
    -- cheap queue-due check: no HTTP call at all when nothing is sendable (same predicate as claim_social_deliveries)
    and exists (
      select 1
      from public.publish_deliveries q
      join public.publishing_destinations d on d.id = q.destination_id
      where q.status in ('queued', 'failed') and q.next_attempt_at <= now()
        and q.attempt_count < 4 and d.status = 'active' and d.kind <> 'internal'
    );
$job$);

-- ===== VERIFY (read-only; sends nothing) =====
-- select jobid, jobname, schedule, active from cron.job where jobname = 'contentpilot-sports-delivery';
-- select status, return_message, start_time from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'contentpilot-sports-delivery')
--   order by start_time desc limit 10;
-- select status_code, created from net._http_response order by created desc limit 10;
-- select status, count(*) from public.publish_deliveries group by status;   -- queued should drain to 0

-- ===== ROLLBACK (stops the schedule; leaves the 2-hourly sports-news job and all data untouched) =====
-- select cron.unschedule('contentpilot-sports-delivery');
