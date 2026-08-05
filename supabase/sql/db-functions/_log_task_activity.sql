-- _log_task_activity(p_task_id uuid, p_kind text, p_note text, p_meta jsonb)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public._log_task_activity(p_task_id uuid, p_kind text, p_note text DEFAULT NULL::text, p_meta jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  insert into public.task_activity(task_id, actor_user_id, actor_display, kind, note, meta)
  values (p_task_id, auth.uid(), current_actor_display(), p_kind, p_note, p_meta);
$function$;
