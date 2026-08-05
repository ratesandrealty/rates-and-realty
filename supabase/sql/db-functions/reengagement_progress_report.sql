-- reengagement_progress_report()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.reengagement_progress_report()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare result jsonb;
begin
  if auth.role() = 'authenticated' and not (is_admin() or coalesce(current_app_role(),'') in ('admin','va','agent')) then
    raise exception 'Not authorized';
  end if;

  with
  email_cohort as (
    select c.id, c.pipeline_status from contacts c where 'reengage-2026-email' = any(c.tags)
  ),
  call_cohort as (
    select c.id, c.pipeline_status from contacts c where 'reengage-2026-call' = any(c.tags)
  ),
  email_act as (
    select e.contact_id,
           bool_or(e.sent_at is not null or e.status in ('sent','delivered','opened')) as was_sent,
           bool_or(coalesce(e.open_count,0) > 0 or e.first_opened_at is not null)       as was_opened,
           bool_or(coalesce(e.click_count,0) > 0 or e.first_clicked_at is not null)     as was_clicked,
           bool_or(e.status in ('bounced','failed'))                                    as failed
    from email_log e
    where e.contact_id in (select id from email_cohort)
      and coalesce(e.direction,'outbound') <> 'inbound'
    group by e.contact_id
  ),
  call_act as (
    select cl.contact_id,
           count(*) as call_attempts,
           bool_or(cl.outcome in ('connected','answered','completed') or coalesce(cl.duration,0) >= 30) as connected,
           bool_or(cl.voicemail_drop is true or cl.outcome ilike '%voicemail%') as left_vm
    from calls_log cl
    where cl.contact_id in (select id from call_cohort)
      and coalesce(cl.direction,'outbound') <> 'inbound'
    group by cl.contact_id
  )
  select jsonb_build_object(
    'email', jsonb_build_object(
      'cohort_size',  (select count(*) from email_cohort),
      'still_new',    (select count(*) from email_cohort where pipeline_status='New Lead'),
      'progressed',   (select count(*) from email_cohort where pipeline_status is distinct from 'New Lead'),
      'contacted',    (select count(*) from email_act where was_sent),
      'opened',       (select count(*) from email_act where was_opened),
      'clicked',      (select count(*) from email_act where was_clicked),
      'send_failed',  (select count(*) from email_act where failed),
      'open_rate_pct',  (select round(100.0*count(*) filter (where was_opened)/nullif(count(*) filter (where was_sent),0),1) from email_act),
      'click_rate_pct', (select round(100.0*count(*) filter (where was_clicked)/nullif(count(*) filter (where was_sent),0),1) from email_act)
    ),
    'call', jsonb_build_object(
      'cohort_size',  (select count(*) from call_cohort),
      'still_new',    (select count(*) from call_cohort where pipeline_status='New Lead'),
      'progressed',   (select count(*) from call_cohort where pipeline_status is distinct from 'New Lead'),
      'dialed',       (select count(*) from call_act),
      'total_attempts',(select coalesce(sum(call_attempts),0) from call_act),
      'connected',    (select count(*) from call_act where connected),
      'voicemail',    (select count(*) from call_act where left_vm),
      'not_yet_called',(select count(*) from call_cohort) - (select count(*) from call_act),
      'connect_rate_pct',(select round(100.0*count(*) filter (where connected)/nullif(count(*),0),1) from call_act)
    ),
    'note', 'Engagement is measured from logged emails (sends/opens/clicks) and calls (attempts/connects/voicemails) to the tagged cohorts. "Progressed" = leads no longer in New Lead. Note: hard/soft bounces are NOT tracked (no delivery webhook wired), so "Send failed" reflects only send-time errors, not deliverability — watch open rate as the practical health signal.',
    'generated_at', now()
  ) into result;

  return result;
end;
$function$;
