-- apply_1003_fields(p_fields jsonb, p_application_id uuid, p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.apply_1003_fields(p_fields jsonb, p_application_id uuid DEFAULT NULL::uuid, p_contact_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text; v_app_id uuid; k text; sets text := ''; v_applied text[] := '{}'; v_created boolean := false;
  allowed text[] := array[
    'first_name','middle_name','last_name','suffix','ssn','date_of_birth','marital_status','citizenship',
    'home_phone','cell_phone','email',
    'current_address_street','current_address_unit','current_address_city','current_address_state','current_address_zip',
    'dl_number','dl_state','dl_expiry',
    'employer_name','employer_phone','employer_street','employer_city','employer_state','employer_zip',
    'position_title','employment_start_date','is_self_employed',
    'base_income','overtime_income','bonus_income','commission_income','total_monthly_income',
    'property_address_street','property_address_city','property_address_state','property_address_zip',
    'purchase_price','property_value','credit_score'
  ];
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;

  v_app_id := p_application_id;
  if v_app_id is null and p_contact_id is not null then
    select id into v_app_id from public.mortgage_applications
     where contact_id = p_contact_id order by created_at desc limit 1;
    -- auto-create the 1003 for this contact if none exists yet
    if v_app_id is null then
      insert into public.mortgage_applications(contact_id, created_at, updated_at)
      values(p_contact_id, now(), now())
      returning id into v_app_id;
      v_created := true;
    end if;
  end if;
  if v_app_id is null then raise exception 'no application and no contact given'; end if;

  for k in select jsonb_object_keys(p_fields) loop
    if k = any(allowed)
       and p_fields->k is not null
       and jsonb_typeof(p_fields->k) <> 'null'
       and nullif(trim(p_fields->>k),'') is not null then
      sets := sets || format('%I = %L, ', k, p_fields->>k);
      v_applied := v_applied || k;
    end if;
  end loop;

  if sets <> '' then
    execute format('update public.mortgage_applications set %s updated_at = now() where id = %L',
                   sets, v_app_id);
  end if;

  return jsonb_build_object('applied', coalesce(array_length(v_applied,1),0),
                            'fields', v_applied, 'application_id', v_app_id,
                            'created_application', v_created);
end; $function$;
