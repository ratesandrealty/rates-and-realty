-- esign_merge_resolve(p_contact_id uuid, p_lender_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.esign_merge_resolve(p_contact_id uuid, p_lender_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_app record;
  v_contact record;
  v_lender public.lenders%rowtype;
  v_settings record;
  v_lender_id uuid;
  v_has_lender boolean := false;
  v_borrower text;
  v_coborrower text;
  v_prop text;
  v_lender_addr text;
  v_emp_addr text;
  v_emp2_addr text;
  v_map jsonb;
  v_bmap jsonb := '{}'::jsonb;
  b record;
  v_bname text;
  v_baddr text;
  v_n int;
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not (is_admin() or coalesce(current_app_role(),'') in ('va','loa','agent','lender','staff')) then
    raise exception 'not authorized';
  end if;

  select * into v_contact from contacts where id = p_contact_id;
  select * into v_app from mortgage_applications
  where contact_id = p_contact_id order by updated_at desc nulls last, created_at desc limit 1;
  select * into v_settings from esign_merge_settings where key = 'default';

  v_lender_id := coalesce(p_lender_id, v_app.assigned_lender_id, v_settings.default_lender_id);
  if v_lender_id is not null then
    select * into v_lender from lenders where id = v_lender_id;
    v_has_lender := found;
  end if;

  v_borrower := nullif(trim(coalesce(v_app.first_name,'') || ' ' ||
                              coalesce(v_app.middle_name,'') || ' ' ||
                              coalesce(v_app.last_name,'')), '');
  if v_borrower is null then
    v_borrower := nullif(trim(coalesce(v_contact.first_name,'') || ' ' || coalesce(v_contact.last_name,'')), '');
  end if;
  v_coborrower := nullif(trim(coalesce(v_app.co_borrower_first_name,'') || ' ' || coalesce(v_app.co_borrower_last_name,'')), '');

  v_prop := nullif(trim(concat_ws(', ',
    coalesce(nullif(v_app.property_address_street,''), nullif(v_app.property_address,'')),
    v_app.property_address_city, v_app.property_address_state, v_app.property_address_zip)), '');

  if v_has_lender then
    v_lender_addr := nullif(trim(concat_ws(', ',
      v_lender.physical_address, v_lender.physical_city, v_lender.physical_state, v_lender.physical_zip)), '');
  end if;

  v_emp_addr := nullif(trim(concat_ws(', ',
    v_app.employer_street, v_app.employer_city, v_app.employer_state, v_app.employer_zip)), '');
  v_emp2_addr := nullif(trim(concat_ws(', ',
    v_app.employer2_street, v_app.employer2_city, v_app.employer2_state, v_app.employer2_zip)), '');

  if v_app.id is not null then
    for b in
      select lb.*, c.first_name as c_first, c.last_name as c_last, c.email as c_email, c.phone as c_phone
      from loan_borrowers lb
      left join contacts c on c.id = lb.contact_id
      where lb.application_id = v_app.id
      order by coalesce(lb.borrower_order, 999), lb.created_at
      limit 4
    loop
      v_n := coalesce(b.borrower_order, 0);
      if v_n < 1 or v_n > 4 then continue; end if;
      v_bname := nullif(trim(coalesce(b.vesting_name, coalesce(b.c_first,'') || ' ' || coalesce(b.c_last,''))), '');
      v_baddr := nullif(trim(concat_ws(', ', b.employer_street, b.employer_city, b.employer_state, b.employer_zip)), '');
      v_bmap := v_bmap || jsonb_strip_nulls(jsonb_build_object(
        'borrower'||v_n||'_name', v_bname,
        'borrower'||v_n||'_email', b.c_email,
        'borrower'||v_n||'_phone', b.c_phone,
        'borrower'||v_n||'_employer_name', b.employer_name,
        'borrower'||v_n||'_employer_phone', b.employer_phone,
        'borrower'||v_n||'_employer_address', v_baddr,
        'borrower'||v_n||'_position_title', b.position_title,
        'borrower'||v_n||'_employment_start_date', case when b.employment_start_date is not null then to_char(b.employment_start_date,'MM/DD/YYYY') else null end
      ));
    end loop;
  end if;

  v_map := jsonb_strip_nulls(jsonb_build_object(
    'borrower_name', v_borrower,
    'co_borrower_name', v_coborrower,
    'borrower_email', coalesce(v_app.email, v_app.borrower_email, v_contact.email),
    'borrower_phone', coalesce(v_app.cell_phone, v_contact.phone),
    'property_address', v_prop,
    'loan_number', v_app.loan_number,
    'loan_amount', case when v_app.loan_amount is not null then '$'||to_char(v_app.loan_amount,'FM999,999,999') else null end,
    'loan_type', coalesce(v_app.loan_type, v_contact.loan_type),
    'loan_purpose', v_app.loan_purpose,
    'purchase_price', case when v_app.purchase_price is not null then '$'||to_char(v_app.purchase_price,'FM999,999,999') else null end,
    'employer_name', v_app.employer_name,
    'employer_phone', v_app.employer_phone,
    'employer_address', v_emp_addr,
    'employer_street', v_app.employer_street,
    'employer_city', v_app.employer_city,
    'employer_state', v_app.employer_state,
    'employer_zip', v_app.employer_zip,
    'position_title', v_app.position_title,
    'employment_start_date', case when v_app.employment_start_date is not null then to_char(v_app.employment_start_date,'MM/DD/YYYY') else null end,
    'employer2_name', v_app.employer2_name,
    'employer2_phone', v_app.employer2_phone,
    'employer2_address', v_emp2_addr,
    'position2_title', v_app.position2_title,
    'co_borrower_employer', v_app.co_borrower_employer,
    'co_borrower_employer_phone', v_app.co_borrower_employer_phone,
    'co_borrower_title', v_app.co_borrower_title,
    'lender_name', v_lender.name,
    'lender_nmls', v_lender.nmlsr_id,
    'lender_address', v_lender_addr,
    'mortgagee_clause', coalesce(v_lender.mortgagee_clause, v_settings.default_mortgagee_clause),
    'cpl_clause', v_lender.cpl_clause,
    'lo_name', coalesce(v_settings.lo_name, v_app.lo_name),
    'lo_nmls', coalesce(v_settings.lo_nmls, v_app.lo_nmls, v_app.lo_nmls_id),
    'lo_company', coalesce(v_settings.lo_company, v_app.lo_org, v_app.lo_org_name),
    'lo_company_nmls', coalesce(v_settings.lo_company_nmls, v_app.lo_org_nmls),
    'today', to_char(now() at time zone 'America/Los_Angeles', 'Mon DD, YYYY')
  ));

  v_map := v_map || v_bmap;

  return jsonb_build_object(
    'ok', true,
    'contact_id', p_contact_id,
    'has_snapshot', v_app.id is not null,
    'borrower_count', (select count(*) from loan_borrowers where application_id = v_app.id),
    'lender_id', v_lender_id,
    'lender_name', v_lender.name,
    'merge', v_map
  );
end; $function$;
