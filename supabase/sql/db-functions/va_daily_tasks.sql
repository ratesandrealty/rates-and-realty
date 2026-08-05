-- va_daily_tasks()
-- language: plpgsql   SECURITY DEFINER
-- Re-captured 2026-08-05: unassigned tasks + provenance labels, due_date fixed
-- to timestamp (not timestamptz) to match tasks.due_date.

CREATE OR REPLACE FUNCTION public.va_daily_tasks()
 RETURNS TABLE(id uuid, title text, description text, status text, priority text, due_date timestamp without time zone, contact_id uuid, lead_id uuid, contact_name text, contact_phone text, assigned_by uuid, clickup_url text, bucket text, assignee_state text, provenance text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Also returns UNASSIGNED open tasks, not only assigned_to = auth.uid().
 *
 * Until 2026-08-05 this filtered on assigned_to = auth.uid() alone, and
 * tasks.assigned_to was populated on 0 of 207 rows — so it could never return
 * anything and the VA's Daily Tasks panel was structurally empty. Rene added
 * tasks, they saved, and they reached nobody.
 *
 * Which unassigned tasks: hand-typed and auto_followup_lead ONLY. ClickUp-synced
 * ones are excluded — they already live in ClickUp where they are actioned, and
 * duplicating them here creates two places to mark one thing done. Of the 48
 * open unassigned tasks when this shipped, 46 were machine-made and 20 of those
 * were ClickUp-synced.
 *
 * Two labels so the panel can distinguish them, because "Rene asked me" and
 * "the system noticed a stale lead" are different instructions:
 *   assignee_state  'mine' | 'unassigned'
 *   provenance      'human' | 'auto'
 *
 * due_date is `timestamp` NOT `timestamptz`: tasks.due_date is timestamp without
 * time zone, and declaring timestamptz makes the whole function fail at runtime
 * with "structure of query does not match function result type". Caught by
 * calling it rather than by reading it.
 */
begin
  return query
  select t.id, t.title, t.description, t.status, t.priority, t.due_date,
         t.contact_id, t.lead_id,
         nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as contact_name,
         case when current_app_role()='va' and not is_admin() then mask_phone(c.phone) else c.phone end as contact_phone,
         t.assigned_by, t.clickup_url,
         case when t.due_date is null then 'no_date'
              when t.due_date::date < (now() at time zone 'America/Los_Angeles')::date then 'overdue'
              when t.due_date::date = (now() at time zone 'America/Los_Angeles')::date then 'today'
              else 'upcoming' end as bucket,
         case when t.assigned_to = auth.uid() then 'mine' else 'unassigned' end as assignee_state,
         case when t.clickup_url is null and t.related_table is null then 'human' else 'auto' end as provenance
  from tasks t
  left join contacts c on c.id = t.contact_id
  where coalesce(t.status,'open') not in ('completed','complete','closed','done','cancelled','canceled')
    and (
      t.assigned_to = auth.uid()
      or (t.assigned_to is null and (t.clickup_url is null or t.related_table = 'auto_followup_lead'))
    )
  order by (t.assigned_to = auth.uid()) desc nulls last, t.due_date asc nulls last;
end; $function$;
