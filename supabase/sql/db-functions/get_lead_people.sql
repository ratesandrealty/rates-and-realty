-- get_lead_people(p_contact_id uuid, p_application_id uuid)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.get_lead_people(p_contact_id uuid, p_application_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(contact_id uuid, first_name text, middle_name text, last_name text, full_name text, email text, phone text, secondary_phone text, date_of_birth date, ssn_last4 text, role_label text, is_primary boolean, is_borrower boolean, is_owner boolean, borrower_order integer, source text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
with app as (
  select
    coalesce(
      p_application_id,
      (select id from mortgage_applications
        where contact_id = p_contact_id
        order by created_at desc nulls last limit 1)
    ) as application_id,
    p_contact_id as subject_id
),
appmeta as (
  select a.application_id, a.subject_id, ma.contact_id as owner_id, ma.co_borrower_contact_id
  from app a left join mortgage_applications ma on ma.id = a.application_id
),
raw as (
  select (select subject_id from app) as contact_id, 'subject'::text as source,
         null::text as rel_role, null::text as lb_role, null::int as borrower_order, false as lb_is_primary
  union all
  select lb.contact_id, 'loan_borrower', null, lb.borrower_role, lb.borrower_order, coalesce(lb.is_primary,false)
  from loan_borrowers lb, app
  where lb.application_id = app.application_id and lb.contact_id is not null
  union all
  select case when cr.contact_id = (select subject_id from app)
              then cr.related_contact_id else cr.contact_id end,
         'relationship', cr.relationship_type, null, null, false
  from contact_relationships cr
  where cr.contact_id = (select subject_id from app)
     or cr.related_contact_id = (select subject_id from app)
  union all
  select am.co_borrower_contact_id, 'app_coborrower', null, 'CoBorrower', 2, false
  from appmeta am where am.co_borrower_contact_id is not null
),
agg as (
  select r.contact_id,
    bool_or(r.source = 'loan_borrower') as in_lb,
    bool_or(r.lb_is_primary)            as lb_primary,
    min(r.borrower_order)               as borrower_order,
    max(r.lb_role)                      as lb_role,
    max(r.rel_role)                     as rel_role,
    string_agg(distinct r.source, ',')  as source
  from raw r
  where r.contact_id is not null
  group by r.contact_id
)
select
  c.id as contact_id, c.first_name, c.middle_name, c.last_name,
  nullif(trim(concat_ws(' ', c.first_name, c.middle_name, c.last_name)), '') as full_name,
  c.email, c.phone, c.secondary_phone, c.date_of_birth, c.ssn_last4,
  case
    when c.id = (select subject_id from app) then 'Primary'
    when a.lb_primary then 'Primary'
    when a.lb_role is not null then a.lb_role
    when a.rel_role is not null then initcap(a.rel_role)
    else 'Connected'
  end as role_label,
  (c.id = (select subject_id from app) or a.lb_primary or c.id = (select owner_id from appmeta)) as is_primary,
  a.in_lb as is_borrower,
  (c.id = (select owner_id from appmeta)) as is_owner,
  a.borrower_order,
  a.source
from agg a
join contacts c on c.id = a.contact_id
order by
  (c.id = (select subject_id from app)) desc,
  a.in_lb desc,
  a.borrower_order nulls last,
  full_name;
$function$;
