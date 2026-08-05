-- contact_recent_notes(p_contact_id uuid, p_limit integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.contact_recent_notes(p_contact_id uuid, p_limit integer DEFAULT 5)
 RETURNS TABLE(id uuid, note_text text, author_display text, source text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.role() = 'authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
  return query
  select cn.id, cn.note_text, cn.author_display, cn.source, cn.created_at
  from contact_notes cn
  where cn.contact_id = p_contact_id
  order by cn.created_at desc
  limit greatest(1, least(coalesce(p_limit,5), 20));
end;
$function$;
