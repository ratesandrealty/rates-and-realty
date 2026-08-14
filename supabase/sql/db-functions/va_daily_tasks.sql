-- va_daily_tasks()
-- language: plpgsql   SECURITY DEFINER
-- Captured 2026-08-14 (three-way assignee, UTC bucket, logged provenance).

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
         /* BUCKETED IN UTC, because that is what the column holds. tasks.due_date
            is `timestamp WITHOUT time zone` and every producer writes UTC into
            it; this compared against the PACIFIC calendar date, which is a
            different day for seven hours out of every twenty-four.
            Those seven hours are 17:00-00:00 Pacific -- almost exactly the VA's
            5pm-2am shift. A task due 17:00Z (10:00 PT) that she opens at 18:00
            PT is eight hours late, and the Pacific comparison called it 'today'
            for her entire working evening. Nothing re-buckets at midday, when
            the two dates agree; everything re-buckets during her shift. */
         case when t.due_date is null then 'no_date'
              when t.due_date::date < (now() at time zone 'UTC')::date then 'overdue'
              when t.due_date::date = (now() at time zone 'UTC')::date then 'today'
              else 'upcoming' end as bucket,
         /* THREE-WAY, not two. This was
              case when assigned_to = auth.uid() then 'mine' else 'unassigned' end
            which calls a task assigned to SOMEBODY ELSE "unassigned". Harmless
            while the only caller was the VA's own board; under an admin view it
            labels every one of Aubrey's tasks Unassigned, and Unassigned is
            meant to be a real state -- work nobody has taken -- not a synonym
            for "not yours". */
         case when t.assigned_to is null then 'unassigned'
              when t.assigned_to = auth.uid() then 'mine'
              else 'other' end as assignee_state,
         /* PROVENANCE FROM THE LOG, not from a proxy.
            The previous rule was `clickup_url is not null or assigned_by is not
            null` -> human. Every automation-created task carries a clickup_url,
            so it labelled 201 of 297 machine-made tasks as coming from Rene.
            The comment here used to cite "Follow up with Anita" as one of his
            manual tasks; clickup_automation_log records it as the `new_lead`
            rule firing on 2026-08-05 07:08. Four of the five open tasks that
            looked hand-written are that same rule.
            clickup_automation_log.clickup_task_id is the positive record of a
            machine having created the row, and related_table marks the two SQL
            creators (order_reminders_run, surface_stale_leads).
            KNOWN RESIDUAL, measured rather than assumed: two rate_lock_5d rows
            from 2026-06-18 have no log entry carrying their task id, so they
            still read 'human'. Both are completed and no OPEN task is affected;
            739 of 740 log rows since then do record the id. Wrong on 2 rows
            instead of 201, and the 2 are named rather than left to be found. */
         case when t.related_table is not null
                or (t.clickup_task_id is not null
                    and exists (select 1 from clickup_automation_log l
                                 where l.clickup_task_id = t.clickup_task_id))
              then 'auto' else 'human' end as provenance,
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
