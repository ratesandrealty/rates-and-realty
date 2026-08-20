-- contacts_secure (view)
-- Captured from production by tools/recapture-db-views.mjs. Do not hand-edit.
--
-- security_invoker: false
--   DEFINER: this view runs as its OWNER and is NOT subject to the base
--   tables' RLS. Anything granted SELECT here reads past that protection.
-- base_tables_with_rls: contacts
-- base_tables_without_rls: (none)
-- select_granted_to: authenticated, service_role
--

create or replace view public.contacts_secure as
 SELECT id,
    first_name,
    last_name,
        CASE
            WHEN current_app_role() = 'va'::text AND NOT is_admin() THEN ('lead-'::text || "left"(id::text, 8)) || '@masked.local'::text
            ELSE email
        END AS email,
        CASE
            WHEN current_app_role() = 'va'::text AND NOT is_admin() THEN mask_phone(phone)
            ELSE phone
        END AS phone,
    contact_type,
    source,
    created_at,
    middle_name,
        CASE
            WHEN can_see_ssn() THEN date_of_birth
            ELSE NULL::date
        END AS date_of_birth,
        CASE
            WHEN can_see_ssn() THEN ssn_last4
            ELSE NULL::text
        END AS ssn_last4,
    address,
    city,
    state,
    zip,
    county,
    employer_name,
    job_title,
    employment_type,
    years_employed,
        CASE
            WHEN can_see_financials() THEN monthly_income
            ELSE NULL::numeric
        END AS monthly_income,
        CASE
            WHEN can_see_financials() THEN annual_income
            ELSE NULL::numeric
        END AS annual_income,
        CASE
            WHEN current_app_role() = 'va'::text AND NOT is_admin() THEN mask_phone(secondary_phone)
            ELSE secondary_phone
        END AS secondary_phone,
    preferred_contact,
    best_time_to_call,
        CASE
            WHEN can_see_financials() THEN credit_score
            ELSE NULL::integer
        END AS credit_score,
        CASE
            WHEN can_see_financials() THEN monthly_debt
            ELSE NULL::numeric
        END AS monthly_debt,
        CASE
            WHEN can_see_financials() THEN bankruptcy_history
            ELSE NULL::boolean
        END AS bankruptcy_history,
    updated_at,
    funnel_source,
    utm_source,
    utm_campaign,
    lead_score,
    score_tier,
    google_drive_folder_url,
    google_drive_folder_id,
    drive_folder_created_at,
    lead_temperature,
    appointment_set,
    appointment_date,
    credit_optimization_interest,
    tags,
    notes,
    company,
    loan_type,
    loan_amount,
    sms_opt_in,
    referred_by,
    referred_by_contact_id,
    last_contact_date,
    next_follow_up,
    pipeline_status,
    assigned_to,
    referral_partner_id,
    portal_user_id,
    borrower_id,
    crm_id,
    temperature,
    linked_application_id,
    is_co_borrower,
    primary_borrower_contact_id,
    gdrive_folder_id,
    gdrive_folder_url,
    gdrive_folder_name,
    deal_outcome,
        CASE
            WHEN can_see_earnings() THEN actual_earnings
            ELSE NULL::numeric
        END AS actual_earnings,
        CASE
            WHEN can_see_earnings() THEN estimated_earnings
            ELSE NULL::numeric
        END AS estimated_earnings,
    closed_date,
    lost_reason,
    property_address,
    property_value,
    purchase_price,
    down_payment,
    ltv,
    timeline,
    priority,
    lead_source,
    lead_status,
    ai_summary,
    calls_answered,
    calls_missed,
    email_opens,
    email_clicks,
    sms_replies,
    days_no_response,
    engagement_score,
    intent_score,
    financial_score,
    responsiveness_score,
    property_score,
    source_score,
    total_score,
    lead_type,
    funnel_step,
    next_action,
    response_rate,
    qualifier_answers,
        CASE
            WHEN can_see_financials() THEN current_interest_rate
            ELSE NULL::numeric
        END AS current_interest_rate,
    current_lender,
        CASE
            WHEN can_see_financials() THEN current_monthly_payment
            ELSE NULL::numeric
        END AS current_monthly_payment,
        CASE
            WHEN can_see_financials() THEN remaining_loan_balance
            ELSE NULL::numeric
        END AS remaining_loan_balance,
    requested_loan_amount,
    down_payment_percent,
    occupancy_type,
    property_type,
    property_city,
    property_state,
    property_zip,
    property_price_range,
        CASE
            WHEN can_see_financials() THEN dscr_ratio
            ELSE NULL::numeric
        END AS dscr_ratio,
        CASE
            WHEN can_see_financials() THEN gross_rental_income
            ELSE NULL::numeric
        END AS gross_rental_income,
        CASE
            WHEN can_see_financials() THEN monthly_rent
            ELSE NULL::numeric
        END AS monthly_rent,
    credit_score_range,
    last_scored_at,
    utm_medium,
    utm_content,
    preferred_language,
    clickup_tag,
    staleness_penalty,
    last_meaningful_activity_at,
    deal_analyzer_data,
    deal_analyzer_updated_at,
    loan_purpose,
    closing_lender,
    closing_loan_type,
    post_close_task_at,
    refi_alert_last_at,
    refi_alert_last_rate,
    lofty_id,
        CASE
            WHEN current_app_role() = 'va'::text AND NOT is_admin() THEN NULL::text
            ELSE secondary_email
        END AS secondary_email,
    pref_min_price,
    pref_max_price,
    pref_area,
    import_source,
    imported_at,
    import_raw,
    next_followup_at,
    do_not_call,
    recording_consent_at,
    recording_consent_method,
    recording_consent_by
   FROM contacts
  WHERE is_admin() OR is_lead_shared_with_me(id) OR is_borrower() AND (id = current_contact_id() OR portal_user_id = auth.uid()) OR (current_app_role() = ANY (ARRAY['va'::text, 'loa'::text, 'agent'::text])) AND staff_lead_visible(pipeline_status, deal_outcome);
