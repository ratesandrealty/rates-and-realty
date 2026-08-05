-- partners_overview_all()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.partners_overview_all()
 RETURNS TABLE(id uuid, first_name text, last_name text, company text, title text, email text, phone text, status text, source_type text, tags text[], avatar_color text, referrals integer, won integer, lost integer, active integer, volume numeric, earnings numeric, last_activity_at timestamp without time zone, potential_volume numeric, potential_earnings numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.role() = 'authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
  return query
  select rp.id, rp.first_name, rp.last_name, rp.company, rp.title,
         rp.email, rp.phone, rp.status, rp.source_type, rp.tags, rp.avatar_color,
         count(c.id)::int,
         count(c.id) filter (where c.deal_outcome='won')::int,
         count(c.id) filter (where c.deal_outcome='lost')::int,
         count(c.id) filter (where coalesce(c.deal_outcome,'') not in ('won','lost'))::int,
         coalesce(sum(c.loan_amount) filter (where c.deal_outcome='won'),0),
         coalesce(sum(ce.actual_earnings) filter (where c.deal_outcome='won'),0),
         la.last_act,
         coalesce(sum(c.loan_amount) filter (where coalesce(c.deal_outcome,'') not in ('won','lost')),0),
         -- POTENTIAL EARNINGS: sum of the estimated_earnings entered per non-closed lead (no formula fallback)
         coalesce(sum(ce.estimated_earnings) filter (where coalesce(c.deal_outcome,'') not in ('won','lost')),0)
  from referral_partners rp
  left join contacts c on c.referral_partner_id = rp.id
  left join contact_earnings ce on ce.contact_id = c.id
  left join lateral (
    select max(ae.created_at) last_act from activity_events ae where ae.partner_id = rp.id
  ) la on true
  group by rp.id, rp.first_name, rp.last_name, rp.company, rp.title, rp.email, rp.phone,
           rp.status, rp.source_type, rp.tags, rp.avatar_color, la.last_act
  order by coalesce(sum(c.loan_amount) filter (where c.deal_outcome='won'),0) desc, count(c.id) desc;
end;
$function$;
