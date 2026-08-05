-- tg_contact_notes_mentions()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.tg_contact_notes_mentions()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform app_notify_mentions('contact_note', new.id, new.note_text,
    new.author_user_id,
    coalesce(nullif(display_for_user(new.author_user_id),''), new.author_display),
    new.contact_id);
  return new;
end; $function$;
