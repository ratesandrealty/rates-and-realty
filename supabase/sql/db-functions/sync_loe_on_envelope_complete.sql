-- sync_loe_on_envelope_complete()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sync_loe_on_envelope_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.status = 'completed' and OLD.status is distinct from 'completed' then
    update public.loe_requests
       set status          = 'signed',
           signed_pdf_path = coalesce(NEW.combined_pdf_path, NEW.final_pdf_path),
           signed_pdf_url  = coalesce(NEW.combined_pdf_url,  NEW.final_pdf_url),
           signed_at       = coalesce(NEW.completed_at, now()),
           completed_at    = coalesce(NEW.completed_at, now()),
           updated_at      = now()
     where envelope_id = NEW.id
       and status is distinct from 'signed';
  end if;
  return NEW;
end; $function$;
