-- is_contact_blocked(p_email text, p_phone text, p_name text)
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.is_contact_blocked(p_email text, p_phone text, p_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email_lower text := lower(coalesce(p_email, ''));
  v_phone_clean text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_domain text;
BEGIN
  IF v_email_lower != '' THEN
    -- exact email match
    IF EXISTS (SELECT 1 FROM contact_blocklist WHERE block_type = 'email' AND lower(value) = v_email_lower) THEN
      RETURN true;
    END IF;
    -- domain match
    v_domain := split_part(v_email_lower, '@', 2);
    IF v_domain != '' AND EXISTS (SELECT 1 FROM contact_blocklist WHERE block_type = 'domain' AND lower(value) = v_domain) THEN
      RETURN true;
    END IF;
  END IF;

  IF v_phone_clean != '' AND EXISTS (
    SELECT 1 FROM contact_blocklist 
    WHERE block_type = 'phone' AND regexp_replace(value, '\D', '', 'g') = v_phone_clean
  ) THEN
    RETURN true;
  END IF;

  IF p_name IS NOT NULL AND EXISTS (
    SELECT 1 FROM contact_blocklist WHERE block_type = 'name' AND lower(value) = lower(p_name)
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$function$;
