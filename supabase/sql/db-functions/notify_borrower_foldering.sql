-- notify_borrower_foldering()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.notify_borrower_foldering()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  perform net.http_post(
    url := 'https://ratesandrealty.app.n8n.cloud/webhook/borrower-stage-foldering',
    body := jsonb_build_object('record', to_jsonb(NEW)),
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  return NEW;
end $function$;
