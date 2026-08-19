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
  v_has_evidence boolean; v_note text; v_due timestamp; v_day date; v_doc text;
begin
  /* THE DUE DATE, AND WHY IT IS NOT TODAY.
   * This was (now() at time zone 'America/Los_Angeles')::date - midnight TODAY -
   * so every reminder raised here was past due the moment it existed. 22 of the
   * 28 born-overdue rows in tasks came from this line, 9 still open.
   * NEXT BUSINESS DAY at 17:00 UTC (10:00 Pacific); weekends skipped because
   * loan-date-nudges runs Saturdays; 17:00 UTC because tasks.due_date is
   * timestamp WITHOUT time zone and every other producer writes UTC into it.
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
       even when a reminder already exists. Only for a VOE that CLAIMS to be
       placed. NOT a hard block: phone, fax and portal deliveries are legitimate. */
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
           set reminder_note = v_note,
               updated_at = now()
         where id = r.id;
        order_id := r.id; order_type := r.order_type; task_id := null;
        reason := 'SUPPRESSED - marked ordered but nothing delivered to ' || coalesce(r.hr_contact_email,'(no HR email)');
        return next;
        continue;
      end if;
    end if;

    /* WHAT THE REPLIES SAY - two conditions `status` cannot express.
       order_document_status returns no_reply | document | no_document | unknown.

       'document'    the thing we were chasing arrived, so STOP reminding. Our own
                     form coming back on reply-all does NOT count as one - that is
                     the case that would otherwise close a VOE nobody filled in.
       'no_document' they replied and we DID capture the attachments and nothing
                     qualifies. Worth a different nudge: chasing "no response" when
                     they have in fact responded reads as not having looked.
       'unknown'     a reply exists but its attachment metadata was never captured.
                     Falls through to the ORDINARY reminder deliberately. The order
                     is genuinely still outstanding, so a nudge is right - but it
                     must not assert the vendor attached nothing, because we do not
                     know that. Same discipline as the suppression notice.
       'no_reply'    unchanged behaviour. */
    v_doc := public.order_document_status(r.id);

    if v_doc = 'document' then
      order_id := r.id; order_type := r.order_type; task_id := null;
      reason := 'SATISFIED - a reply carried a document, no reminder needed';
      return next;
      continue;
    end if;

    /* THE DUPLICATE CHECK READS BOTH SHAPES during the changeover. loan_order_id
       is the column readers should use from now on; related_table/related_id is
       still written so nothing that reads the old pair breaks, and rows created
       before 2026-08-19 only have the old pair. Checking one alone would raise a
       SECOND reminder for every order tagged the other way. */
    if exists (select 1 from tasks t
               where (t.loan_order_id = r.id
                      or (t.related_table='loan_orders' and t.related_id = r.id))
                 and coalesce(t.status,'open') not in ('completed','cancelled')) then
      continue;
    end if;

    select max(created_at) into v_last from tasks
     where loan_order_id = r.id
        or (related_table='loan_orders' and related_id = r.id);
    if v_last is not null and v_last > now() - make_interval(days => p_interval_days) then
      continue;
    end if;

    v_title := case when v_doc = 'no_document'
                    then upper(r.order_type) || ' replied, no document - ' || r.who
                    else upper(r.order_type) || ' still outstanding - ' || r.who end
               || coalesce(' (' || nullif(trim(coalesce(r.employer_name, r.label, '')),'') || ')', '');
    /* loan_order_id IS WRITTEN ALONGSIDE the old pair, not instead of it. The
       new column is the one to read; the pair stays until nothing reads it, so
       this changeover never has a moment where a reader sees neither. */
    insert into tasks(contact_id, lead_id, title, description, due_date, status, priority,
                      related_table, related_id, loan_order_id, origin, created_at, updated_at)
    values (r.contact_id, r.contact_id, v_title,
            case when v_doc = 'no_document'
                 then 'They replied, but nothing attached looks like the document we asked for. '
                      || 'A copy of our own form coming back does not count. '
                      || 'Ask for the ' || r.order_type || ', or mark the order received or not required to stop these reminders.'
                 else 'Status is "' || coalesce(r.status,'unknown') || '". Chase the vendor, or mark the order received or not required to stop these reminders.'
            end,
            v_due, 'open',
            case when r.order_type in ('voe','payoff') then 'high' else 'normal' end,
            'loan_orders', r.id, r.id, 'system', now(), now())
    returning id into v_task;
    order_id := r.id; order_type := r.order_type; task_id := v_task;
    reason := case when v_doc = 'no_document' then 'replied without a document'
                   when v_last is null then 'first reminder' else 'due again' end;
    return next;
  end loop;
end; $function$;
