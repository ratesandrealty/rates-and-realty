-- recent_notes(p_limit integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.recent_notes(p_limit integer DEFAULT 30)
 RETURNS TABLE(note_id uuid, source text, note_text text, author_display text, contact_id uuid, contact_name text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  return query
  select x.note_id, x.source, x.note_text, x.author_display, x.contact_id, x.contact_name, x.created_at
  from (
    select cn.id as note_id, 'lead'::text as source, cn.note_text,
           coalesce(cn.author_display,'Staff') as author_display, cn.contact_id,
           nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as contact_name,
           cn.created_at
    from contact_notes cn left join contacts c on c.id = cn.contact_id
    union all
    select ta.id, 'task'::text, ta.note, coalesce(ta.actor_display,'Staff'), t.contact_id,
           nullif(trim(coalesce(c2.first_name,'')||' '||coalesce(c2.last_name,'')),''), ta.created_at
    from task_activity ta join tasks t on t.id = ta.task_id
    left join contacts c2 on c2.id = t.contact_id
    where ta.kind = 'note'
  ) x
  order by x.created_at desc
  limit greatest(1, least(coalesce(p_limit,30), 100));
end; $function$;
