-- crm_health_check_rpc()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.crm_health_check_rpc()
 RETURNS TABLE(severity text, area text, check_name text, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not coalesce(public.is_admin(), false) then
    raise exception 'crm_health_check is admin-only' using errcode = '42501';
  end if;
  return query
  select h.severity, h.area, h.check_name, h.detail
  from public.crm_health_check() h
  order by case h.severity when 'fail' then 0 when 'warn' then 1 else 2 end, h.area, h.check_name;
end;
$function$;
