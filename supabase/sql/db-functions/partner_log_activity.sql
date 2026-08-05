-- partner_log_activity(p_partner_id uuid, p_type text, p_direction text, p_note text, p_duration integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.partner_log_activity(p_partner_id uuid, p_type text, p_direction text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_duration integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_id uuid; v_user uuid := auth.uid(); v_type text := lower(coalesce(p_type,'note'));
begin
  if auth.role() = 'authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
  if v_type not in ('call','sms','note','email') then v_type := 'note'; end if;
  insert into activity_events (id, partner_id, type, channel, direction, title, description, duration_seconds, created_by, created_at, status)
  values (gen_random_uuid(), p_partner_id, v_type, v_type, nullif(p_direction,''),
          initcap(v_type) || case when p_direction is not null and p_direction <> '' then ' (' || p_direction || ')' else '' end,
          nullif(p_note,''), p_duration, v_user, now(), 'logged')
  returning id into v_id;
  return v_id;
end;
$function$;
