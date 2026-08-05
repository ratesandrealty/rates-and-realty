-- automation_toggle(p_key text, p_enabled boolean)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.automation_toggle(p_key text, p_enabled boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_jobid bigint; v_name text;
begin
  if auth.role() = 'authenticated' and not is_admin() then
    raise exception 'Only admins can change automations';
  end if;

  select cron_jobid, display_name into v_jobid, v_name
  from automation_settings where key = p_key;

  if v_jobid is null then
    raise exception 'Unknown automation: %', p_key;
  end if;

  -- Flip the pg_cron job's active flag
  perform cron.alter_job(job_id => v_jobid, active => p_enabled);

  update automation_settings
    set updated_at = now(), updated_by = auth.uid()
    where key = p_key;

  return jsonb_build_object('key', p_key, 'display_name', v_name, 'enabled', p_enabled, 'jobid', v_jobid);
end;
$function$;
