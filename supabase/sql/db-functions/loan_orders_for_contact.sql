-- loan_orders_for_contact(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-17. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.loan_orders_for_contact(p_contact_id uuid)
 RETURNS TABLE(id uuid, order_type text, status text, label text, vendor_id uuid, vendor_name text, vendor_company text, borrower_contact_id uuid, borrower_name text, employer_name text, hr_contact_name text, hr_contact_first_name text, hr_contact_last_name text, hr_contact_phone text, hr_contact_email text, reference text, notes text, ordered_at timestamp with time zone, received_at timestamp with time zone, follow_up_at timestamp with time zone, follow_up_owner text, follow_up_task_id uuid, last_follow_up_at timestamp with time zone, last_note_at timestamp with time zone, note_count integer, reminder_note text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
/* reminder_note appended 20260817l. It is the system's follow-up notice and the
   VOE cards are the only place three of them currently exist — this function
   feeds those cards, and its RETURNS TABLE is an ENUMERATED list, so a column
   added to loan_orders does not appear here until someone remembers. That is the
   silent-omission failure mode of an enumerated list, and it hid the notice from
   the exact panel that needed it. */
begin
  if coalesce(auth.role(),'') is distinct from 'service_role'
     and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','lender','staff')) then
    raise exception 'staff only';
  end if;
  return query
  select o.id, o.order_type, o.status, o.label,
         o.vendor_id, v.name, v.company,
         o.borrower_contact_id,
         nullif(trim(coalesce(b.first_name,'')||' '||coalesce(b.last_name,'')),''),
         o.employer_name, o.hr_contact_name, o.hr_contact_first_name, o.hr_contact_last_name,
         o.hr_contact_phone, o.hr_contact_email,
         o.reference, o.notes,
         o.ordered_at, o.received_at,
         o.follow_up_at, o.follow_up_owner, o.follow_up_task_id,
         o.last_follow_up_at, o.last_note_at,
         (select count(*)::int from public.order_notes n where n.order_id = o.id),
         o.reminder_note
  from public.loan_orders o
  left join public.vendor_directory v on v.id = o.vendor_id
  left join public.contacts b on b.id = o.borrower_contact_id
  where o.contact_id = p_contact_id
  order by o.order_type, o.ordered_at desc nulls last, o.id;
end; $function$;
