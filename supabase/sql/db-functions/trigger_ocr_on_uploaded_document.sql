-- trigger_ocr_on_uploaded_document()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.trigger_ocr_on_uploaded_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'net'
AS $function$
DECLARE
  req_id BIGINT;
BEGIN
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
    headers := jsonb_build_object(
      'x-cron-secret', 'rr-cron-2026-x7k3m9pq2r5tw8z4y6h8b3n1',
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('uploaded_document_id', NEW.id),
    timeout_milliseconds := 90000
  ) INTO req_id;

  RETURN NEW;
END;
$function$;
