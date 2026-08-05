-- scrub_ssn_xml(p_xml text)
-- language: sql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.scrub_ssn_xml(p_xml text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when p_xml is null then null
    else regexp_replace(p_xml,
      '(<TaxpayerIdentifierValue>)[0-9]{9}(</TaxpayerIdentifierValue>)', '\1\2', 'g')
  end;
$function$;
