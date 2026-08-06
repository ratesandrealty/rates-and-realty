-- order_email_note(p_order_id uuid, p_to_email text, p_to_name text, p_subject text, p_from_key text, p_ok boolean, p_error text)
-- language: plpgsql
-- Captured from production 2026-08-06.

CREATE OR REPLACE FUNCTION public.order_email_note(p_order_id uuid, p_to_email text, p_to_name text, p_subject text, p_from_key text, p_ok boolean, p_error text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Record what the send ACTUALLY did. Called after email-service returns, so the
 * note reflects a real result rather than an intention. */
declare v_lead uuid; v_note uuid; v_from text;
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only'; end if;
  select contact_id into v_lead from public.loan_orders where id = p_order_id;
  v_from := case when p_from_key='processing' then 'processing@ratesandrealty.com' else 'rene@ratesandrealty.com' end;

  insert into public.order_notes(order_id, contact_id, note_text, is_follow_up,
                                 author_user_id, author_display, source, created_at)
  values(p_order_id, v_lead,
         case when p_ok
           then '📧 Emailed ' || coalesce(p_to_name, p_to_email) || ' from ' || v_from
                || ' (copies to rene@ + processing@)' || E'\nSubject: ' || coalesce(p_subject,'')
           else '⚠ Email to ' || coalesce(p_to_name, p_to_email) || ' FAILED — not sent.'
                || E'\nSubject: ' || coalesce(p_subject,'')
                || case when nullif(trim(coalesce(p_error,'')),'') is null then ''
                        else E'\nError: ' || left(p_error, 200) end
         end,
         p_ok, auth.uid(),
         case when p_from_key='processing' then 'Processing (VA)' else 'Rene' end,
         'processing', now())
  returning id into v_note;
  return v_note;
end; $function$;
