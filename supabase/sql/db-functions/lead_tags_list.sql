-- lead_tags_list()
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.lead_tags_list()
 RETURNS TABLE(id uuid, name text, color text, usage_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select t.id, t.name, t.color, count(ct.contact_id)
  from tags t left join contact_tags ct on ct.tag_id = t.id
  group by t.id, t.name, t.color order by t.name;
$function$;
