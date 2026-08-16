-- trigger_ocr_on_uploaded_document()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05, recaptured 2026-08-15 after the shared
-- secret was retired. This layer had NO git history: check-function-drift.mjs
-- compares deployed EDGE functions and never opens the database, so 5 of 307
-- were recorded and the rest existed only in production. Re-capture after any
-- change.

CREATE OR REPLACE FUNCTION public.trigger_ocr_on_uploaded_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'net'
AS $function$
DECLARE
  req_id BIGINT;
BEGIN
  /* Rotation step 2 of 3, 2026-08-15. This used to send a shared secret written
     here as a LITERAL — the same string was committed in ocr-mms-upload and in
     sms-assistant, so it lives in git history on every branch and cannot be
     un-published. See docs/OCR-SHARED-SECRET-2026-08-15.md.

     internal_call_headers() reads the secret out of the VAULT at call time, so
     the credential never appears in this function's source, never reaches the
     repo, and rotating it later needs no code change anywhere. The edge function
     confirms it through verify_cron_secret(), which returns only a boolean.

     Written INSIDE the body deliberately: recapture via pg_get_functiondef drops
     anything above the CREATE, so rationale placed there does not survive. */

  -- Only OCR-eligible document types
  IF NEW.document_type IS NULL OR NEW.document_type NOT IN (
    'Pay Stubs', 'Pay Stub', 'W-2', 'Bank Statements', 'Bank Statement'
  ) THEN
    RETURN NEW;
  END IF;

  -- Only SMS-sourced uploads (avoids OCRing every admin upload by default)
  IF NEW.storage_path IS NULL OR NEW.storage_path NOT LIKE '%/sms-uploads/%' THEN
    RETURN NEW;
  END IF;

  -- Fire async HTTP call (pg_net is non-blocking)
  SELECT net.http_post(
    url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/ocr-mms-upload',
    headers := internal_call_headers(),
    body := jsonb_build_object('uploaded_document_id', NEW.id),
    timeout_milliseconds := 90000
  ) INTO req_id;

  RETURN NEW;
END;
$function$;
