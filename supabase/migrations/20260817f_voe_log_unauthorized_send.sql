-- Record that a human chose to send a VOE with no signed borrower authorization.
--
-- REVERT:
--   drop function if exists public.voe_log_unauthorized_send(uuid, uuid, text);
--
-- ══ WHY THIS EXISTS ══
--
-- The gate used to be a bare confirm(). Two problems, and the second is the one
-- that matters:
--
--   1. Chrome offers "prevent this page from creating additional dialogs" after
--      repeated prompts, and a SUPPRESSED confirm() returns false with no dialog
--      shown. The send then stops silently — which is what happened on
--      2026-08-17 and took edge logs to locate.
--   2. THE CHOICE WAS UNATTRIBUTABLE. "false" from a suppressed dialog and
--      "false" from a human clicking Cancel are the same value, and there was no
--      record either way. The alternative branch SENDS AN EMPLOYMENT
--      VERIFICATION WITHOUT A SIGNED BORROWER AUTHORIZATION, and nothing anywhere
--      recorded that a person decided that.
--
-- changed_by is stamped from auth.uid() INSIDE the function and is not a
-- parameter. A caller-supplied actor would defeat the entire point of the record
-- — the same reason set_recording_consent stamps _by server-side.
--
-- ══ THE CALLER MUST TREAT A FAILURE HERE AS FATAL ══
--
-- lead-detail calls this BEFORE the send and aborts if it raises. That ordering
-- is deliberate: a VOE that goes out with no record of the decision is worse than
-- a VOE that does not go out. No record, no send. The failure is loud — a toast —
-- never a silent skip.

create or replace function public.voe_log_unauthorized_send(
  p_order_id   uuid,
  p_contact_id uuid default null,
  p_hr_email   text default null
) returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
/* Writes one audit_log row per decision to send a VOE without a signed borrower
   authorization on file. Returns the audit_log id so the caller can prove the
   record exists rather than assuming it — this runs before the send, and the
   send is abandoned if it raises.

   changed_by comes from auth.uid(), never from a parameter: a record of who
   decided is worthless if the decider names themselves. */
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

grant execute on function public.voe_log_unauthorized_send(uuid, uuid, text) to authenticated;
