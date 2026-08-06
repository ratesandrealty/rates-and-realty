-- va_daily_tasks()
-- language: plpgsql   SECURITY DEFINER
-- Captured 2026-08-05.

CREATE OR REPLACE FUNCTION public.va_daily_tasks()
 RETURNS TABLE(id uuid, title text, description text, status text, priority text, due_date timestamp without time zone, contact_id uuid, lead_id uuid, contact_name text, contact_phone text, assigned_by uuid, clickup_url text, related_table text, related_id uuid, bucket text, assignee_state text, provenance text, question_pending boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* SCOPED to assignment or sharing. She sees a task if EITHER:
 *
 *   a) t.assigned_to = auth.uid()   -- Rene assigned it, or tg_tasks_autoassign did
 *   b) the task's contact has a lead_shares row for her
 *
 * WHAT CHANGED AND WHY. The previous clause was
 *   assigned_to = auth.uid() OR related_table = 'auto_followup_lead'
 * which handed her every auto-surfaced stale-lead follow-up whether or not Rene
 * had shared the lead -- Salomon Flores, Edgar Rodriguez, Moris Villalobos and
 * 16 others he had not given her. That was my recommendation and it was wrong
 * for how Rene works: sharing is his deliberate act, and a rule that routes work
 * around it is not a scope at all.
 *
 * ORDER REMINDERS ARE UNAFFECTED, and that is the point of keeping (a) first.
 * tg_tasks_autoassign stamps assigned_to on related_table='loan_orders' rows, so
 * chasing an order reaches her even on a lead she cannot otherwise see -- 2 of
 * her 4 assigned tasks are exactly that case today. Chasing orders is her job;
 * the unshared lead is Rene's to share, which is what the share nudge asks him
 * to do.
 *
 * (b) CANNOT BE SATISFIED BY A TASK WITH NO contact_id -- there is no contact to
 * share. Such a task needs an explicit assignment or nobody sees it. Exactly one
 * open task is in that state today ('Call from the Camp phone to do verbal
 * verification', related_table='leads'), and it was invisible under the OLD rule
 * too, so this change does not lose it. It is unowned rather than newly hidden.
 *
 * question_pending drives the "with Rene" state. Across a 15-hour offset she asks
 * at 09:00 PHT (18:00 PT) and his answer lands near her midnight, so a question
 * must LOOK parked rather than merely unanswered.
 *
 * due_date is `timestamp` not `timestamptz` -- tasks.due_date is timestamp
 * without time zone, and mismatching it fails the whole function at runtime with
 * "structure of query does not match function result type".
 */
begin
  return query
  select t.id, t.title, t.description, t.status, t.priority, t.due_date,
         t.contact_id, t.lead_id,
         nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as contact_name,
         case when current_app_role()='va' and not is_admin() then mask_phone(c.phone) else c.phone end as contact_phone,
         t.assigned_by, t.clickup_url, t.related_table, t.related_id,
         case when t.due_date is null then 'no_date'
              when t.due_date::date < (now() at time zone 'America/Los_Angeles')::date then 'overdue'
              when t.due_date::date = (now() at time zone 'America/Los_Angeles')::date then 'today'
              else 'upcoming' end as bucket,
         case when t.assigned_to = auth.uid() then 'mine' else 'unassigned' end as assignee_state,
         /* PROVENANCE: positive evidence of a PERSON, not absence of machinery.
            The old rule was `clickup_url is null and related_table is null` ->
            human, which no open task satisfied, so the "from Rene" pill was
            unreachable for every one of them. Rene's manual tasks arrive THROUGH
            ClickUp (15 of them: "Follow up with Anita", "Submit X loan to
            lender"), so the clickup_url test labelled exactly the tasks it
            existed to highlight as machine-made.
            A person left a trace when there is a clickup_url (he wrote it in
            ClickUp) or an assigned_by (he wrote it in the CRM). Machine sources
            leave neither -- auto_followup_lead and loan_orders rows have no
            clickup_url and no assigned_by. Defaulting the unknown case to 'auto'
            keeps a future machine source from being announced as Rene. */
         case when t.clickup_url is not null or t.assigned_by is not null
              then 'human' else 'auto' end as provenance,
         (coalesce(t.status,'open') = 'question') as question_pending
  from tasks t
  left join contacts c on c.id = t.contact_id
  where coalesce(t.status,'open') not in ('completed','cancelled')
    and (
      t.assigned_to = auth.uid()
      or exists (select 1 from lead_shares s
                  where s.contact_id = t.contact_id
                    and s.shared_with_user_id = auth.uid())
    )
  order by (coalesce(t.status,'open')='question'), (t.assigned_to = auth.uid()) desc nulls last,
           t.due_date asc nulls last;
end; $function$;
