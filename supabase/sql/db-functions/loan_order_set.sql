-- loan_order_set(p_contact_id uuid, p_order_type text, p_status text, p_vendor_id uuid, p_reference text, p_notes text, p_employer_name text, p_hr_contact_name text, p_hr_contact_phone text, p_hr_contact_email text, p_order_id uuid, p_borrower_contact_id uuid, p_label text, p_follow_up_at timestamp with time zone, p_follow_up_owner text, p_hr_contact_first_name text, p_hr_contact_last_name text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.loan_order_set(p_contact_id uuid, p_order_type text, p_status text, p_vendor_id uuid DEFAULT NULL::uuid, p_reference text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_employer_name text DEFAULT NULL::text, p_hr_contact_name text DEFAULT NULL::text, p_hr_contact_phone text DEFAULT NULL::text, p_hr_contact_email text DEFAULT NULL::text, p_order_id uuid DEFAULT NULL::uuid, p_borrower_contact_id uuid DEFAULT NULL::uuid, p_label text DEFAULT NULL::text, p_follow_up_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_follow_up_owner text DEFAULT NULL::text, p_hr_contact_first_name text DEFAULT NULL::text, p_hr_contact_last_name text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id uuid; v_vendor_name text; v_lead_name text; v_old_status text;
  v_borrower_name text; v_task_id uuid; v_task_title text;
begin
  if auth.role() = 'authenticated'
     and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','lender','staff')) then
    raise exception 'staff only';
  end if;

  if p_order_id is not null then
    select id, status into v_id, v_old_status from public.loan_orders where id = p_order_id;
  elsif p_order_type <> 'voe' then
    select id, status into v_id, v_old_status
    from public.loan_orders where contact_id = p_contact_id and order_type = p_order_type limit 1;
  end if;

  if v_id is null then
    insert into public.loan_orders(contact_id, order_type, status, vendor_id, reference, notes,
                                   employer_name, hr_contact_name, hr_contact_first_name, hr_contact_last_name,
                                   hr_contact_phone, hr_contact_email,
                                   borrower_contact_id, label, follow_up_at, follow_up_owner,
                                   ordered_by_user_id, ordered_at, acknowledged_at, updated_at)
    values(p_contact_id, p_order_type, p_status, p_vendor_id, p_reference, p_notes,
           p_employer_name,
           coalesce(nullif(trim(coalesce(p_hr_contact_first_name,'')||' '||coalesce(p_hr_contact_last_name,'')),''), p_hr_contact_name),
           p_hr_contact_first_name, p_hr_contact_last_name,
           p_hr_contact_phone, p_hr_contact_email,
           p_borrower_contact_id, p_label, p_follow_up_at, p_follow_up_owner,
           auth.uid(),
           case when p_status in ('ordered','acknowledged','received') then now() else null end,
           case when p_status = 'acknowledged' then now() else null end, now())
    returning id into v_id;
  else
    update public.loan_orders set
      status = p_status,
      vendor_id = coalesce(p_vendor_id, vendor_id),
      reference = coalesce(p_reference, reference),
      notes = coalesce(p_notes, notes),
      employer_name = coalesce(p_employer_name, employer_name),
      hr_contact_first_name = coalesce(p_hr_contact_first_name, hr_contact_first_name),
      hr_contact_last_name  = coalesce(p_hr_contact_last_name, hr_contact_last_name),
      hr_contact_name = coalesce(
        nullif(trim(coalesce(p_hr_contact_first_name, hr_contact_first_name, '')||' '||coalesce(p_hr_contact_last_name, hr_contact_last_name, '')), ''),
        p_hr_contact_name, hr_contact_name),
      hr_contact_phone = coalesce(p_hr_contact_phone, hr_contact_phone),
      hr_contact_email = coalesce(p_hr_contact_email, hr_contact_email),
      borrower_contact_id = coalesce(p_borrower_contact_id, borrower_contact_id),
      label = coalesce(p_label, label),
      follow_up_at = coalesce(p_follow_up_at, follow_up_at),
      follow_up_owner = coalesce(p_follow_up_owner, follow_up_owner),
      ordered_by_user_id = coalesce(ordered_by_user_id, auth.uid()),
      ordered_at = case when p_status in ('ordered','acknowledged','received') and ordered_at is null then now() else ordered_at end,
      acknowledged_at = case when p_status = 'acknowledged' and acknowledged_at is null then now() else acknowledged_at end,
      received_at = case when p_status = 'received' and received_at is null then now() else received_at end,
      updated_at = now()
    where id = v_id;
  end if;

  if p_vendor_id is not null then
    update public.vendor_directory set usage_count = coalesce(usage_count,0)+1, last_used_at = now()
    where id = p_vendor_id returning coalesce(nullif(trim(name),''), company) into v_vendor_name;
  end if;

  if p_borrower_contact_id is not null then
    select nullif(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')),'')
      into v_borrower_name from contacts where id = p_borrower_contact_id;
  end if;
  select nullif(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')),'')
    into v_lead_name from contacts where id = p_contact_id;

  select follow_up_task_id into v_task_id from public.loan_orders where id = v_id;
  if p_follow_up_at is not null and coalesce(p_status,'') not in ('received','cancelled') then
    v_task_title := upper(p_order_type) || ' follow-up'
                    || coalesce(' — ' || v_borrower_name, '')
                    || coalesce(' (' || coalesce(p_employer_name, v_vendor_name) || ')', '');
    if v_task_id is null then
      insert into public.tasks(lead_id, contact_id, title, description, due_date, status, priority,
                               related_table, related_id, created_at, updated_at)
      values(p_contact_id, p_contact_id, v_task_title,
             'Follow up on ' || upper(p_order_type)
               || coalesce(' for ' || v_borrower_name, '')
               || coalesce(' with ' || coalesce(p_employer_name, v_vendor_name), ''),
             p_follow_up_at, 'open',
             case when p_follow_up_owner='both' then 'high' else 'normal' end,
             'loan_orders', v_id, now(), now())
      returning id into v_task_id;
      update public.loan_orders set follow_up_task_id = v_task_id where id = v_id;
    else
      update public.tasks set title = v_task_title, due_date = p_follow_up_at, status='open', updated_at = now()
      where id = v_task_id;
    end if;
  elsif v_task_id is not null and coalesce(p_status,'') = 'received' then
    update public.tasks set status='completed', completed_at=now(), updated_at=now() where id = v_task_id;
  end if;

  if p_status in ('ordered','acknowledged','received') and p_status is distinct from coalesce(v_old_status,'') then
    insert into public.activity_events(contact_id, type, channel, direction, title, description, status, created_at)
    values(
      p_contact_id, 'order', 'processing', 'internal',
      '📋 ' || upper(p_order_type) || ' ' || p_status
        || coalesce(' — ' || v_borrower_name, '')
        || case when p_order_type='voe' and p_employer_name is not null then ' @ ' || p_employer_name
                when v_vendor_name is not null then ' — ' || v_vendor_name else '' end,
      case when p_order_type='voe' then
             'VOE ' || p_status || coalesce(' for ' || v_borrower_name, '')
               || coalesce(' with ' || p_employer_name || ' HR', '')
           else
             initcap(p_order_type) || ' ' || p_status || coalesce(' with ' || v_vendor_name, '')
      end,
      'completed', now());
  end if;

  return v_id;
end; $function$;
