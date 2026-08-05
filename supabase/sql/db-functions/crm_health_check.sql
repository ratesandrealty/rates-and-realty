-- crm_health_check()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.crm_health_check()
 RETURNS TABLE(severity text, area text, check_name text, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_fail int; v_warn int; v_cnt int;
begin
  -- 1) Critical DB objects that automations / locks depend on
  return query
  with expected(kind, obj, present) as (
    values
      ('trigger','contacts.guard_loan_terms_contacts',      (select count(*)>0 from pg_trigger where tgrelid='public.contacts'::regclass and tgname='guard_loan_terms_contacts')),
      ('trigger','contacts.fire_timeline_automation_trg',   (select count(*)>0 from pg_trigger where tgrelid='public.contacts'::regclass and tgname='fire_timeline_automation_trg')),
      ('trigger','mortgage_applications.guard_loan_terms_ma',(select count(*)>0 from pg_trigger where tgrelid='public.mortgage_applications'::regclass and tgname='guard_loan_terms_ma')),
      ('trigger','leads.leads_update_trigger',              (select count(*)>0 from pg_trigger where tgrelid='public.leads'::regclass and tgname='leads_update_trigger')),
      ('function','fire_clickup_automation',                (select count(*)>0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='fire_clickup_automation')),
      ('function','fire_timeline_automation',               (select count(*)>0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='fire_timeline_automation')),
      ('function','fire_rate_lock_reminders',               (select count(*)>0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='fire_rate_lock_reminders')),
      ('cron','clickup-rate-lock-reminders',                (select count(*)>0 from cron.job where jobname='clickup-rate-lock-reminders' and active)),
      ('cron','clickup-cold-lead-check',                    (select count(*)>0 from cron.job where jobname='clickup-cold-lead-check' and active))
  )
  select case when present then 'ok' else 'fail' end,
         'objects', kind||': '||obj,
         case when present then 'present' else 'MISSING — depends on this' end
  from expected;

  -- 2) Cron jobs: most-recent run status
  return query
  select case when e.status='failed' then 'fail' else 'ok' end,
         'cron', j.jobname,
         'last run '||to_char(e.start_time,'MM-DD HH24:MI')||' → '||e.status||coalesce(' · '||left(e.return_message,140),'')
  from cron.job j
  join lateral (
    select status, return_message, start_time
    from cron.job_run_details d where d.jobid=j.jobid
    order by start_time desc limit 1
  ) e on true
  where j.active and (e.status='failed' or e.start_time > now()-interval '2 days');

  -- 3) Outbound HTTP (pg_net), last 60 min — separate real failures from benign slow-call timeouts.
  --    hard failure = an error status (>=400), or a connection/DNS error that is NOT a plain timeout.
  --    timeout      = pg_net stopped waiting; async fire-and-forget self-calls usually still complete,
  --                   so treat as a soft signal (warn only if sustained).
  select count(*) filter (
           where status_code >= 400
              or (status_code is null and not timed_out
                  and coalesce(error_msg,'') not ilike '%Timeout of%')
         ),
         count(*) filter (
           where timed_out or coalesce(error_msg,'') ilike '%Timeout of%'
         )
    into v_fail, v_cnt
  from net._http_response
  where created > now() - interval '60 minutes';

  return query select
    case when v_fail > 0 then 'fail'
         when v_cnt >= 10 then 'warn'
         else 'ok' end,
    'outbound_http', 'failed edge/API calls (recent)',
    case
      when v_fail > 0 then
        v_fail::text||' failed call(s) in last hour · latest: '||coalesce((
          select left(coalesce(error_msg,status_code::text),120) from net._http_response
          where created>now()-interval '60 minutes'
            and (status_code>=400 or (status_code is null and not timed_out and coalesce(error_msg,'') not ilike '%Timeout of%'))
          order by created desc limit 1),'')
      when v_cnt > 0 then
        'no failed calls in last hour · '||v_cnt::text||' slow-call timeout(s) — calls completed, pg_net just stopped waiting'
      else 'no failed outbound calls in last hour'
    end;

  -- 4) ClickUp automations: created vs failed (7d)
  select count(*) filter (where status='failed') into v_fail from clickup_automation_log where fired_at > now()-interval '7 days';
  select count(*) filter (where status='created') into v_cnt from clickup_automation_log where fired_at > now()-interval '7 days';
  return query select
    case when v_fail=0 then 'ok' else 'fail' end,
    'automations', 'ClickUp task creation (7d)',
    v_cnt::text||' created, '||v_fail::text||' failed'||
    case when v_fail>0 then ' · '||coalesce((select string_agg(distinct trigger_type,', ') from clickup_automation_log where fired_at>now()-interval '7 days' and status='failed'),'') else '' end;

  -- 5) Automation rules enabled
  select count(*) filter (where enabled) into v_cnt from clickup_automation_config;
  select count(*) into v_fail from clickup_automation_config;
  return query select
    case when v_cnt=0 then 'warn' else 'ok' end,
    'automations', 'enabled rules',
    v_cnt::text||' of '||v_fail::text||' automation rules enabled';

  -- 6) Guideline library freshness
  return query
  select case when max(gdrive_synced_at) is null then 'warn'
              when max(gdrive_synced_at) < now()-interval '14 days' then 'warn' else 'ok' end,
         'guidelines', 'guideline sync',
         coalesce('last sync '||to_char(max(gdrive_synced_at),'YYYY-MM-DD'),'never synced')||' · '||count(*)::text||' active docs'
  from lender_guidelines where is_active;

  return;
end;
$function$;
