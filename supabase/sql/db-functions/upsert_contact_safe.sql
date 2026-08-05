-- upsert_contact_safe(p_email text, p_phone text, p_first_name text, p_last_name text, p_source text, p_portal_user_id uuid, p_borrower_id text, p_extra jsonb)
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.upsert_contact_safe(p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_first_name text DEFAULT NULL::text, p_last_name text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_portal_user_id uuid DEFAULT NULL::uuid, p_borrower_id text DEFAULT NULL::text, p_extra jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_contact_id uuid;
  v_existing contacts%ROWTYPE;
BEGIN
  IF p_email IS NOT NULL AND p_email != '' THEN
    SELECT * INTO v_existing FROM contacts WHERE LOWER(email) = LOWER(p_email) LIMIT 1;
  END IF;
  IF v_existing.id IS NULL AND p_phone IS NOT NULL AND p_phone != '' THEN
    SELECT * INTO v_existing FROM contacts WHERE phone = p_phone LIMIT 1;
  END IF;

  IF v_existing.id IS NOT NULL THEN
    UPDATE contacts SET
      first_name = CASE WHEN (first_name IS NULL OR first_name = '') AND p_first_name IS NOT NULL THEN p_first_name ELSE first_name END,
      last_name  = CASE WHEN (last_name IS NULL OR last_name = '') AND p_last_name IS NOT NULL THEN p_last_name ELSE last_name END,
      email      = CASE WHEN (email IS NULL OR email = '') AND p_email IS NOT NULL THEN p_email ELSE email END,
      phone      = CASE WHEN (phone IS NULL OR phone = '') AND p_phone IS NOT NULL THEN p_phone ELSE phone END,
      portal_user_id = CASE WHEN portal_user_id IS NULL AND p_portal_user_id IS NOT NULL THEN p_portal_user_id ELSE portal_user_id END,
      borrower_id    = CASE WHEN borrower_id IS NULL AND p_borrower_id IS NOT NULL THEN p_borrower_id ELSE borrower_id END,
      crm_id         = CASE WHEN crm_id IS NULL AND p_borrower_id IS NOT NULL THEN p_borrower_id ELSE crm_id END,
      updated_at = NOW()
    WHERE id = v_existing.id;
    v_contact_id := v_existing.id;
  ELSE
    INSERT INTO contacts (email, phone, first_name, last_name, source, portal_user_id, borrower_id, crm_id)
    VALUES (p_email, p_phone, p_first_name, p_last_name, p_source, p_portal_user_id, p_borrower_id, COALESCE(p_borrower_id, 'RR-' || UPPER(SUBSTRING(REPLACE(gen_random_uuid()::text,'-',''),1,6))))
    RETURNING id INTO v_contact_id;
  END IF;

  RETURN v_contact_id;
END;
$function$;
