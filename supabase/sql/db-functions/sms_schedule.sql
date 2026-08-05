-- sms_schedule(p_contact_id uuid, p_to_phone text, p_body text, p_send_at timestamp with time zone, p_media_url text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sms_schedule(p_contact_id uuid, p_to_phone text, p_body text, p_send_at timestamp with time zone, p_media_url text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_id uuid;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  if p_send_at is null or p_send_at <= now() then raise exception 'send time must be in the future'; end if;
  if coalesce(trim(p_body),'') = '' then raise exception 'message body required'; end if;
  if coalesce(trim(p_to_phone),'') = '' then raise exception 'recipient phone required'; end if;

  /* Opt-out gate. is_phone_suppressed() covers BOTH lists: contacts.sms_opt_in
     = false, and the contact-independent sms_suppressions list — so a STOP from
     a number that was never a contact is honoured here too. */
  if public.is_phone_suppressed(p_to_phone, p_contact_id) then
    raise exception 'recipient has opted out of SMS';
  end if;

  insert into public.sms_log(contact_id, to_phone, body, media_url, direction, status,
                             scheduled_at, trigger_type, created_at)
  values(p_contact_id, p_to_phone, p_body, p_media_url, 'outbound', 'scheduled',
         p_send_at, 'manual_scheduled', now())
  returning id into v_id;
  return v_id;
end; $function$;
