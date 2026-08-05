-- contact_tags_get(p_contact_id uuid)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.contact_tags_get(p_contact_id uuid)
 RETURNS TABLE(id uuid, name text, color text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select t.id, t.name, t.color from contact_tags ct join tags t on t.id=ct.tag_id
  where ct.contact_id = p_contact_id order by t.name;
$function$;
