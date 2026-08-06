-- share_nudges_pending()
-- language: plpgsql
-- Captured from production 2026-08-06.

CREATE OR REPLACE FUNCTION public.share_nudges_pending()
 RETURNS TABLE(contact_id uuid, lead_name text, order_label text, notified_at timestamp with time zone, quiet boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Nudges still awaiting a decision: not dismissed, and the lead is STILL
 * unshared. The share check is re-evaluated live rather than trusted from a
 * flag, so sharing from anywhere -- the lead-detail toggle, the popup, a direct
 * write -- makes the nudge disappear without anything having to remember to
 * clear it.
 *
 * `quiet` tells the caller whether it is currently inside the recipient's quiet
 * hours. The bell row is written regardless (it is silent); this is what lets
 * the POPUP hold off without the nudge being lost. */
begin
  if not exists (select 1 from auth_user_roles r where r.user_id = auth.uid() and r.role = 'admin') then
    return;   -- not an admin: no rows, not an error
  end if;

  return query
  select n.contact_id,
         coalesce(nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''), 'this lead'),
         coalesce(nullif(trim(o.label),''), upper(o.order_type), 'An order'),
         n.notified_at,
         is_quiet_hours(auth.uid(), now())
    from lead_share_nudges n
    left join contacts c    on c.id = n.contact_id
    left join loan_orders o on o.id = n.first_order_id
   where n.dismissed_at is null
     and not exists (select 1 from lead_shares s where s.contact_id = n.contact_id)
   order by n.notified_at desc;
end; $function$;
