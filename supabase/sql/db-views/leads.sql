-- leads (view)
-- Captured from production by tools/recapture-db-views.mjs. Do not hand-edit.
--
-- security_invoker: true
--   RLS on the base tables APPLIES to callers of this view.
-- base_tables_with_rls: contact_earnings, contacts
-- base_tables_without_rls: (none)
-- select_granted_to: anon, authenticated, service_role
--

create or replace view public.leads as
 SELECT id,
    id AS contact_id,
    first_name,
    last_name,
    email,
    phone,
    source,
    lead_source,
    lead_type,
    lead_status AS status,
    pipeline_status,
    priority,
    score_tier,
    deal_outcome,
    ( SELECT ce.actual_earnings
           FROM contact_earnings ce
          WHERE ce.contact_id = contacts.id
         LIMIT 1) AS actual_earnings,
    ( SELECT ce.estimated_earnings
           FROM contact_earnings ce
          WHERE ce.contact_id = contacts.id
         LIMIT 1) AS estimated_earnings,
    closed_date,
    lost_reason,
    loan_amount,
    loan_type,
    property_address,
    property_city,
    property_state,
    property_zip,
    property_value,
    purchase_price,
    down_payment,
    down_payment_percent,
    ltv,
    occupancy_type,
    property_type,
    property_price_range,
    timeline,
    current_interest_rate,
    current_lender,
    current_monthly_payment,
    remaining_loan_balance,
    requested_loan_amount,
    ai_summary,
    notes,
    next_action,
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
    lead_score AS score,
    lead_temperature,
    last_contact_date,
    last_scored_at,
    next_follow_up,
    referral_partner_id,
    referred_by,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_content,
    qualifier_answers,
    funnel_source,
    funnel_step,
    response_rate,
    dscr_ratio,
    gross_rental_income,
    monthly_rent,
    credit_score_range,
    credit_score,
    google_drive_folder_id,
    google_drive_folder_url,
    assigned_to,
    appointment_set,
    created_at,
    updated_at
   FROM contacts;
