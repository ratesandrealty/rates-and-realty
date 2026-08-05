-- va_task_completed_history(p_limit integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_task_completed_history(p_limit integer DEFAULT 50)
 RETURNS TABLE(task_id uuid, title text, completed_by text, completed_at timestamp with time zone, contact_id uuid, contact_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role()='authenticated' and not (is_admin() or coalesce(current_app_role(),'') in ('va','agent')) then
    raise exception 'not authorized';
  end if;
  return query
  select a.task_id, t.title, a.actor_display, a.created_at, t.contact_id,
         nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'')
  from public.task_activity a
  join public.tasks t on t.id = a.task_id
  left join public.contacts c on c.id = t.contact_id
  where a.kind = 'completed'
  order by a.created_at desc
  limit greatest(1, least(coalesce(p_limit,50), 200));
end; $function$;
