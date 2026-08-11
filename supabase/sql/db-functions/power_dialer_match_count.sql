-- power_dialer_match_count(p_filter text, p_stage text, p_partner_id uuid, p_source text, p_tag_ids uuid[], p_callable_only boolean, p_min_loan numeric)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.power_dialer_match_count(p_filter text DEFAULT 'all'::text, p_stage text DEFAULT NULL::text, p_partner_id uuid DEFAULT NULL::uuid, p_source text DEFAULT NULL::text, p_tag_ids uuid[] DEFAULT NULL::uuid[], p_callable_only boolean DEFAULT false, p_min_loan numeric DEFAULT NULL::numeric)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_filter text := lower(coalesce(p_filter,'all')); v_n int;
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not public.is_admin() then raise exception 'admin only'; end if;
  with la as (
    select ae.contact_id, max(ae.created_at) last_act
    from activity_events ae where ae.contact_id is not null group by ae.contact_id
  ),
  base as (
    select c.id,
           coalesce(nullif(c.pipeline_status,''), nullif(c.lead_status,'')) stage,
           c.next_followup_at nfu, la.last_act,
           case when length(regexp_replace(coalesce(c.phone,''),'\D','','g'))=11 and left(regexp_replace(coalesce(c.phone,''),'\D','','g'),1)='1'
                  then substr(regexp_replace(coalesce(c.phone,''),'\D','','g'),2,3)
                when length(regexp_replace(coalesce(c.phone,''),'\D','','g'))=10
                  then left(regexp_replace(coalesce(c.phone,''),'\D','','g'),3) else null end ac
    from contacts c left join la on la.contact_id=c.id
    where coalesce(c.deal_outcome,'') not in ('won','lost')
      and coalesce(c.pipeline_status,'') <> 'Closed'
      and coalesce(c.phone,'') <> '' and coalesce(c.is_co_borrower,false)=false and c.do_not_call=false
      and (p_partner_id is null or c.referral_partner_id = p_partner_id)
      and (p_source is null or c.source = p_source)
      and (p_min_loan is null or coalesce(c.loan_amount,0) >= p_min_loan)
      and (p_tag_ids is null or exists (select 1 from contact_tags ct where ct.contact_id=c.id and ct.tag_id = any(p_tag_ids)))
  ),
  tagged as (
    select b.*,
      case when b.nfu is not null and b.nfu < (current_date+1)::timestamptz then 'due'
           when b.nfu is not null then 'scheduled'
           when b.last_act is null then 'new' else 'stale' end bucket,
      (extract(hour from (now() at time zone coalesce(act.tz,'America/Los_Angeles'))) >= 8
        and extract(hour from (now() at time zone coalesce(act.tz,'America/Los_Angeles'))) < 21) callable
    from base b left join area_code_timezones act on act.area_code=b.ac
  )
  select count(*) into v_n from tagged t
  where (v_filter='all'
         or (v_filter='due' and t.bucket='due')
         or (v_filter='new' and t.bucket='new')
         or (v_filter='stale' and t.bucket in ('stale','new'))
         or (v_filter='scheduled' and t.bucket='scheduled'))
    and (p_stage is null or t.stage = p_stage)
    and (not coalesce(p_callable_only,false) or t.callable);
  return v_n;
end;
$function$;
