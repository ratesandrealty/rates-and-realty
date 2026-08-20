-- borrower_qualifying_snapshot (view)
-- Captured from production by tools/recapture-db-views.mjs. Do not hand-edit.
--
-- security_invoker: false
--   DEFINER: this view runs as its OWNER and is NOT subject to the base
--   tables' RLS. Anything granted SELECT here reads past that protection.
-- base_tables_with_rls: contact_notes, contacts, loan_income
-- base_tables_without_rls: (none)
-- select_granted_to: authenticated, service_role
--

create or replace view public.borrower_qualifying_snapshot as
 WITH income_agg AS (
         SELECT li.application_id,
            li.contact_id,
            sum(
                CASE
                    WHEN li.income_type ~~* 'base%'::text OR li.income_type ~~* '%salary%'::text OR li.income_type ~~* '%hourly%'::text OR li.income_type ~~* 'w-2%'::text THEN li.monthly_amount
                    ELSE 0::numeric
                END) AS base_salary_monthly,
            sum(
                CASE
                    WHEN li.income_type ~~* '%overtime%'::text OR li.income_type ~~* '%bonus%'::text OR li.income_type ~~* '%commission%'::text OR li.income_type ~~* '%tips%'::text OR li.income_type = 'OT'::text THEN li.monthly_amount
                    ELSE 0::numeric
                END) AS variable_monthly,
            sum(
                CASE
                    WHEN li.income_type ~~* '%self%'::text OR li.income_type ~~* '%1099%'::text OR li.income_type ~~* '%schedule c%'::text OR li.income_type ~~* '%k-1%'::text OR li.income_type ~~* '%s-corp%'::text OR li.income_type ~~* '%llc%'::text THEN li.monthly_amount
                    ELSE 0::numeric
                END) AS self_employed_monthly,
            sum(
                CASE
                    WHEN li.income_type ~~* '%rent%'::text THEN li.monthly_amount
                    ELSE 0::numeric
                END) AS rental_monthly,
            sum(
                CASE
                    WHEN li.income_type ~~* '%divid%'::text OR li.income_type ~~* '%interest%'::text OR li.income_type ~~* '%capital%'::text THEN li.monthly_amount
                    ELSE 0::numeric
                END) AS investment_monthly,
            sum(
                CASE
                    WHEN li.income_type ~~* '%retire%'::text OR li.income_type ~~* '%pension%'::text OR li.income_type ~~* '%social security%'::text OR li.income_type = 'SS'::text THEN li.monthly_amount
                    ELSE 0::numeric
                END) AS retirement_monthly,
            sum(
                CASE
                    WHEN li.income_type ~~* '%alimony%'::text OR li.income_type ~~* '%child support%'::text THEN li.monthly_amount
                    ELSE 0::numeric
                END) AS support_monthly,
            sum(
                CASE
                    WHEN NOT (li.income_type ~~* 'base%'::text OR li.income_type ~~* '%salary%'::text OR li.income_type ~~* '%hourly%'::text OR li.income_type ~~* 'w-2%'::text OR li.income_type ~~* '%overtime%'::text OR li.income_type ~~* '%bonus%'::text OR li.income_type ~~* '%commission%'::text OR li.income_type ~~* '%tips%'::text OR li.income_type = 'OT'::text OR li.income_type ~~* '%self%'::text OR li.income_type ~~* '%1099%'::text OR li.income_type ~~* '%schedule c%'::text OR li.income_type ~~* '%k-1%'::text OR li.income_type ~~* '%s-corp%'::text OR li.income_type ~~* '%llc%'::text OR li.income_type ~~* '%rent%'::text OR li.income_type ~~* '%divid%'::text OR li.income_type ~~* '%interest%'::text OR li.income_type ~~* '%capital%'::text OR li.income_type ~~* '%retire%'::text OR li.income_type ~~* '%pension%'::text OR li.income_type ~~* '%social security%'::text OR li.income_type = 'SS'::text OR li.income_type ~~* '%alimony%'::text OR li.income_type ~~* '%child support%'::text) THEN li.monthly_amount
                    ELSE 0::numeric
                END) AS other_monthly,
            sum(li.monthly_amount) AS total_documented_monthly,
            count(*) AS income_row_count
           FROM loan_income li
          WHERE li.is_active = true
          GROUP BY li.application_id, li.contact_id
        ), ocr_agg AS (
         SELECT n.contact_id,
            count(*) FILTER (WHERE 'pay_stubs'::text = ANY (n.tags)) AS paystub_ocr_count,
            count(*) FILTER (WHERE 'w2'::text = ANY (n.tags)) AS w2_ocr_count,
            count(*) FILTER (WHERE 'bank_statements'::text = ANY (n.tags)) AS bank_statement_ocr_count,
            max(n.created_at) AS latest_ocr_at
           FROM contact_notes n
          WHERE n.source = 'sms_ocr'::text
          GROUP BY n.contact_id
        ), classified AS (
         SELECT c.id AS contact_id,
            TRIM(BOTH FROM (COALESCE(c.first_name, ''::text) || ' '::text) || COALESCE(c.last_name, ''::text)) AS name,
            c.pipeline_status,
            c.lead_temperature,
            COALESCE(ia.application_id, c.linked_application_id) AS application_id,
            COALESCE(ia.base_salary_monthly, 0::numeric) AS base_salary_monthly,
            COALESCE(ia.variable_monthly, 0::numeric) AS variable_monthly,
            COALESCE(ia.self_employed_monthly, 0::numeric) AS self_employed_monthly,
            COALESCE(ia.rental_monthly, 0::numeric) AS rental_monthly,
            COALESCE(ia.investment_monthly, 0::numeric) AS investment_monthly,
            COALESCE(ia.retirement_monthly, 0::numeric) AS retirement_monthly,
            COALESCE(ia.support_monthly, 0::numeric) AS support_monthly,
            COALESCE(ia.other_monthly, 0::numeric) AS other_monthly,
            COALESCE(ia.total_documented_monthly, 0::numeric) AS total_documented_monthly,
            COALESCE(ia.income_row_count, 0::bigint) AS income_row_count,
            COALESCE(oa.paystub_ocr_count, 0::bigint) AS paystub_ocr_count,
            COALESCE(oa.w2_ocr_count, 0::bigint) AS w2_ocr_count,
            COALESCE(oa.bank_statement_ocr_count, 0::bigint) AS bank_statement_ocr_count,
            oa.latest_ocr_at,
            ia.application_id AS _ia_app_id,
            c.created_at AS contact_created_at,
            c.last_contact_date
           FROM contacts c
             LEFT JOIN income_agg ia ON ia.contact_id = c.id
             LEFT JOIN ocr_agg oa ON oa.contact_id = c.id
        ), agency_adjusted AS (
         SELECT classified.contact_id,
            classified.name,
            classified.pipeline_status,
            classified.lead_temperature,
            classified.application_id,
            classified.base_salary_monthly,
            classified.variable_monthly,
            classified.self_employed_monthly,
            classified.rental_monthly,
            classified.investment_monthly,
            classified.retirement_monthly,
            classified.support_monthly,
            classified.other_monthly,
            classified.total_documented_monthly,
            classified.income_row_count,
            classified.paystub_ocr_count,
            classified.w2_ocr_count,
            classified.bank_statement_ocr_count,
            classified.latest_ocr_at,
            classified._ia_app_id,
            classified.contact_created_at,
            classified.last_contact_date,
                CASE
                    WHEN classified.w2_ocr_count >= 2 THEN classified.variable_monthly
                    ELSE 0::numeric
                END AS agency_adjusted_variable_monthly,
            round(classified.rental_monthly * 0.75, 2) AS agency_adjusted_rental_monthly,
            classified.self_employed_monthly AS agency_adjusted_self_employed_monthly
           FROM classified
        )
 SELECT contact_id,
    name,
    pipeline_status,
    lead_temperature,
    application_id,
    base_salary_monthly,
    variable_monthly,
    self_employed_monthly,
    rental_monthly,
    investment_monthly,
    retirement_monthly,
    support_monthly,
    other_monthly,
    total_documented_monthly,
    income_row_count,
    paystub_ocr_count,
    w2_ocr_count,
    bank_statement_ocr_count,
    latest_ocr_at,
    base_salary_monthly + variable_monthly + self_employed_monthly + rental_monthly + investment_monthly + retirement_monthly + support_monthly AS preliminary_qualifying_monthly,
    round((base_salary_monthly + variable_monthly + self_employed_monthly + rental_monthly + investment_monthly + retirement_monthly + support_monthly) * 0.43, 2) AS max_back_end_piti_at_43_dti,
    round((base_salary_monthly + variable_monthly + self_employed_monthly + rental_monthly + investment_monthly + retirement_monthly + support_monthly) * 0.50, 2) AS max_back_end_piti_at_50_dti,
    agency_adjusted_variable_monthly,
    agency_adjusted_rental_monthly,
    agency_adjusted_self_employed_monthly,
    base_salary_monthly + agency_adjusted_variable_monthly + agency_adjusted_self_employed_monthly + agency_adjusted_rental_monthly + investment_monthly + retirement_monthly + support_monthly AS agency_qualifying_monthly,
    round((base_salary_monthly + agency_adjusted_variable_monthly + agency_adjusted_self_employed_monthly + agency_adjusted_rental_monthly + investment_monthly + retirement_monthly + support_monthly) * 0.43, 2) AS agency_max_piti_at_43_dti,
    round((base_salary_monthly + agency_adjusted_variable_monthly + agency_adjusted_self_employed_monthly + agency_adjusted_rental_monthly + investment_monthly + retirement_monthly + support_monthly) * 0.50, 2) AS agency_max_piti_at_50_dti,
    base_salary_monthly + variable_monthly + self_employed_monthly + rental_monthly + investment_monthly + retirement_monthly + support_monthly - (base_salary_monthly + agency_adjusted_variable_monthly + agency_adjusted_self_employed_monthly + agency_adjusted_rental_monthly + investment_monthly + retirement_monthly + support_monthly) AS qualifying_upside_locked_by_doc_gaps,
    NOT (base_salary_monthly > 0::numeric AND paystub_ocr_count = 0 OR variable_monthly > 0::numeric AND w2_ocr_count < 2 OR self_employed_monthly > 0::numeric OR rental_monthly > 0::numeric OR other_monthly > 0::numeric) AS qualifying_documentation_complete,
    _ia_app_id IS NULL AS gap_no_application,
    base_salary_monthly > 0::numeric AND paystub_ocr_count = 0 AS gap_base_salary_no_paystubs,
    variable_monthly > 0::numeric AND w2_ocr_count < 2 AS gap_variable_needs_2yr_w2,
    self_employed_monthly > 0::numeric AS gap_se_needs_tax_returns,
    rental_monthly > 0::numeric AS gap_rental_needs_schedule_e,
    other_monthly > 0::numeric AS gap_other_needs_classification,
    contact_created_at,
    last_contact_date
   FROM agency_adjusted
  ORDER BY contact_created_at DESC;
