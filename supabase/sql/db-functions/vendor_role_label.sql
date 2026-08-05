-- vendor_role_label(p_role text)
-- language: sql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.vendor_role_label(p_role text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(
    (select label from public.vendor_role_labels where role_key = p_role),
    initcap(replace(coalesce(p_role,''),'_',' '))
  );
$function$;
