-- order_reminders_run(p_interval_days integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured 2026-08-14 (due date moved off midnight-today).

CREATE OR REPLACE FUNCTION public.order_reminders_run(p_interval_days integer DEFAULT 2)
 RETURNS TABLE(order_id uuid, order_type text, task_id uuid, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record; v_task uuid; v_title text; v_last timestamptz;
  v_has_evidence boolean; v_note text; v_due timestamp; v_day date;
begin
  /* ── THE DUE DATE, AND WHY IT IS NOT TODAY ───────────────────────────────
   * This was `(now() at time zone 'America/Los_Angeles')::date` — midnight
   * TODAY — so every reminder raised here was past due the moment it existed.
   * 22 of the 28 born-overdue rows in `tasks` came from this line, 9 still
   * open. A nudge built on that data alerts on tasks that were never late.
   *
   * NEXT BUSINESS DAY at 17:00 UTC (10:00 Pacific):
   *   - next business day, not same-day-EOB: this only fires once an order has
   *     already sat >= p_interval_days, so a same-evening due date is red
   *     within hours, which is how it became noise.
   *   - weekends skipped. loan-date-nudges (pg_cron 38) runs daily including
   *     Saturday, so "tomorrow" on a Friday lands on a day nobody works.
   *   - 17:00 UTC, not Pacific-local. tasks.due_date is `timestamp WITHOUT
   *     time zone` and every other producer writes UTC into it — 198 of the
   *     228 dated rows sit at 17:00Z from clickup-auto-create via the bridge.
   *     This function was the one writer using a different convention, which
   *     is why the column looked mixed.
   *   - uniform across order types on purpose. Urgency is already carried by
   *     `priority` below (voe/payoff = high); encoding it twice is how two
   *     places drift, and per-kind SLAs would mean inventing numbers nobody
   *     has stated.
   * isodow: Mon=1 .. Sat=6, Sun=7. */
  v_day := (now() at time zone 'UTC')::date + 1;
  v_day := v_day + case extract(isodow from v_day) when 6 then 2 when 7 then 1 else 0 end;
  v_due := v_day + time '17:00';

  for r in
    select o.id, o.order_type, o.status, o.contact_id, o.employer_name, o.label,
           o.hr_contact_email, o.acknowledged_at, o.notes, o.revision_note,
           coalesce(nullif(trim(c.first_name||' '||coalesce(c.last_name,'')),''), 'the borrower') as who
    from loan_orders o
    left join contacts c on c.id = o.contact_id
    where coalesce(o.status,'') not in ('received','not_required','cancelled','complete','completed')
  loop
    /* EVIDENCE OF DELIVERY, before the duplicate check so the order is annotated
       even when a reminder already exists.
       Only for a VOE that CLAIMS to be placed — 'ordered' or 'acknowledged'. A
       'not_ordered' row is not contradicting itself and needs no note.
       NOT a hard block: phone, fax and portal deliveries are legitimate. */
    if r.order_type = 'voe' and coalesce(r.status,'') in ('ordered','acknowledged') then
      v_has_evidence :=
           exists (select 1 from email_log e
                    where e.template='voe_request' and e.status='sent'
                      and e.contact_id = r.contact_id
                      and lower(e.to_email) = lower(coalesce(r.hr_contact_email,'~none~')))
        or r.acknowledged_at is not null
        or coalesce(r.notes,'') || ' ' || coalesce(r.revision_note,'')
             ~* '(phone|fax|called|verbal|portal|mailed|in person|by hand)';

      if not v_has_evidence then
        v_note := 'Reminder suppressed ' || to_char(now() at time zone 'America/Los_Angeles','YYYY-MM-DD')
               || ': marked ordered, but no evidence this VOE reached '
               || coalesce(r.hr_contact_email,'the HR contact')
               || '. No successful send is recorded and nothing notes another channel. '
               || 'Re-send it, or add a note saying how it was delivered, and reminders resume.';
        update loan_orders
           set revision_note = case when coalesce(revision_note,'') = ''
                                     or coalesce(revision_note,'') like 'Reminder suppressed %'
                                    then v_note else revision_note end,
               updated_at = now()
         where id = r.id;
        order_id := r.id; order_type := r.order_type; task_id := null;
        reason := 'SUPPRESSED - marked ordered but nothing delivered to ' || coalesce(r.hr_contact_email,'(no HR email)');
        return next;
        continue;
      end if;
    end if;

    if exists (select 1 from tasks t
               where t.related_table='loan_orders' and t.related_id = r.id
                 and coalesce(t.status,'open') not in ('completed','cancelled')) then
      continue;
    end if;

    select max(created_at) into v_last from tasks
     where related_table='loan_orders' and related_id = r.id;
    if v_last is not null and v_last > now() - make_interval(days => p_interval_days) then
      continue;
    end if;

    v_title := upper(r.order_type) || ' still outstanding - ' || r.who
               || coalesce(' (' || nullif(trim(coalesce(r.employer_name, r.label, '')),'') || ')', '');
    insert into tasks(contact_id, lead_id, title, description, due_date, status, priority,
                      related_table, related_id, created_at, updated_at)
    values (r.contact_id, r.contact_id, v_title,
            'Status is "' || coalesce(r.status,'unknown') || '". Chase the vendor, or mark the order received or not required to stop these reminders.',
            v_due, 'open',
            case when r.order_type in ('voe','payoff') then 'high' else 'normal' end,
            'loan_orders', r.id, now(), now())
    returning id into v_task;
    order_id := r.id; order_type := r.order_type; task_id := v_task;
    reason := case when v_last is null then 'first reminder' else 'due again' end;
    return next;
  end loop;
end; $function$;
