-- fire_cold_lead_check()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.fire_cold_lead_check()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r record;
  v_deploy_date timestamptz := '2026-05-04 04:30:00+00'::timestamptz;
  v_enabled boolean;
begin
  select enabled into v_enabled from clickup_automation_config where trigger_type='cold_lead_3d';
  if not coalesce(v_enabled, false) then return; end if;   -- toggle OFF → do nothing
  for r in
    select c.id, c.first_name, c.last_name
    from contacts c
    where c.created_at > v_deploy_date
      and c.created_at < now() - interval '3 days'
      and coalesce(c.pipeline_status,'') not in ('Closed','Lost')
      and not exists (
        select 1 from activity_events ae
        where ae.contact_id = c.id and ae.direction='outbound'
          and ae.created_at > now() - interval '3 days'
      )
  loop
    perform fire_clickup_automation('cold_lead_3d', r.id, null, '{}'::jsonb);
  end loop;
end; $function$;
