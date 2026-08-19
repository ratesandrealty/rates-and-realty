-- va_daily_tasks()
-- language: plpgsql   SECURITY DEFINER
-- Captured 2026-08-14 (three-way assignee, UTC bucket, logged provenance).

CREATE OR REPLACE FUNCTION public.va_daily_tasks()
 RETURNS TABLE(id uuid, title text, description text, status text, priority text, due_date timestamp without time zone, contact_id uuid, lead_id uuid, contact_name text, contact_phone text, assigned_by uuid, clickup_url text, related_table text, related_id uuid, bucket text, assignee_state text, provenance text, question_pending boolean, referral_partner_id uuid, referral_partner_label text, loan_order_id uuid, loan_order_label text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* SCOPED to assignment or sharing. She sees a task if EITHER:
 *
 *   a) t.assigned_to = auth.uid()   -- Rene assigned it, or tg_tasks_autoassign did
 *   b) the task's contact has a lead_shares row for her
 *
 * The previous clause was assigned_to = auth.uid() OR related_table =
 * 'auto_followup_lead', which handed her every auto-surfaced stale-lead
 * follow-up whether or not Rene had shared the lead. Sharing is his deliberate
 * act, and a rule that routes work around it is not a scope at all.
 *
 * ORDER REMINDERS ARE UNAFFECTED, which is the point of keeping (a) first.
 * tg_tasks_autoassign stamps assigned_to on loan_orders rows, so chasing an
 * order reaches her even on a lead she cannot otherwise see.
 *
 * (b) CANNOT BE SATISFIED BY A TASK WITH NO contact_id -- there is no contact to
 * share. Such a task needs an explicit assignment or nobody sees it.
 *
 * question_pending drives the "with Rene" state. Across a 15-hour offset she asks
 * at 09:00 PHT (18:00 PT) and his answer lands near her midnight, so a question
 * must LOOK parked rather than merely unanswered.
 *
 * due_date is `timestamp` not `timestamptz` -- tasks.due_date is timestamp
 * without time zone, and mismatching it fails the whole function at runtime with
 * "structure of query does not match function result type", naming the column
 * NUMBER rather than the column.
 */
begin
  return query
  select t.id, t.title, t.description, t.status, t.priority, t.due_date,
         t.contact_id, t.lead_id,
         nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as contact_name,
         case when current_app_role()='va' and not is_admin() then mask_phone(c.phone) else c.phone end as contact_phone,
         t.assigned_by, t.clickup_url, t.related_table, t.related_id,
         /* BUCKETED IN UTC, because that is what the column holds. The Pacific
            comparison this replaced re-bucketed during almost exactly the VA's
            5pm-2am shift, so a task due 17:00Z read as "today" all evening. */
         case when t.due_date is null then 'no_date'
              when t.due_date::date < (now() at time zone 'UTC')::date then 'overdue'
              when t.due_date::date = (now() at time zone 'UTC')::date then 'today'
              else 'upcoming' end as bucket,
         /* THREE-WAY, not two. 'unassigned' is a real state -- work nobody has
            taken -- not a synonym for "not yours". */
         case when t.assigned_to is null then 'unassigned'
              when t.assigned_to = auth.uid() then 'mine'
              else 'other' end as assignee_state,
         /* ONE PROVENANCE MECHANISM, NOT TWO. tasks.origin holds the answer
            directly, so related_table and a clickup_automation_log lookup cannot
            drift apart. */
         case when t.origin = 'user' then 'human' else 'auto' end as provenance,
         (coalesce(t.status,'open') = 'question') as question_pending,
         /* THE TAGS, appended so every existing column keeps its position. */
         t.referral_partner_id,
         nullif(trim(
           coalesce(nullif(trim(coalesce(rp.company,'')),''), '')
           || case
                when nullif(trim(coalesce(rp.first_name,'')||' '||coalesce(rp.last_name,'')),'') is null then ''
                when nullif(trim(coalesce(rp.company,'')),'') is null
                  then trim(coalesce(rp.first_name,'')||' '||coalesce(rp.last_name,''))
                else ' — ' || trim(coalesce(rp.first_name,'')||' '||coalesce(rp.last_name,''))
              end
         ), '')::text as referral_partner_label,
         t.loan_order_id,
         nullif(trim(
           coalesce(upper(lo.order_type),'')
           || coalesce(' · ' || nullif(trim(coalesce(lo.label, lo.employer_name,'')),''), '')
         ), '')::text as loan_order_label
  from tasks t
  left join contacts c on c.id = t.contact_id
  left join referral_partners rp on rp.id = t.referral_partner_id
  left join loan_orders lo on lo.id = t.loan_order_id
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
