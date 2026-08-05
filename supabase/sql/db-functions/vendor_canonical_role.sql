-- vendor_canonical_role(p_role text)
-- language: sql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.vendor_canonical_role(p_role text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case lower(trim(coalesce(p_role,'')))
    when 'title' then 'title_officer'
    when 'escrow' then 'escrow_officer'
    when 'hoi' then 'hoi_agent'
    when 'appraiser' then 'appraisal'
    else nullif(lower(trim(p_role)),'')
  end;
$function$;
