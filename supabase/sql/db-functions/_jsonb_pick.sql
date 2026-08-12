-- _jsonb_pick(p_obj jsonb, p_keys text[])
-- language: sql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public._jsonb_pick(p_obj jsonb, p_keys text[])
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select coalesce(jsonb_object_agg(k, p_obj -> k), '{}'::jsonb)
  from unnest(p_keys) as k
  where p_obj ? k;
$function$;
