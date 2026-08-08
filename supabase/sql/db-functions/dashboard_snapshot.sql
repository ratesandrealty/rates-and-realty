-- dashboard_snapshot()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-08. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.dashboard_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_escrow text[] := array['Processing','Under Contract','Clear to Close'];
  v_escrow_obj jsonb;
  v jsonb;
begin
  if auth.role()='authenticated' and not is_admin() then raise exception 'not authorized'; end if;

  with esc as (
    select c.id, c.first_name, c.last_name, c.pipeline_status, c.loan_type,
           coalesce(nullif(lower(trim(c.loan_purpose)),''), nullif(lower(trim(m.loan_purpose)),'')) as purpose
    from contacts c
    left join lateral (
      select loan_purpose from mortgage_applications ma
      where ma.contact_id = c.id order by ma.updated_at desc nulls last limit 1
    ) m on true
    where c.pipeline_status = any(v_escrow)
  )
  select jsonb_build_object(
    'total',     (select count(*) from esc),
    'purchase',  (select count(*) from esc where purpose = 'purchase'),
    'refinance', (select count(*) from esc where purpose like 'refi%'),
    'other',     (select count(*) from esc where purpose is null or (purpose <> 'purchase' and purpose not like 'refi%')),
    'list', (select coalesce(jsonb_agg(jsonb_build_object(
               'contact_id', id, 'name', nullif(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')),''),
               'stage', pipeline_status, 'purpose', purpose, 'loan_type', loan_type)
             order by array_position(v_escrow, pipeline_status)), '[]'::jsonb)
             from (select * from esc limit 50) z)
  ) into v_escrow_obj;

  select jsonb_build_object(
    'escrow', v_escrow_obj,
    'active_buyers', jsonb_build_object(
      'total', (select count(distinct s.contact_id) from showings s
                where s.contact_id is not null and coalesce(lower(s.status),'') <> 'cancelled'
                  and coalesce(s.preferred_date, s.created_at::date) >= current_date - 30),
      'list', (select coalesce(jsonb_agg(jsonb_build_object(
                 'contact_id', agg.contact_id,
                 'name', nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
                 'showings', agg.cnt, 'next_date', agg.nd) order by agg.nd nulls last), '[]'::jsonb)
               from (select s.contact_id, count(*) cnt,
                            min(s.preferred_date) filter (where s.preferred_date >= current_date) nd
                     from showings s
                     where s.contact_id is not null and coalesce(lower(s.status),'') <> 'cancelled'
                       and coalesce(s.preferred_date, s.created_at::date) >= current_date - 30
                     group by s.contact_id limit 50) agg
               join contacts c on c.id = agg.contact_id)
    ),
    'fee_sheets', jsonb_build_object(
      'total', (select count(distinct contact_id) from fee_sheet_drafts where contact_id is not null),
      'list', (select coalesce(jsonb_agg(jsonb_build_object(
                 'contact_id', c.id, 'name', nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
                 'stage', c.pipeline_status, 'updated_at', f.updated_at) order by f.updated_at desc), '[]'::jsonb)
               from (select distinct on (contact_id) contact_id, updated_at from fee_sheet_drafts
                     where contact_id is not null order by contact_id, updated_at desc limit 50) f
               join contacts c on c.id = f.contact_id)
    ),
    'preapproved', jsonb_build_object(
      'total', (select count(*) from contacts where pipeline_status = 'Pre-Approved'),
      'list', (select coalesce(jsonb_agg(jsonb_build_object(
                 'contact_id', c.id, 'name', nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
                 'purpose', c.loan_purpose, 'loan_type', c.loan_type) order by c.updated_at desc nulls last), '[]'::jsonb)
               from (select * from contacts where pipeline_status = 'Pre-Approved' limit 50) c)
    ),
    'follow_up', jsonb_build_object(
      'total', (select count(*) from contacts where pipeline_status = 'Follow Up'),
      'list', (select coalesce(jsonb_agg(jsonb_build_object(
                 'contact_id', c.id, 'name', nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
                 'loan_type', c.loan_type, 'last_contact_date', c.last_contact_date)
               order by c.last_contact_date asc nulls first), '[]'::jsonb)
               from (select * from contacts where pipeline_status = 'Follow Up'
                     order by last_contact_date asc nulls first limit 50) c)
    ),
    'generated_at', now()
  ) into v;
  return v;
end; $function$;
