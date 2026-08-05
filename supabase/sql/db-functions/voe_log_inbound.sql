-- voe_log_inbound(p_gmail_message_id text, p_gmail_thread_id text, p_from_email text, p_to_email text, p_cc_email text, p_subject text, p_body_html text, p_body_text text, p_reply_token text, p_received_at timestamp with time zone)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.voe_log_inbound(p_gmail_message_id text, p_gmail_thread_id text DEFAULT NULL::text, p_from_email text DEFAULT NULL::text, p_to_email text DEFAULT NULL::text, p_cc_email text DEFAULT NULL::text, p_subject text DEFAULT NULL::text, p_body_html text DEFAULT NULL::text, p_body_text text DEFAULT NULL::text, p_reply_token text DEFAULT NULL::text, p_received_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text;
  v_match jsonb;
  v_order_id uuid;
  v_contact_id uuid;
  v_matched_by text;
  v_log_id uuid;
begin
  -- Guard: admins/staff (UI-side) or the poller running as service_role.
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if not (
       public.is_admin()
       or v_role = 'service_role'
       or coalesce(public.current_app_role(), '') in ('va','loa','agent','staff')
     ) then
    raise exception 'not authorized';
  end if;

  if nullif(trim(p_gmail_message_id), '') is null then
    raise exception 'gmail_message_id is required';
  end if;

  -- Resolve the owning VOE order / contact.
  v_match := public.voe_match_reply(
    p_from_email => p_from_email,
    p_to_email   => p_to_email,
    p_cc_email   => p_cc_email,
    p_subject    => p_subject,
    p_body       => coalesce(p_body_text, p_body_html),
    p_reply_token => p_reply_token
  );
  v_order_id   := nullif(v_match ->> 'order_id','')::uuid;
  v_contact_id := nullif(v_match ->> 'contact_id','')::uuid;
  v_matched_by := v_match ->> 'matched_by';

  -- Log inbound. gmail_message_id is UNIQUE -> idempotent poll via ON CONFLICT.
  -- template='voe_request' ensures voe_activity() surfaces the event.
  insert into public.email_log(
    contact_id, direction, from_email, to_email, cc_email,
    subject, body_html, body_text, gmail_message_id, gmail_thread_id,
    status, template, created_at
  )
  values (
    v_contact_id, 'inbound', p_from_email, p_to_email, p_cc_email,
    p_subject, p_body_html, p_body_text, p_gmail_message_id, p_gmail_thread_id,
    'received', 'voe_request', coalesce(p_received_at, now())
  )
  on conflict (gmail_message_id) do nothing
  returning id into v_log_id;

  if v_log_id is null then
    return jsonb_build_object(
      'duplicate', true, 'email_log_id', null,
      'order_id', v_order_id, 'contact_id', v_contact_id, 'matched_by', v_matched_by
    );
  end if;

  -- Touch the matched order so "last activity" reflects the reply (non-destructive;
  -- deliberately does NOT auto-advance status to 'received').
  if v_order_id is not null then
    update public.loan_orders set updated_at = now() where id = v_order_id;
  end if;

  return jsonb_build_object(
    'duplicate', false, 'email_log_id', v_log_id,
    'order_id', v_order_id, 'contact_id', v_contact_id, 'matched_by', v_matched_by
  );
end;
$function$;
