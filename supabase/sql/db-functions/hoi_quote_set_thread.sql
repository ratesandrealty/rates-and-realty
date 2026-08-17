-- hoi_quote_set_thread(p_id uuid, p_gmail_message_id text, p_gmail_thread_id text, p_rfc_message_id text, p_reply_token text)
-- language: plpgsql
-- Captured from production 2026-08-17.

CREATE OR REPLACE FUNCTION public.hoi_quote_set_thread(p_id uuid, p_gmail_message_id text DEFAULT NULL::text, p_gmail_thread_id text DEFAULT NULL::text, p_rfc_message_id text DEFAULT NULL::text, p_reply_token text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Records what a send actually produced, immediately after gmail-inbox returns.
   Separate from hoi_quote_log rather than a third overload of it: that function
   already has two signatures and a third differing only by trailing optionals is
   how the wrong one gets resolved.

   rfc_message_id may legitimately arrive null — gmail-inbox returns null when
   its post-send read fails, meaning the mail went out but we cannot prove which
   header it carried. Storing the null is honest; the reply then falls to the
   token rung rather than matching a fabricated id. */
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only'; end if;

  update public.hoi_quote_requests
     set gmail_message_id = coalesce(nullif(trim(coalesce(p_gmail_message_id,'')),''), gmail_message_id),
         gmail_thread_id  = coalesce(nullif(trim(coalesce(p_gmail_thread_id,'')),''),  gmail_thread_id),
         rfc_message_id   = coalesce(nullif(trim(coalesce(p_rfc_message_id,'')),''),   rfc_message_id),
         reply_token      = coalesce(nullif(trim(coalesce(p_reply_token,'')),''),      reply_token),
         updated_at       = now()
   where id = p_id;
end;
$function$;
