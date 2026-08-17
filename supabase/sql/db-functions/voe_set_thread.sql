-- voe_set_thread(p_order_id uuid, p_gmail_message_id text, p_gmail_thread_id text, p_rfc_message_id text, p_reply_token text)
-- language: plpgsql
-- Captured from production 2026-08-17.

CREATE OR REPLACE FUNCTION public.voe_set_thread(p_order_id uuid, p_gmail_message_id text DEFAULT NULL::text, p_gmail_thread_id text DEFAULT NULL::text, p_rfc_message_id text DEFAULT NULL::text, p_reply_token text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* VOE counterpart of hoi_quote_set_thread. See that function for why the
   setters are separate from the log functions and why a null rfc_message_id is
   stored rather than substituted. */
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only'; end if;

  update public.loan_orders
     set gmail_message_id = coalesce(nullif(trim(coalesce(p_gmail_message_id,'')),''), gmail_message_id),
         gmail_thread_id  = coalesce(nullif(trim(coalesce(p_gmail_thread_id,'')),''),  gmail_thread_id),
         rfc_message_id   = coalesce(nullif(trim(coalesce(p_rfc_message_id,'')),''),   rfc_message_id),
         voe_reply_token  = coalesce(nullif(trim(coalesce(p_reply_token,'')),''),      voe_reply_token)
   where id = p_order_id;
end;
$function$;
