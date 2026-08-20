-- v_showing_tours (view)
-- Captured from production by tools/recapture-db-views.mjs. Do not hand-edit.
--
-- security_invoker: true
--   RLS on the base tables APPLIES to callers of this view.
-- base_tables_with_rls: contacts, showing_batches, showings
-- base_tables_without_rls: (none)
-- select_granted_to: anon, authenticated, service_role
--

create or replace view public.v_showing_tours as
 SELECT b.id AS batch_id,
    b.contact_id,
    b.status,
    b.title,
    b.scheduled_start,
    b.scheduled_end,
    b.share_token,
    b.notes_internal,
    b.notes_for_lead,
    b.view_count,
    b.confirmed_at,
    b.sent_at,
    b.canceled_at,
    b.created_at,
    b.updated_at,
    count(s.id) FILTER (WHERE s.deleted_at IS NULL) AS stop_count,
    count(s.id) FILTER (WHERE s.status = 'confirmed'::text AND s.deleted_at IS NULL) AS confirmed_stops,
    c.first_name AS contact_first_name,
    c.last_name AS contact_last_name,
    c.email AS contact_email,
    c.phone AS contact_phone
   FROM showing_batches b
     LEFT JOIN showings s ON s.batch_id = b.id AND s.deleted_at IS NULL
     LEFT JOIN contacts c ON c.id = b.contact_id
  GROUP BY b.id, c.id;
