-- automation_list()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.automation_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare result jsonb;
begin
  if coalesce(auth.role(),'') is distinct from 'service_role'
     and not (is_admin() or coalesce(current_app_role(),'') in ('admin','va','agent')) then
    raise exception 'Not authorized';
  end if;

  select coalesce(jsonb_agg(row_to_json(x) order by x.display_order), '[]'::jsonb)
  into result
  from (
    select a.key, a.display_name, a.description, a.category, a.display_order,
           a.cron_jobid,
           coalesce(j.active, false) as enabled,
           j.schedule,
           (j.jobid is not null) as exists
    from automation_settings a
    left join cron.job j on j.jobid = a.cron_jobid
  ) x;

  return result;
end;
$function$;
