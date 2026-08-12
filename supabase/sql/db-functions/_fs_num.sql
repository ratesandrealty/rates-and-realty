-- _fs_num(txt text)
-- language: sql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public._fs_num(txt text)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- parseCurrency() equivalent: "$700,000" -> 700000. Empty/garbage -> 0.
  select coalesce(nullif(regexp_replace(coalesce(txt,''), '[^0-9.]', '', 'g'), '')::numeric, 0);
$function$;
