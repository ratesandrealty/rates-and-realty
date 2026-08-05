-- partners_needing_followup(p_days integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.partners_needing_followup(p_days integer DEFAULT 21)
 RETURNS TABLE(id uuid, name text, email text, phone text, referrals integer, active integer, last_activity_at timestamp without time zone, days_since integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.role()='authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
  return query
  with base as (
    select rp.id,
           nullif(trim(coalesce(rp.first_name,'')||' '||coalesce(rp.last_name,'')),'') nm,
           rp.email, rp.phone,
           count(c.id)::int refs,
           count(c.id) filter (where coalesce(c.deal_outcome,'') not in ('won','lost'))::int act,
           (select max(ae.created_at) from activity_events ae where ae.partner_id = rp.id) last_act
    from referral_partners rp
    left join contacts c on c.referral_partner_id = rp.id
    group by rp.id, rp.first_name, rp.last_name, rp.email, rp.phone
  )
  select b.id, b.nm, b.email, b.phone, b.refs, b.act, b.last_act::timestamp,
         case when b.last_act is null then 9999
              else floor(extract(epoch from (now()-b.last_act))/86400)::int end
  from base b
  where b.refs > 0
    and (b.last_act is null or b.last_act < now() - (p_days || ' days')::interval)
  order by b.refs desc, last_act asc nulls first;
end;
$function$;
