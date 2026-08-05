-- esign_lenders_list()
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.esign_lenders_list()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'name', name,
    'has_mortgagee_clause', (mortgagee_clause is not null and mortgagee_clause <> ''),
    'nmls', nmlsr_id
  ) order by name), '[]'::jsonb)
  from lenders where coalesce(is_active, true) = true;
$function$;
