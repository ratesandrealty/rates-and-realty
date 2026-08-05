-- va_daily_tasks()
-- language: sql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_daily_tasks()
 RETURNS TABLE(id uuid, title text, description text, status text, priority text, due_date timestamp without time zone, contact_id uuid, lead_id uuid, contact_name text, contact_phone text, assigned_by uuid, clickup_url text, bucket text)
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  select t.id, t.title, t.description, t.status, t.priority, t.due_date, t.contact_id, t.lead_id,
    nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as contact_name,
    case when current_app_role()='va' and not is_admin() then mask_phone(c.phone) else c.phone end as contact_phone,
    t.assigned_by, t.clickup_url,
    case when t.due_date is null then 'no_date'
         when t.due_date::date < (now() at time zone 'America/Los_Angeles')::date then 'overdue'
         when t.due_date::date = (now() at time zone 'America/Los_Angeles')::date then 'today'
         else 'upcoming' end as bucket
  from tasks t left join contacts c on c.id = t.contact_id
  where t.assigned_to = auth.uid()
    and coalesce(t.status,'open') not in ('completed','complete','closed','done','cancelled','canceled')
  order by t.due_date asc nulls last;
$function$;
