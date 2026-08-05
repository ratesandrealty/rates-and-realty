-- voe_prefill(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.voe_prefill(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.contacts; emp jsonb; lb public.loan_borrowers; broker jsonb;
declare hr_first text; hr_last text; hr_full text;
begin
  select * into c from public.contacts where id = p_contact_id;

  select e into emp
  from public.mortgage_applications ma
  cross join lateral jsonb_array_elements(
     case when jsonb_typeof(ma.employments::jsonb)='array' then ma.employments::jsonb else '[]'::jsonb end
  ) as e
  where ma.contact_id = p_contact_id
    and coalesce(e->>'type','current') = 'current'
    and coalesce(nullif(trim(e->>'employer'),''), '') <> ''
  order by ma.updated_at desc nulls last
  limit 1;

  select * into lb from public.loan_borrowers where contact_id = p_contact_id
    order by (is_self_employed is not true) desc, employer_name nulls last limit 1;

  select jsonb_build_object('name', signature_name, 'title', signature_title, 'phone', signature_phone,
    'nmls', signature_nmls, 'email', signature_email) into broker from public.email_settings limit 1;

  -- HR name: prefer explicit first/last in the JSON, else split the combined hr_contact/employer_hr_contact
  hr_full  := coalesce(nullif(trim(emp->>'hr_contact'),''), nullif(trim(emp->>'employer_hr_contact'),''), lb.employer_hr_contact);
  hr_first := coalesce(nullif(trim(emp->>'hr_first'),''), split_part(coalesce(hr_full,''),' ',1));
  hr_last  := coalesce(nullif(trim(emp->>'hr_last'),''),
              nullif(trim(substr(coalesce(hr_full,''), length(split_part(coalesce(hr_full,''),' ',1))+1)),''));

  return jsonb_build_object(
    'borrower_first', c.first_name,
    'borrower_last', c.last_name,
    'borrower_full', nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
    'employer_name', coalesce(nullif(trim(emp->>'employer'),''), lb.employer_name, c.employer_name),
    'employer_email', coalesce(nullif(trim(emp->>'employer_email'),''), lb.employer_email),
    'employer_phone', coalesce(nullif(trim(emp->>'phone'),''), lb.employer_phone),
    'hr_first', nullif(hr_first,''),
    'hr_last', hr_last,
    'hr_full', coalesce(hr_full, nullif(trim(coalesce(hr_first,'')||' '||coalesce(hr_last,'')),'')),
    'employer_address', coalesce(nullif(trim(concat_ws(', ', emp->>'street', emp->>'city', emp->>'state_zip')),''),
                                 nullif(trim(concat_ws(', ', lb.employer_street, lb.employer_city, lb.employer_state, lb.employer_zip)),'')),
    'position_title', coalesce(nullif(trim(emp->>'title'),''), lb.position_title),
    'employment_type', c.employment_type,
    'years_employed', coalesce(nullif(trim(emp->>'years_work'),''), c.years_employed::text),
    'address', coalesce(c.property_address, c.address),
    'broker', broker
  );
end; $function$;
