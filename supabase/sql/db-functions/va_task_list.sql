-- va_task_list(p_include_completed boolean)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_task_list(p_include_completed boolean DEFAULT false)
 RETURNS TABLE(id uuid, title text, description text, status text, priority text, due_date timestamp without time zone, contact_id uuid, contact_name text, created_at timestamp without time zone, updated_at timestamp without time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not (is_admin() or coalesce(current_app_role(),'') in ('va','agent')) then
    raise exception 'not authorized';
  end if;
  return query
  select t.id, t.title, t.description, t.status, t.priority, t.due_date, t.contact_id,
         nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as contact_name,
         t.created_at, t.updated_at
  from tasks t
  left join contacts c on c.id = t.contact_id
  where (p_include_completed or coalesce(t.status,'open') not in ('completed','cancelled','dismissed'))
    and (
      is_admin()                                                            -- admins see all
      or t.assigned_to = auth.uid()                                         -- tasks assigned to me
      or (t.contact_id is not null and is_lead_shared_with_me(t.contact_id)) -- tasks on my shared leads
    )
  order by
    case lower(coalesce(t.priority,'normal')) when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.due_date asc nulls last, t.created_at desc;
end; $function$;
