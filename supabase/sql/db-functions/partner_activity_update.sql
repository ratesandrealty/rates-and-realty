-- partner_activity_update(p_id uuid, p_note text, p_direction text, p_duration integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.partner_activity_update(p_id uuid, p_note text DEFAULT NULL::text, p_direction text DEFAULT NULL::text, p_duration integer DEFAULT NULL::integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_rows int;
begin
  if auth.role()='authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
  update activity_events
     set description = coalesce(p_note, description),
         direction = coalesce(nullif(p_direction,''), direction),
         duration_seconds = coalesce(p_duration, duration_seconds),
         updated_at = now()
   where id = p_id and partner_id is not null;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$function$;
