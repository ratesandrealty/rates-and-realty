-- add_task_note(p_task_id uuid, p_note text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.add_task_note(p_task_id uuid, p_note text)
 RETURNS task_activity
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_row public.task_activity;
  v_email text;
  v_task public.tasks%rowtype;
  v_actor uuid := auth.uid();
  v_is_va boolean := coalesce(current_app_role(),'') in ('va','agent');
begin
  if p_task_id is null or nullif(trim(coalesce(p_note,'')),'') is null then
    raise exception 'task and note required';
  end if;
  select * into v_task from public.tasks where id = p_task_id;
  if v_task.id is null then raise exception 'task not found'; end if;
  if not (is_admin()
          or v_task.assigned_to = v_actor
          or (v_task.contact_id is not null and is_lead_shared_with_me(v_task.contact_id))) then
    raise exception 'not authorized for this task';
  end if;

  select email into v_email from auth.users where id = v_actor;

  insert into public.task_activity(task_id, kind, note, actor_user_id, actor_display, created_at)
  values (p_task_id, 'note', trim(p_note), v_actor, coalesce(v_email,'Staff'), now())
  returning * into v_row;

  -- Recipients: anyone @mentioned (match on email local-part) + all admins when a VA/agent writes.
  insert into public.app_notifications(recipient_user_id, actor_user_id, actor_display, kind, preview,
                                       contact_id, source_kind, source_id, is_read, created_at)
  select distinct u.id, v_actor, coalesce(v_email,'Staff'), 'task_note', left(trim(p_note),200),
         v_task.contact_id, 'task', p_task_id, false, now()
  from public.auth_user_roles ar
  join auth.users u on u.id = ar.user_id
  where u.id <> v_actor
    and ar.role in ('admin','va','loa','agent')
    and (
      p_note ilike ('%@' || split_part(u.email,'@',1) || '%')
      or (v_is_va and ar.role = 'admin')
    );

  return v_row;
end; $function$;
