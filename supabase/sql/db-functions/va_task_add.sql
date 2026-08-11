-- va_task_add(p_title text, p_priority text, p_due_date timestamp without time zone, p_contact_id uuid, p_description text, p_assigned_to uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_task_add(p_title text, p_priority text DEFAULT 'normal'::text, p_due_date timestamp without time zone DEFAULT NULL::timestamp without time zone, p_contact_id uuid DEFAULT NULL::uuid, p_description text DEFAULT NULL::text, p_assigned_to uuid DEFAULT NULL::uuid)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row tasks;
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not (is_admin() or coalesce(current_app_role(),'') in ('va','agent')) then
    raise exception 'not authorized';
  end if;
  if nullif(trim(coalesce(p_title,'')),'') is null then raise exception 'Title is required'; end if;
  -- A VA/agent adding their own task owns it, so it stays visible in their (scoped) task list.
  -- Admins adding tasks keep whatever assignee was passed (null = unassigned).
  if p_assigned_to is null and coalesce(current_app_role(),'') in ('va','agent') then
    p_assigned_to := auth.uid();
  end if;
  insert into tasks(title, description, status, priority, due_date, contact_id, assigned_to, created_at, updated_at)
  values (trim(p_title), nullif(trim(coalesce(p_description,'')),''), 'open',
          coalesce(nullif(lower(trim(coalesce(p_priority,''))),''),'normal'),
          p_due_date, p_contact_id, p_assigned_to, now(), now())
  returning * into v_row;
  perform _log_task_activity(v_row.id, 'created');
  return v_row;
end; $function$;
