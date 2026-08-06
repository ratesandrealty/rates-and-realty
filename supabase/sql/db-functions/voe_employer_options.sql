-- voe_employer_options(p_contact_id uuid)
-- language: plpgsql
-- Captured from production 2026-08-06.

CREATE OR REPLACE FUNCTION public.voe_employer_options(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Every employer on the file - CURRENT and PREVIOUS, every borrower - for the VOE
 * picker. Replaces the single arbitrary record voe_prefill() returns (it takes
 * type='current' ... order by updated_at desc limit 1).
 *
 * Previous employers are legitimate VOE targets: the 1003's 1d section exists
 * precisely for "less than 2 years at current", which is exactly when a lender
 * asks for one.
 *
 * FOUR STORES, none authoritative, all unioned:
 *   1. loan_borrowers      - per-borrower rows with contact_id + is_primary +
 *                            borrower_order. The ONLY store that attributes an
 *                            employer to a person. Carries current AND previous.
 *                            One live file has FOUR borrowers with four employers.
 *   2. employments JSONB   - primary borrower only (verified: a co-borrower's
 *                            employer never appears inside it). The ONLY store
 *                            holding HR NAME and EMAIL.
 *   3. flat employer_ and prev_employer_ columns - primary borrower.
 *   4. co_borrower_employer - the co-borrower, identified by the COLUMN.
 *
 * They disagree: of 10 applications with an employer, 4 are flat-only, 4 agree,
 * 1 is JSONB-only, and 1 DISAGREES outright (flat names one employer, the JSONB
 * another, both 'current'). So this never picks a winner - it returns every
 * distinct (person, employer, kind) and lets the human choose. Merging FIELDS
 * across sources is safe; merging IDENTITIES is not.
 *
 * SECURITY: security definer bypasses RLS, and borrowers hold portal accounts, so
 * this is restricted to staff via auth_user_roles. verify_jwt would not do it -
 * the anon key is a project-signed JWT and is printed in every page. */
declare
  v_apps uuid[];
  v_out  jsonb;
begin
  if auth.role() is distinct from 'service_role'
     and not exists (select 1 from auth_user_roles where user_id = auth.uid() and role in ('admin','va')) then
    raise exception 'not authorized';
  end if;

  select array_agg(distinct app) into v_apps from (
    select id            as app from mortgage_applications where contact_id = p_contact_id
    union
    select application_id     from loan_borrowers      where contact_id = p_contact_id and application_id is not null
  ) t where app is not null;

  if v_apps is null then return '[]'::jsonb; end if;

  with src as (
    select lb.application_id, lb.contact_id,
           coalesce(lb.is_primary,false) as is_primary,
           coalesce(lb.borrower_order, case when lb.is_primary then 1 else 99 end) as ord,
           coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)),''), lb.vesting_name) as person,
           trim(lb.employer_name) as employer, 'current' as kind,
           nullif(trim(lb.employer_phone),'') as phone,
           nullif(trim(lb.employer_email),'') as email,
           nullif(trim(lb.employer_hr_contact),'') as hr_full,
           nullif(trim(lb.position_title),'') as title,
           nullif(trim(concat_ws(', ', lb.employer_street, lb.employer_city, lb.employer_state, lb.employer_zip)),'') as addr,
           'loan_borrowers' as source
      from loan_borrowers lb left join contacts c on c.id = lb.contact_id
     where lb.application_id = any(v_apps) and nullif(trim(lb.employer_name),'') is not null
    union all
    select lb.application_id, lb.contact_id, coalesce(lb.is_primary,false),
           coalesce(lb.borrower_order, case when lb.is_primary then 1 else 99 end),
           coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)),''), lb.vesting_name),
           trim(lb.prev_employer_name), 'previous',
           null, null, null, nullif(trim(lb.prev_position_title),''), null, 'loan_borrowers.prev'
      from loan_borrowers lb left join contacts c on c.id = lb.contact_id
     where lb.application_id = any(v_apps) and nullif(trim(lb.prev_employer_name),'') is not null
    union all
    select ma.id, ma.contact_id, true, 1,
           coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)),''), 'Primary borrower'),
           trim(e.value->>'employer'),
           case when coalesce(e.value->>'type','current') = 'previous' then 'previous' else 'current' end,
           nullif(trim(e.value->>'phone'),''),
           nullif(trim(e.value->>'employer_email'),''),
           coalesce(nullif(trim(e.value->>'hr_contact'),''), nullif(trim(e.value->>'employer_hr_contact'),''),
                    nullif(trim(concat_ws(' ', e.value->>'hr_first', e.value->>'hr_last')),'')),
           nullif(trim(e.value->>'title'),''),
           nullif(trim(concat_ws(', ', e.value->>'street', e.value->>'city', e.value->>'state_zip')),''),
           'employments[]'
      from mortgage_applications ma
      left join contacts c on c.id = ma.contact_id,
           lateral jsonb_array_elements(case when jsonb_typeof(ma.employments)='array' then ma.employments else '[]'::jsonb end) e(value)
     where ma.id = any(v_apps) and nullif(trim(e.value->>'employer'),'') is not null
    union all
    select ma.id, ma.contact_id, true, 1,
           coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)),''), 'Primary borrower'),
           trim(ma.employer_name), 'current',
           nullif(trim(ma.employer_phone),''), null, null, null,
           nullif(trim(concat_ws(', ', ma.employer_street, ma.employer_city, ma.employer_state, ma.employer_zip)),''),
           'flat employer_name'
      from mortgage_applications ma left join contacts c on c.id = ma.contact_id
     where ma.id = any(v_apps) and nullif(trim(ma.employer_name),'') is not null
    union all
    select ma.id, ma.contact_id, true, 1,
           coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)),''), 'Primary borrower'),
           trim(ma.prev_employer_name), 'previous',
           nullif(trim(ma.prev_employer_phone),''), null, null, null,
           nullif(trim(concat_ws(', ', ma.prev_employer_street, ma.prev_employer_city, ma.prev_employer_state, ma.prev_employer_zip)),''),
           'flat prev_employer_name'
      from mortgage_applications ma left join contacts c on c.id = ma.contact_id
     where ma.id = any(v_apps) and nullif(trim(ma.prev_employer_name),'') is not null
    union all
    select ma.id, ma.co_borrower_contact_id, false, 2,
           coalesce(nullif(trim(concat_ws(' ', ma.co_borrower_first_name, ma.co_borrower_last_name)),''), 'Co-borrower'),
           trim(ma.co_borrower_employer), 'current',
           nullif(trim(ma.co_borrower_employer_phone),''), null, null,
           nullif(trim(ma.co_borrower_title),''), null, 'flat co_borrower_employer'
      from mortgage_applications ma
     where ma.id = any(v_apps) and nullif(trim(ma.co_borrower_employer),'') is not null
  ),
  merged as (
    select lower(coalesce(person,'')) as person_key, lower(employer) as employer_key, kind,
           min(person) as person, min(employer) as employer,
           bool_or(is_primary) as is_primary, min(ord) as ord,
           max(contact_id::text) as contact_id,
           max(phone) as phone, max(email) as email, max(hr_full) as hr_full,
           max(title) as title, max(addr) as addr,
           string_agg(distinct source, ' + ') as sources
      from src group by 1,2,3
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'person', person, 'is_primary', is_primary,
           'role', case when is_primary then 'primary' else 'co-borrower' end,
           'employer', employer, 'kind', kind,
           'hr_first', nullif(split_part(coalesce(hr_full,''),' ',1),''),
           'hr_last',  nullif(trim(substr(coalesce(hr_full,''), length(split_part(coalesce(hr_full,''),' ',1))+1)),''),
           'hr_full', hr_full, 'employer_email', email, 'employer_phone', phone,
           'position_title', title, 'employer_address', addr,
           'contact_id', contact_id, 'sources', sources,
           'label', person || ' (' || (case when is_primary then 'primary' else 'co-borrower' end) || ') - ' || employer || ' (' || kind || ')'
         ) order by is_primary desc, ord, person, (kind='previous'), employer), '[]'::jsonb)
    into v_out from merged;

  return v_out;
end; $function$;
