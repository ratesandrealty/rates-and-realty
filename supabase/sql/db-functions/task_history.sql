-- task_history(p_task_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.task_history(p_task_id uuid)
 RETURNS TABLE(id uuid, kind text, note text, meta jsonb, actor_display text, actor_user_id uuid, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role()='authenticated' and not (is_admin() or coalesce(current_app_role(),'') in ('va','agent')) then
    raise exception 'not authorized';
  end if;
  return query
  select a.id, a.kind, a.note, a.meta, a.actor_display, a.actor_user_id, a.created_at
  from public.task_activity a where a.task_id = p_task_id order by a.created_at asc;
end; $function$;
