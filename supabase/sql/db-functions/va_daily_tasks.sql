-- va_daily_tasks()
-- language: plpgsql   SECURITY DEFINER
-- Captured 2026-08-05.

CREATE OR REPLACE FUNCTION public.va_daily_tasks()
 RETURNS TABLE(id uuid, title text, description text, status text, priority text, due_date timestamp without time zone, contact_id uuid, lead_id uuid, contact_name text, contact_phone text, assigned_by uuid, clickup_url text, bucket text, assignee_state text, provenance text, question_pending boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* SCOPED to the account, plus stale-lead follow-ups.
 *
 *   assigned_to = auth.uid()  OR  related_table = 'auto_followup_lead'
 *
 * The auto_followup_lead clause is deliberate. Those 23 are "this lead has gone
 * quiet, chase it" — real VA work, and unassigned, so dropping them would move
 * the work NOWHERE rather than to Rene: nobody sees an unassigned task except an
 * admin browsing all tasks.
 *
 * Everything else unassigned is now excluded. That is only safe BECAUSE the
 * auto-assign shipped in the same change (tg_tasks_autoassign fills
 * related_table='loan_orders' from va_account_uid()). Scoping alone would have
 * returned the panel to the empty state it was in before 2026-08-05 — 0 rows,
 * because nothing was assigned to anyone.
 *
 * question_pending drives the "with Rene" state. Across a 15-hour offset she
 * asks at 09:00 PHT (18:00 PT) and his answer lands near her midnight, so a
 * question must LOOK parked rather than merely unanswered.
 *
 * due_date is `timestamp` not `timestamptz` — tasks.due_date is timestamp
 * without time zone, and mismatching it fails the whole function at runtime with
 * "structure of query does not match function result type".
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
         case when t.clickup_url is null and t.related_table is null then 'human' else 'auto' end as provenance,
         (coalesce(t.status,'open') = 'question') as question_pending
  from tasks t
  left join contacts c on c.id = t.contact_id
  where coalesce(t.status,'open') not in ('completed','cancelled')
    and (t.assigned_to = auth.uid() or t.related_table = 'auto_followup_lead')
  order by (coalesce(t.status,'open')='question'), (t.assigned_to = auth.uid()) desc nulls last,
           t.due_date asc nulls last;
end; $function$;
