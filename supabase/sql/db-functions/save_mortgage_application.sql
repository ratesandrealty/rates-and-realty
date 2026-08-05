-- save_mortgage_application(p_email text, p_borrower_id text, p_borrower_user_id uuid, p_data jsonb)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.save_mortgage_application(p_email text, p_borrower_id text DEFAULT NULL::text, p_borrower_user_id uuid DEFAULT NULL::uuid, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_app_id uuid;
  v_is_new boolean := false;
  v_update_data jsonb;
BEGIN
  SELECT id INTO v_app_id FROM mortgage_applications
    WHERE email = p_email OR borrower_email = p_email
    ORDER BY updated_at DESC NULLS LAST LIMIT 1;

  IF v_app_id IS NULL AND p_borrower_id IS NOT NULL THEN
    SELECT id INTO v_app_id FROM mortgage_applications
      WHERE borrower_id = p_borrower_id
      ORDER BY updated_at DESC NULLS LAST LIMIT 1;
  END IF;

  IF v_app_id IS NULL AND p_borrower_user_id IS NOT NULL THEN
    SELECT id INTO v_app_id FROM mortgage_applications
      WHERE borrower_user_id = p_borrower_user_id
      ORDER BY updated_at DESC NULLS LAST LIMIT 1;
  END IF;

  v_update_data := p_data;

  IF v_app_id IS NOT NULL THEN
    UPDATE mortgage_applications SET
      first_name = COALESCE((v_update_data->>'first_name'), first_name),
      middle_name = COALESCE((v_update_data->>'middle_name'), middle_name),
      last_name = COALESCE((v_update_data->>'last_name'), last_name),
      suffix = COALESCE((v_update_data->>'suffix'), suffix),
      date_of_birth = COALESCE(NULLIF(v_update_data->>'date_of_birth','')::date, date_of_birth),
      marital_status = COALESCE((v_update_data->>'marital_status'), marital_status),
      citizenship = COALESCE((v_update_data->>'citizenship'), citizenship),
      cell_phone = COALESCE((v_update_data->>'cell_phone'), cell_phone),
      home_phone = COALESCE((v_update_data->>'home_phone'), home_phone),
      work_phone = COALESCE((v_update_data->>'work_phone'), work_phone),
      dl_number = COALESCE((v_update_data->>'dl_number'), dl_number),
      dl_state = COALESCE((v_update_data->>'dl_state'), dl_state),
      current_address_street = COALESCE((v_update_data->>'current_address_street'), current_address_street),
      current_address_unit = COALESCE((v_update_data->>'current_address_unit'), current_address_unit),
      current_address_city = COALESCE((v_update_data->>'current_address_city'), current_address_city),
      current_address_state = COALESCE((v_update_data->>'current_address_state'), current_address_state),
      current_address_zip = COALESCE((v_update_data->>'current_address_zip'), current_address_zip),
      current_housing_type = COALESCE((v_update_data->>'current_housing_type'), current_housing_type),
      current_address_years = COALESCE((v_update_data->>'current_address_years')::int, current_address_years),
      current_rent_amount = COALESCE((v_update_data->>'current_rent_amount')::numeric, current_rent_amount),
      employer_name = COALESCE((v_update_data->>'employer_name'), employer_name),
      employer_phone = COALESCE((v_update_data->>'employer_phone'), employer_phone),
      employer_street = COALESCE((v_update_data->>'employer_street'), employer_street),
      employer_city = COALESCE((v_update_data->>'employer_city'), employer_city),
      employer_state = COALESCE((v_update_data->>'employer_state'), employer_state),
      employer_zip = COALESCE((v_update_data->>'employer_zip'), employer_zip),
      position_title = COALESCE((v_update_data->>'position_title'), position_title),
      employment_start_date = COALESCE(NULLIF(v_update_data->>'employment_start_date','')::date, employment_start_date),
      is_self_employed = COALESCE((v_update_data->>'is_self_employed')::boolean, is_self_employed),
      base_income = COALESCE((v_update_data->>'base_income')::numeric, base_income),
      overtime_income = COALESCE((v_update_data->>'overtime_income')::numeric, overtime_income),
      bonus_income = COALESCE((v_update_data->>'bonus_income')::numeric, bonus_income),
      commission_income = COALESCE((v_update_data->>'commission_income')::numeric, commission_income),
      loan_purpose = COALESCE((v_update_data->>'loan_purpose'), loan_purpose),
      loan_type = COALESCE((v_update_data->>'loan_type'), loan_type),
      property_address_street = COALESCE((v_update_data->>'property_address_street'), property_address_street),
      property_address_city = COALESCE((v_update_data->>'property_address_city'), property_address_city),
      property_address_state = COALESCE((v_update_data->>'property_address_state'), property_address_state),
      property_address_zip = COALESCE((v_update_data->>'property_address_zip'), property_address_zip),
      purchase_price = COALESCE((v_update_data->>'purchase_price')::numeric, purchase_price),
      requested_loan_amount = COALESCE((v_update_data->>'requested_loan_amount')::numeric, requested_loan_amount),
      remaining_loan_balance = COALESCE((v_update_data->>'remaining_loan_balance')::numeric, remaining_loan_balance),
      borrower_type = COALESCE((v_update_data->>'borrower_type'), borrower_type),
      occupancy_type = COALESCE((v_update_data->>'occupancy_type'), occupancy_type),
      monthly_debt = COALESCE((v_update_data->>'monthly_debt')::numeric, monthly_debt),
      bank_accounts = COALESCE((v_update_data->>'bank_accounts')::jsonb, bank_accounts),
      decl_primary_residence = COALESCE((v_update_data->>'decl_primary_residence')::boolean, decl_primary_residence),
      decl_foreclosure = COALESCE((v_update_data->>'decl_foreclosure')::boolean, decl_foreclosure),
      decl_bankruptcy = COALESCE((v_update_data->>'decl_bankruptcy')::boolean, decl_bankruptcy),
      decl_lawsuit = COALESCE((v_update_data->>'decl_lawsuit')::boolean, decl_lawsuit),
      decl_delinquent_federal = COALESCE((v_update_data->>'decl_delinquent_federal')::boolean, decl_delinquent_federal),
      former_addresses = COALESCE((v_update_data->>'former_addresses')::jsonb, former_addresses),
      employments = COALESCE((v_update_data->>'employments')::jsonb, employments),
      borrower_id = COALESCE(p_borrower_id, borrower_id),
      borrower_user_id = COALESCE(p_borrower_user_id, borrower_user_id),
      updated_at = NOW()
    WHERE id = v_app_id;
  ELSE
    v_is_new := true;
    INSERT INTO mortgage_applications (
      email, borrower_email, borrower_id, borrower_user_id,
      first_name, middle_name, last_name, suffix, date_of_birth, marital_status, citizenship,
      cell_phone, home_phone, work_phone, dl_number, dl_state,
      current_address_street, current_address_unit, current_address_city, current_address_state, current_address_zip,
      current_housing_type, current_address_years, current_rent_amount,
      employer_name, employer_phone, employer_street, employer_city, employer_state, employer_zip,
      position_title, employment_start_date, is_self_employed,
      base_income, overtime_income, bonus_income, commission_income,
      loan_purpose, loan_type, property_address_street, property_address_city, property_address_state, property_address_zip,
      purchase_price, requested_loan_amount, remaining_loan_balance, borrower_type, occupancy_type, monthly_debt, bank_accounts,
      decl_primary_residence, decl_foreclosure, decl_bankruptcy, decl_lawsuit, decl_delinquent_federal,
      former_addresses, employments,
      created_at, updated_at
    ) VALUES (
      p_email, p_email, p_borrower_id, p_borrower_user_id,
      v_update_data->>'first_name', v_update_data->>'middle_name', v_update_data->>'last_name',
      v_update_data->>'suffix', NULLIF(v_update_data->>'date_of_birth','')::date, v_update_data->>'marital_status', v_update_data->>'citizenship',
      v_update_data->>'cell_phone', v_update_data->>'home_phone', v_update_data->>'work_phone',
      v_update_data->>'dl_number', v_update_data->>'dl_state',
      v_update_data->>'current_address_street', v_update_data->>'current_address_unit',
      v_update_data->>'current_address_city', v_update_data->>'current_address_state', v_update_data->>'current_address_zip',
      v_update_data->>'current_housing_type',
      (v_update_data->>'current_address_years')::int,
      (v_update_data->>'current_rent_amount')::numeric,
      v_update_data->>'employer_name', v_update_data->>'employer_phone',
      v_update_data->>'employer_street', v_update_data->>'employer_city', v_update_data->>'employer_state', v_update_data->>'employer_zip',
      v_update_data->>'position_title', NULLIF(v_update_data->>'employment_start_date','')::date,
      COALESCE((v_update_data->>'is_self_employed')::boolean, false),
      (v_update_data->>'base_income')::numeric, (v_update_data->>'overtime_income')::numeric,
      (v_update_data->>'bonus_income')::numeric, (v_update_data->>'commission_income')::numeric,
      v_update_data->>'loan_purpose', v_update_data->>'loan_type',
      v_update_data->>'property_address_street', v_update_data->>'property_address_city',
      v_update_data->>'property_address_state', v_update_data->>'property_address_zip',
      (v_update_data->>'purchase_price')::numeric, (v_update_data->>'requested_loan_amount')::numeric,
      (v_update_data->>'remaining_loan_balance')::numeric, v_update_data->>'borrower_type',
      v_update_data->>'occupancy_type', (v_update_data->>'monthly_debt')::numeric,
      (v_update_data->>'bank_accounts')::jsonb,
      COALESCE((v_update_data->>'decl_primary_residence')::boolean, false),
      COALESCE((v_update_data->>'decl_foreclosure')::boolean, false),
      COALESCE((v_update_data->>'decl_bankruptcy')::boolean, false),
      COALESCE((v_update_data->>'decl_lawsuit')::boolean, false),
      COALESCE((v_update_data->>'decl_delinquent_federal')::boolean, false),
      (v_update_data->>'former_addresses')::jsonb,
      (v_update_data->>'employments')::jsonb,
      NOW(), NOW()
    ) RETURNING id INTO v_app_id;
  END IF;

  RETURN jsonb_build_object('app_id', v_app_id, 'is_new', v_is_new);
END;
$function$;
