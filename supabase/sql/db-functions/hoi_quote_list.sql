-- hoi_quote_list(p_contact_id uuid)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.hoi_quote_list(p_contact_id uuid)
 RETURNS SETOF hoi_quote_requests
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select * from public.hoi_quote_requests where contact_id = p_contact_id order by sent_at desc nulls last, created_at desc;
$function$;
