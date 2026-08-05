-- staff_lead_visible(p_status text, p_outcome text)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.staff_lead_visible(p_status text, p_outcome text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select current_app_role() is distinct from 'va'
     and coalesce(p_status,'') <> 'Closed'
     and coalesce(p_outcome,'') not in ('won','lost');
$function$;
