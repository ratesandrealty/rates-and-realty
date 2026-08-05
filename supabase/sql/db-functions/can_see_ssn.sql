-- can_see_ssn()
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.can_see_ssn()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
  select public.current_app_role() = 'admin'
      or coalesce((select allowed from public.role_visibility
                   where role = public.current_app_role() and capability = 'ssn'), false);
$function$;
