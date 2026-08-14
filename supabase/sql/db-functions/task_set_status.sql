-- task_set_status(p_id uuid, p_status text)
-- language: plpgsql
-- Captured from production 2026-08-14.

CREATE OR REPLACE FUNCTION public.task_set_status(p_id uuid, p_status text)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_row public.tasks; v_task public.tasks;
  v_is_admin boolean := is_admin() or coalesce(auth.role(),'') = 'service_role';
  v_role text := coalesce(current_app_role(),'');
  v_uid uuid := auth.uid();
  v_status text := lower(nullif(trim(coalesce(p_status,'')),''));
begin
  if not (v_is_admin or v_role in ('va','agent','loa','staff')) then
    raise exception 'staff only';
  end if;
  if v_status is null or v_status not in ('open','pending','question','completed','cancelled') then
    raise exception 'status must be one of open, pending, question, completed, cancelled';
  end if;

  select * into v_task from tasks where id = p_id;
  if v_task.id is null then raise exception 'task not found'; end if;
  if not (v_is_admin
          or v_task.assigned_to = v_uid
          or (v_task.contact_id is not null and is_lead_shared_with_me(v_task.contact_id))) then
    raise exception 'not authorized for this task';
  end if;

  update tasks set
    status = v_status,
    completed_at     = case when v_status = 'completed' then coalesce(tasks.completed_at, now()) else null end,
    completed_by     = case when v_status = 'completed' then coalesce(tasks.completed_by, v_uid) else null end,
    completed_source = case when v_status = 'completed' then coalesce(tasks.completed_source, 'user') else null end,
    updated_at = now()
  where tasks.id = p_id
  returning * into v_row;

  perform _task_clickup_sync(v_row.id);
  return v_row;
end; $function$;
