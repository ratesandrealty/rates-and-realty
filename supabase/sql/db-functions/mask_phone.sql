-- mask_phone(p text)
-- language: sql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.mask_phone(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
    when p is null then null
    when length(regexp_replace(p,'\D','','g')) < 2 then '•••'
    else '(•••) •••-••'||right(regexp_replace(p,'\D','','g'),2)
  end;
$function$;
