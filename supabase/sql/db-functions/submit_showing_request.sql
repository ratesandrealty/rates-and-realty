-- submit_showing_request(p_email text, p_name text, p_phone text, p_portal_user_id uuid, p_borrower_id text, p_batch_id uuid, p_preferred_date date, p_preferred_time text, p_notes text, p_homes jsonb)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.submit_showing_request(p_email text DEFAULT NULL::text, p_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_portal_user_id uuid DEFAULT NULL::uuid, p_borrower_id text DEFAULT NULL::text, p_batch_id uuid DEFAULT NULL::uuid, p_preferred_date date DEFAULT NULL::date, p_preferred_time text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_homes jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_contact_id uuid;
  v_batch uuid;
  v_inserted int := 0;
  v_home jsonb;
BEGIN
  IF p_email IS NOT NULL THEN
    SELECT id INTO v_contact_id FROM contacts WHERE LOWER(email) = LOWER(p_email) LIMIT 1;
  END IF;
  IF v_contact_id IS NULL AND p_borrower_id IS NOT NULL THEN
    SELECT id INTO v_contact_id FROM contacts WHERE crm_id = p_borrower_id LIMIT 1;
  END IF;
  IF v_contact_id IS NULL AND p_portal_user_id IS NOT NULL THEN
    SELECT id INTO v_contact_id FROM contacts WHERE portal_user_id = p_portal_user_id LIMIT 1;
  END IF;
  IF v_contact_id IS NULL AND p_email IS NOT NULL AND p_name IS NOT NULL THEN
    INSERT INTO contacts (email, phone, first_name, last_name, source)
    VALUES (LOWER(p_email), p_phone, SPLIT_PART(p_name,' ',1),
      CASE WHEN POSITION(' ' IN p_name) > 0 THEN SUBSTRING(p_name FROM POSITION(' ' IN p_name)+1) ELSE '' END,
      'showing_request') RETURNING id INTO v_contact_id;
  END IF;

  v_batch := COALESCE(p_batch_id, gen_random_uuid());

  FOR v_home IN SELECT * FROM jsonb_array_elements(p_homes) LOOP
    INSERT INTO showings (
      name, email, phone, contact_id, portal_user_id, borrower_id, crm_id,
      batch_id, preferred_date, preferred_time, notes, status,
      property_address, property_price, property_beds, property_baths,
      property_sqft, property_city, property_photo, listing_key,
      listing_agent_name, listing_agent_phone, listing_agent_email,
      created_at, updated_at
    ) VALUES (
      p_name, p_email, p_phone, v_contact_id, p_portal_user_id, p_borrower_id, p_borrower_id,
      v_batch, p_preferred_date, p_preferred_time, p_notes, 'new',
      v_home->>'address',
      NULLIF(v_home->>'price','')::numeric,
      NULLIF(v_home->>'beds','')::integer,
      NULLIF(v_home->>'baths','')::integer,
      NULLIF(v_home->>'sqft','')::integer,
      v_home->>'city', v_home->>'photo', v_home->>'listingKey',
      v_home->>'agentName', v_home->>'agentPhone', v_home->>'agentEmail',
      NOW(), NOW()
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  IF v_contact_id IS NOT NULL AND v_inserted > 0 THEN
    INSERT INTO activity_events (contact_id, portal_user_id, crm_id, type, channel, title, description, status, metadata, created_at)
    VALUES (v_contact_id, p_portal_user_id, p_borrower_id, 'showing', 'showing',
      'Showing Request: ' || v_inserted || ' home' || CASE WHEN v_inserted!=1 THEN 's' ELSE '' END,
      COALESCE(p_name,'Borrower') || ' requested ' || v_inserted || ' showing' || CASE WHEN v_inserted!=1 THEN 's' ELSE '' END,
      'new',
      jsonb_build_object('batch_id',v_batch,'home_count',v_inserted,'preferred_date',p_preferred_date,'email',p_email),
      NOW());
  END IF;

  RETURN jsonb_build_object('success',true,'batch_id',v_batch,'contact_id',v_contact_id,'homes_submitted',v_inserted);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success',false,'error',SQLERRM,'detail',SQLSTATE);
END;
$function$;
