-- order_reminders_run(p_interval_days integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured 2026-08-06 (third-party order reminders).

CREATE OR REPLACE FUNCTION public.order_reminders_run(p_interval_days integer DEFAULT 2)
 RETURNS TABLE(order_id uuid, order_type text, task_id uuid, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* One reminder task per OUTSTANDING third-party order, every 2 days, until it is
 * received or explicitly not needed.
 *
 * DONE-STATES SUPPRESS. received / not_required / cancelled / complete are
 * terminal. not_required is the "Don't Need" case and must never nag — marking
 * something not needed and then being reminded every two days is how people
 * learn to ignore the panel.
 *
 * COUNTS FROM THE LAST REMINDER, not the order date. Counting from ordered_at
 * would mean an order placed 30 days ago generates 15 backdated reminders on
 * first run — a burst that buries everything real. An order never reminded is
 * due immediately; after that the clock restarts each time.
 *
 * NEVER DUPLICATES. If an OPEN reminder for that order exists, nothing is
 * created: the previous one has not been dealt with, and a second row adds no
 * information.
 *
 * Assignment is left to tg_tasks_autoassign, which fills related_table
 * ='loan_orders' from va_account_uid(). One place decides who owns an order task.
 *
 * Idempotent, so it is safe to run more than once a day; it hangs off the
 * existing loan-date-nudges cron rather than adding another schedule. */
declare
  r record;
  v_task uuid;
  v_title text;
  v_last timestamptz;
begin
  for r in
    select o.id, o.order_type, o.status, o.contact_id, o.employer_name, o.label,
           coalesce(nullif(trim(c.first_name||' '||coalesce(c.last_name,'')),''), 'the borrower') as who
    from loan_orders o
    left join contacts c on c.id = o.contact_id
    where coalesce(o.status,'') not in ('received','not_required','cancelled','complete','completed')
  loop
    if exists (
      select 1 from tasks t
      where t.related_table = 'loan_orders' and t.related_id = r.id
        and coalesce(t.status,'open') not in ('completed','cancelled')
    ) then
      continue;
    end if;

    select max(created_at) into v_last from tasks
     where related_table = 'loan_orders' and related_id = r.id;

    if v_last is not null and v_last > now() - make_interval(days => p_interval_days) then
      continue;
    end if;

    v_title := upper(r.order_type) || ' still outstanding - ' || r.who
               || coalesce(' (' || nullif(trim(coalesce(r.employer_name, r.label, '')),'') || ')', '');

    insert into tasks(contact_id, lead_id, title, description, due_date, status, priority,
                      related_table, related_id, created_at, updated_at)
    values (r.contact_id, r.contact_id, v_title,
            'Status is "' || coalesce(r.status,'unknown') || '". Chase the vendor, or mark the order received or not required to stop these reminders.',
            (now() at time zone 'America/Los_Angeles')::date, 'open',
            case when r.order_type in ('voe','payoff') then 'high' else 'normal' end,
            'loan_orders', r.id, now(), now())
    returning id into v_task;

    order_id := r.id; order_type := r.order_type; task_id := v_task;
    reason := case when v_last is null then 'first reminder' else 'due again' end;
    return next;
  end loop;
end; $function$;
