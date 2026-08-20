-- showing_requests_crm (view)
-- Captured from production by tools/recapture-db-views.mjs. Do not hand-edit.
--
-- security_invoker: true
--   RLS on the base tables APPLIES to callers of this view.
-- base_tables_with_rls: contacts, portal_users, showings
-- base_tables_without_rls: (none)
-- select_granted_to: anon, authenticated, service_role
--

create or replace view public.showing_requests_crm as
 SELECT s.id,
    s.batch_id,
    s.created_at,
    s.status,
    s.name,
    s.email,
    s.phone,
    s.preferred_date,
    s.preferred_time,
    s.notes,
    s.listing_key,
    s.property_address,
    s.property_city,
    s.property_price,
    s.property_beds,
    s.property_baths,
    s.property_sqft,
    s.property_photo,
    s.listing_agent_name,
    s.listing_agent_phone,
    s.listing_agent_email,
    s.listing_agent_office,
    s.listing_url,
    s.listing_data,
    s.portal_user_id,
    pu.first_name AS portal_first_name,
    pu.last_name AS portal_last_name,
    c.id AS contact_id,
    c.pipeline_status
   FROM showings s
     LEFT JOIN portal_users pu ON pu.id = s.portal_user_id
     LEFT JOIN contacts c ON c.email = s.email
  ORDER BY s.created_at DESC;
