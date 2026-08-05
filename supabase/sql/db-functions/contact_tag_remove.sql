-- contact_tag_remove(p_contact_id uuid, p_tag_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.contact_tag_remove(p_contact_id uuid, p_tag_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'must be signed in'; end if;
  delete from contact_tags where contact_id = p_contact_id and tag_id = p_tag_id;
end;
$function$;
