-- loe_queue()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.loe_queue()
 RETURNS TABLE(id uuid, contact_id uuid, application_id uuid, borrower_name text, topic text, category text, title text, status text, envelope_id uuid, created_at timestamp with time zone, sent_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then raise exception 'admin only'; end if;
  return query
  select l.id, l.contact_id, l.application_id,
         trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')) as borrower_name,
         l.topic, l.category, l.title, l.status, l.envelope_id, l.created_at, l.sent_at
  from public.loe_requests l
  left join public.contacts c on c.id = l.contact_id
  where coalesce(l.status,'') not in ('signed','voided')
  order by l.created_at desc;
end; $function$;
