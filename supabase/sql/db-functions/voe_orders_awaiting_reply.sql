-- voe_orders_awaiting_reply()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.voe_orders_awaiting_reply()
 RETURNS TABLE(order_id uuid, contact_id uuid, hr_contact_email text, voe_reply_token text, status text, ordered_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if not (
       public.is_admin()
       or v_role = 'service_role'
       or coalesce(public.current_app_role(), '') in ('va','loa','agent','staff')
     ) then
    raise exception 'not authorized';
  end if;

  return query
  select lo.id, lo.contact_id, lo.hr_contact_email, lo.voe_reply_token, lo.status, lo.ordered_at
  from public.loan_orders lo
  where lo.order_type = 'voe'
    and lo.voe_reply_token is not null
    and coalesce(lo.status,'') not in ('received','cancelled','not_required','not_ordered')
    and coalesce(lo.ordered_at, now()) > now() - interval '60 days'
  order by lo.ordered_at desc nulls last;
end;
$function$;
