-- trg_clickup_doc_uploaded()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.trg_clickup_doc_uploaded()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM fire_clickup_automation('doc_uploaded', NEW.contact_id, NEW.id::text,
    jsonb_build_object('doc_type', COALESCE(NEW.document_category, NEW.file_type, 'document')));
  RETURN NEW;
END;
$function$;
