-- voe_request_sent(p_email_log_id uuid, p_order_id uuid, p_ok boolean, p_error text)
-- language: plpgsql
-- Captured from production 2026-08-06.

CREATE OR REPLACE FUNCTION public.voe_request_sent(p_email_log_id uuid, p_order_id uuid, p_ok boolean, p_error text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Record what the send ACTUALLY did. Called after email-service returns.
 * Success advances the order; failure leaves it exactly where it was, so an
 * order is never marked ordered for a request HR never received. */
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only'; end if;

  if p_ok then
    update public.email_log set status='sent', sent_at=now() where id = p_email_log_id;
    update public.loan_orders set
      status            = case when status in ('not_ordered','not_required') then 'ordered' else status end,
      ordered_at        = coalesce(ordered_at, now()),
      last_follow_up_at = now(),
      updated_at        = now()
    where id = p_order_id;
  else
    update public.email_log
       set status = 'failed',
           subject = coalesce(subject,'') || case when nullif(trim(coalesce(p_error,'')),'') is null
                       then '' else ' [send failed: '||left(p_error,180)||']' end
     where id = p_email_log_id;
  end if;
  return true;
end; $function$;
