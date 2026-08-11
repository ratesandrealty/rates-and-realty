-- partner_activity_delete(p_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.partner_activity_delete(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_rows int;
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not public.is_admin() then raise exception 'admin only'; end if;
  delete from activity_events where id = p_id and partner_id is not null;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$function$;
