-- contact_tag_add(p_contact_id uuid, p_name text, p_color text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.contact_tag_add(p_contact_id uuid, p_name text, p_color text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_tag uuid;
begin
  if auth.uid() is null then raise exception 'must be signed in'; end if;
  v_tag := public.lead_tag_create(p_name, p_color);
  insert into contact_tags(contact_id, tag_id) values (p_contact_id, v_tag)
  on conflict (contact_id, tag_id) do nothing;
  return v_tag;
end;
$function$;
