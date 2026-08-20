-- earnings_summary (view)
-- Captured from production by tools/recapture-db-views.mjs. Do not hand-edit.
--
-- security_invoker: true
--   RLS on the base tables APPLIES to callers of this view.
-- base_tables_with_rls: contact_earnings, contacts
-- base_tables_without_rls: (none)
-- select_granted_to: anon, authenticated, service_role
--

create or replace view public.earnings_summary as
 SELECT date_trunc('month'::text, COALESCE(c.closed_date, c.created_at::date)::timestamp with time zone) AS month,
    count(*) FILTER (WHERE c.deal_outcome = 'won'::text) AS deals_won,
    count(*) FILTER (WHERE c.deal_outcome = 'lost'::text) AS deals_lost,
    count(*) FILTER (WHERE c.deal_outcome = 'pending'::text) AS deals_pending,
    sum(ce.actual_earnings) FILTER (WHERE c.deal_outcome = 'won'::text) AS total_earned,
    sum(ce.estimated_earnings) FILTER (WHERE c.deal_outcome = 'pending'::text) AS pipeline_value,
    sum(c.loan_amount) FILTER (WHERE c.deal_outcome = 'won'::text) AS won_volume,
    sum(c.loan_amount) FILTER (WHERE c.deal_outcome = 'lost'::text) AS lost_volume
   FROM contacts c
     LEFT JOIN contact_earnings ce ON ce.contact_id = c.id
  GROUP BY (date_trunc('month'::text, COALESCE(c.closed_date, c.created_at::date)::timestamp with time zone))
  ORDER BY (date_trunc('month'::text, COALESCE(c.closed_date, c.created_at::date)::timestamp with time zone)) DESC;
