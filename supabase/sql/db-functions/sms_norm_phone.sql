-- sms_norm_phone(p text)
-- language: sql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sms_norm_phone(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when length(d) = 10 then d
    when length(d) = 11 and left(d, 1) = '1' then right(d, 10)
    else d
  end
  from (
    select regexp_replace(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '^00', '') as d
  ) x
$function$;
