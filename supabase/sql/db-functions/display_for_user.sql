-- display_for_user(p_uid uuid)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.display_for_user(p_uid uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(nullif(u.raw_user_meta_data->>'full_name',''),
                  initcap(replace(split_part(u.email::text,'@',1), '.', ' ')))
  from auth.users u where u.id = p_uid;
$function$;
