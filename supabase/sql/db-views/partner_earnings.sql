-- partner_earnings (view)
-- Captured from production by tools/recapture-db-views.mjs. Do not hand-edit.
--
-- security_invoker: true
--   RLS on the base tables APPLIES to callers of this view.
-- base_tables_with_rls: contact_earnings, contacts, referral_partners
-- base_tables_without_rls: (none)
-- select_granted_to: anon, authenticated, service_role
--

create or replace view public.partner_earnings as
 SELECT rp.id AS partner_id,
    rp.first_name,
    rp.last_name,
    rp.company,
    rp.source_type,
    count(c.id) AS total_referrals,
    count(c.id) FILTER (WHERE c.deal_outcome = 'won'::text) AS won,
    count(c.id) FILTER (WHERE c.deal_outcome = 'lost'::text) AS lost,
    sum(ce.actual_earnings) FILTER (WHERE c.deal_outcome = 'won'::text) AS total_earnings,
    sum(c.loan_amount) FILTER (WHERE c.deal_outcome = 'won'::text) AS total_volume,
    count(c.id) FILTER (WHERE c.deal_outcome = 'pending'::text) AS pending,
    sum(c.loan_amount) FILTER (WHERE c.deal_outcome = 'pending'::text) AS potential_volume,
    sum(ce.estimated_earnings) FILTER (WHERE c.deal_outcome = 'pending'::text) AS potential_earnings
   FROM referral_partners rp
     LEFT JOIN contacts c ON c.referral_partner_id = rp.id
     LEFT JOIN contact_earnings ce ON ce.contact_id = c.id
  GROUP BY rp.id, rp.first_name, rp.last_name, rp.company, rp.source_type;
