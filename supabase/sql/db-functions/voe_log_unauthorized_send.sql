-- voe_log_unauthorized_send(p_order_id uuid, p_contact_id uuid, p_hr_email text)
-- language: plpgsql
-- Captured from production 2026-08-17.

CREATE OR REPLACE FUNCTION public.voe_log_unauthorized_send(p_order_id uuid, p_contact_id uuid DEFAULT NULL::uuid, p_hr_email text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Writes one audit_log row per decision to send a VOE without a signed borrower
   authorization on file. Returns the audit_log id so the caller can prove the
   record exists rather than assuming it — this runs before the send, and the
   send is abandoned if it raises.

   changed_by comes from auth.uid(), never from a parameter: a record of who
   decided is worthless if the decider names themselves.

   The gate this backs used to be a bare confirm(), where a suppressed dialog and
   a human clicking Cancel produced the same value and neither left a trace —
   while the other branch sends an employment verification with no signed
   borrower authorization. */
declare
  v_id bigint;
  v_actor uuid := auth.uid();
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;

  if p_order_id is null then
    raise exception 'voe_log_unauthorized_send: p_order_id is required';
  end if;

  /* An unauthenticated caller cannot produce an attributable record, so it is
     refused rather than written with a null actor. A row saying "somebody"
     decided is the thing this function exists to prevent. */
  if v_actor is null then
    raise exception 'voe_log_unauthorized_send: no authenticated user to attribute the decision to';
  end if;

  insert into audit_log (table_name, row_id, operation, new_data, changed_by)
  values ('loan_orders', p_order_id::text, 'VOE_SENT_WITHOUT_BORROWER_AUTH',
          jsonb_build_object(
            'contact_id', p_contact_id,
            'hr_email', p_hr_email,
            'decided_at', now(),
            'note', 'Staff confirmed sending a VOE with no signed borrower authorization on file.'),
          v_actor)
  returning id into v_id;

  return v_id;
end;
$function$;
