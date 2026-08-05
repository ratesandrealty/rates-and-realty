-- task_note_add(p_task_id uuid, p_body text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.task_note_add(p_task_id uuid, p_body text)
 RETURNS task_activity
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.task_activity; v_contact uuid; v_actor text;
begin
  if auth.role()='authenticated' and not (is_admin() or coalesce(current_app_role(),'') in ('va','agent')) then
    raise exception 'not authorized';
  end if;
  if nullif(trim(coalesce(p_body,'')),'') is null then raise exception 'Note cannot be empty'; end if;
  v_actor := current_actor_display();
  insert into public.task_activity(task_id, actor_user_id, actor_display, kind, note)
  values (p_task_id, auth.uid(), v_actor, 'note', trim(p_body)) returning * into v_row;
  select contact_id into v_contact from public.tasks where id = p_task_id;
  perform app_notify_mentions('task_note', p_task_id, p_body, auth.uid(), v_actor, v_contact);
  return v_row;
end; $function$;
