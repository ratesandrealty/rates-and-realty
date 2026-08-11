-- power_dialer_queue(p_filter text, p_stage text, p_partner_id uuid, p_limit integer, p_offset integer, p_source text, p_tag_ids uuid[], p_callable_only boolean, p_min_loan numeric, p_sort text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.power_dialer_queue(p_filter text DEFAULT 'all'::text, p_stage text DEFAULT NULL::text, p_partner_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 75, p_offset integer DEFAULT 0, p_source text DEFAULT NULL::text, p_tag_ids uuid[] DEFAULT NULL::uuid[], p_callable_only boolean DEFAULT false, p_min_loan numeric DEFAULT NULL::numeric, p_sort text DEFAULT 'priority'::text)
 RETURNS TABLE(contact_id uuid, name text, email text, phone text, stage text, source text, loan_amount numeric, potential_earnings numeric, partner_name text, created_at timestamp without time zone, last_activity_at timestamp without time zone, next_followup_at timestamp with time zone, days_since integer, bucket text, tz text, local_time text, callable_now boolean, tz_assumed boolean, tags jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_filter text := lower(coalesce(p_filter,'all'));
        v_sort text := lower(coalesce(p_sort,'priority'));
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not public.is_admin() then raise exception 'admin only'; end if;
  return query
  with la as (
    select ae.contact_id, max(ae.created_at) last_act
    from activity_events ae where ae.contact_id is not null group by ae.contact_id
  ),
  base as (
    select c.id,
           nullif(trim(
             coalesce(case when lower(coalesce(c.first_name,'')) in ('none','null','n/a','na','-') then '' else c.first_name end,'')
             ||' '||
             coalesce(case when lower(coalesce(c.last_name,''))  in ('none','null','n/a','na','-') then '' else c.last_name  end,'')
           ),'') nm,
           c.email, c.phone,
           coalesce(nullif(c.pipeline_status,''), nullif(c.lead_status,'')) stage,
           c.source, c.loan_amount,
           case when coalesce(c.deal_outcome,'') not in ('won','lost')
                then coalesce(nullif(ce.estimated_earnings,0), c.loan_amount*0.015) else 0 end pot_earn,
           nullif(trim(coalesce(rp.first_name,'')||' '||coalesce(rp.last_name,'')),'') partner_nm,
           c.created_at::timestamp ca, la.last_act::timestamp lact, c.next_followup_at nfu,
           case when length(regexp_replace(coalesce(c.phone,''),'\D','','g'))=11 and left(regexp_replace(coalesce(c.phone,''),'\D','','g'),1)='1'
                  then substr(regexp_replace(coalesce(c.phone,''),'\D','','g'),2,3)
                when length(regexp_replace(coalesce(c.phone,''),'\D','','g'))=10
                  then left(regexp_replace(coalesce(c.phone,''),'\D','','g'),3) else null end ac
    from (select * from contacts where merged_into_contact_id is null) c
    left join la on la.contact_id = c.id
    left join contact_earnings ce on ce.contact_id = c.id
    left join referral_partners rp on rp.id = c.referral_partner_id
    where coalesce(c.deal_outcome,'') not in ('won','lost')
      and coalesce(c.pipeline_status,'') <> 'Closed'
      and coalesce(c.phone,'') <> ''
      and coalesce(c.is_co_borrower,false) = false
      and c.do_not_call = false
      and (p_partner_id is null or c.referral_partner_id = p_partner_id)
      and (p_source is null or c.source = p_source)
      and (p_min_loan is null or coalesce(c.loan_amount,0) >= p_min_loan)
      and (p_tag_ids is null or exists (
            select 1 from contact_tags ct where ct.contact_id = c.id and ct.tag_id = any(p_tag_ids)))
  ),
  z as (
    select b.*, coalesce(act.tz,'America/Los_Angeles') ztz, (act.tz is null) zassumed
    from base b left join area_code_timezones act on act.area_code = b.ac
  ),
  tagged as (
    select z.*,
      case
        when z.nfu is not null and z.nfu < (current_date + 1)::timestamptz then 'due'
        when z.nfu is not null then 'scheduled'
        when z.lact is null then 'new'
        else 'stale'
      end as bucket,
      to_char(now() at time zone z.ztz, 'HH12:MI AM') ltime,
      (extract(hour from (now() at time zone z.ztz)) >= 8 and extract(hour from (now() at time zone z.ztz)) < 21) callable
    from z
  )
  select t.id,
         coalesce(t.nm, nullif(split_part(coalesce(t.email,''),'@',1),''), 'Lead'),
         t.email, t.phone, t.stage, t.source, t.loan_amount, t.pot_earn, t.partner_nm,
         t.ca, t.lact, t.nfu,
         case when t.lact is null then 9999 else floor(extract(epoch from (now()-t.lact))/86400)::int end,
         t.bucket, t.ztz, t.ltime, t.callable, t.zassumed,
         coalesce((select jsonb_agg(jsonb_build_object('id',tg.id,'name',tg.name,'color',tg.color) order by tg.name)
                   from contact_tags ct join tags tg on tg.id=ct.tag_id where ct.contact_id=t.id), '[]'::jsonb)
  from tagged t
  where (v_filter = 'all'
         or (v_filter = 'due'       and t.bucket = 'due')
         or (v_filter = 'new'       and t.bucket = 'new')
         or (v_filter = 'stale'     and t.bucket in ('stale','new'))
         or (v_filter = 'scheduled' and t.bucket = 'scheduled'))
    and (p_stage is null or t.stage = p_stage)
    and (not coalesce(p_callable_only,false) or t.callable)
  order by
    case when v_sort='priority' then (case t.bucket when 'due' then 0 when 'new' then 1 when 'stale' then 2 when 'scheduled' then 3 else 4 end) end asc nulls last,
    case when v_sort='value' then t.pot_earn end desc nulls last,
    case when v_sort='loan'  then t.loan_amount end desc nulls last,
    case when v_sort='recent' then t.ca end desc nulls last,
    case when v_sort='oldest' then t.ca end asc nulls last,
    case when v_sort='priority' then coalesce(t.nfu, t.lact::timestamptz, t.ca::timestamptz) end asc nulls last
  limit greatest(1, least(coalesce(p_limit,75), 200))
  offset greatest(0, coalesce(p_offset,0));
end;
$function$;
