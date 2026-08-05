-- auto_file_tagged_email()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.auto_file_tagged_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cid uuid;
begin
  if NEW.contact_id is null and NEW.gmail_thread_id is not null then
    select contact_id into v_cid from public.email_thread_tags
     where gmail_thread_id = NEW.gmail_thread_id;
    if v_cid is not null then NEW.contact_id := v_cid; end if;
  end if;
  return NEW;
end; $function$;
