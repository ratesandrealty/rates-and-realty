-- partner_leads(p_partner_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.partner_leads(p_partner_id uuid)
 RETURNS TABLE(contact_id uuid, name text, email text, phone text, stage text, deal_outcome text, loan_amount numeric, estimated_earnings numeric, created_at timestamp without time zone, last_activity_at timestamp without time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not public.is_admin() then raise exception 'admin only'; end if;
  return query
  select c.id,
         nullif(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')), ''),
         c.email, c.phone,
         coalesce(nullif(c.pipeline_status,''), nullif(c.lead_status,'')),
         c.deal_outcome, c.loan_amount,
         coalesce(ce.estimated_earnings, 0) as estimated_earnings,
         c.created_at::timestamp,
         (select max(ae.created_at) from activity_events ae where ae.contact_id = c.id)::timestamp
  from public.contacts_live c
  left join contact_earnings ce on ce.contact_id = c.id
  where c.referral_partner_id = p_partner_id
  order by c.created_at desc nulls last;
end;
$function$;
