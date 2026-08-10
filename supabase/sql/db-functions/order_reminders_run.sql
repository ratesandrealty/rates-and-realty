-- order_reminders_run(p_interval_days integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured 2026-08-06 (third-party order reminders).

CREATE OR REPLACE FUNCTION public.order_reminders_run(p_interval_days integer DEFAULT 2)
 RETURNS TABLE(order_id uuid, order_type text, task_id uuid, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record; v_task uuid; v_title text; v_last timestamptz;
  v_has_evidence boolean; v_note text;
begin
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
            (now() at time zone 'America/Los_Angeles')::date, 'open',
            case when r.order_type in ('voe','payoff') then 'high' else 'normal' end,
            'loan_orders', r.id, now(), now())
    returning id into v_task;
    order_id := r.id; order_type := r.order_type; task_id := v_task;
    reason := case when v_last is null then 'first reminder' else 'due again' end;
    return next;
  end loop;
end; $function$;
