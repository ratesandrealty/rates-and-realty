-- voe_request_log(p_order_id uuid, p_contact_id uuid, p_hr_name text, p_hr_email text, p_hr_phone text, p_employer text, p_subject text, p_body_html text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.voe_request_log(p_order_id uuid, p_contact_id uuid, p_hr_name text, p_hr_email text, p_hr_phone text, p_employer text, p_subject text, p_body_html text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_token text; v_log_id uuid;
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only'; end if;
  select voe_reply_token into v_token from public.loan_orders where id = p_order_id;
  if v_token is null then v_token := 'voe_'||replace(gen_random_uuid()::text,'-',''); end if;
  update public.loan_orders set
    status = case when status in ('not_ordered','not_required') then 'ordered' else status end,
    employer_name = coalesce(p_employer, employer_name),
    hr_contact_name = coalesce(p_hr_name, hr_contact_name),
    hr_contact_email = coalesce(p_hr_email, hr_contact_email),
    hr_contact_phone = coalesce(p_hr_phone, hr_contact_phone),
    voe_reply_token = v_token, last_follow_up_at = now(),
    ordered_at = coalesce(ordered_at, now()), updated_at = now()
  where id = p_order_id;
  insert into public.email_log(contact_id, direction, to_email, to_name, from_email, subject, body_html, status, template, created_at, sent_at)
  values (p_contact_id, 'outbound', p_hr_email, p_hr_name, 'rene@ratesandrealty.com', p_subject, p_body_html, 'sent', 'voe_request', now(), now())
  returning id into v_log_id;
  return jsonb_build_object('reply_token', v_token, 'email_log_id', v_log_id, 'order_id', p_order_id);
end; $function$;
