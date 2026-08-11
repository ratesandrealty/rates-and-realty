-- vendor_email_is_complete(p text)
-- language: sql
-- Captured from production 2026-08-11.

CREATE OR REPLACE FUNCTION public.vendor_email_is_complete(p text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(lower(trim(p)) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$', false);
$function$;
