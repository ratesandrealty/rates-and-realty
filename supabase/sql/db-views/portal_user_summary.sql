-- portal_user_summary (view)
-- Captured from production by tools/recapture-db-views.mjs. Do not hand-edit.
--
-- security_invoker: true
--   RLS on the base tables APPLIES to callers of this view.
-- base_tables_with_rls: favorites, portal_users, saved_listings, showings
-- base_tables_without_rls: (none)
-- select_granted_to: anon, authenticated, service_role
--

create or replace view public.portal_user_summary as
 SELECT id,
    email,
    first_name,
    last_name,
    phone,
    contact_id,
    created_at,
    last_login,
    ( SELECT count(*) AS count
           FROM saved_listings sl
          WHERE sl.portal_user_id = pu.id) AS saved_count,
    ( SELECT count(*) AS count
           FROM showings s
          WHERE s.portal_user_id = pu.id OR s.email = pu.email) AS showing_count,
    ( SELECT count(*) AS count
           FROM favorites f
          WHERE f.portal_user_id = pu.id OR f.user_email = pu.email) AS favorites_count
   FROM portal_users pu;
