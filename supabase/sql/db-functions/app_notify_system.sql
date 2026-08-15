-- app_notify_system(p_source_kind text, p_source_id uuid, p_body text, p_actor_display text, p_contact_id uuid, p_roles text[], p_link text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-15. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.app_notify_system(p_source_kind text, p_source_id uuid, p_body text, p_actor_display text DEFAULT 'System'::text, p_contact_id uuid DEFAULT NULL::uuid, p_roles text[] DEFAULT ARRAY['admin'::text], p_link text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Direct-insert notifications for events with no human author.
 *
 * app_notify_mentions is NOT a general notifier despite the name -- it scans
 * p_body for @handles, so a machine-generated body with no @ iterates zero
 * times, returns 0 and inserts nothing. Three callers had never delivered
 * anything and nobody could tell.
 *
 * p_link is where the row should OPEN. The bell used to derive its destination
 * from contact_id alone, so a notification about a visitor who never left
 * contact details had nowhere to go -- it marked itself read and did nothing,
 * which is exactly the Frank case. The producer knows the right destination;
 * the bell should not have to guess it from `kind`. */
declare
  v_preview text;
  n int := 0;
begin
  if coalesce(trim(p_body),'') = '' then return 0; end if;
  v_preview := left(regexp_replace(p_body, '\s+', ' ', 'g'), 180);

  insert into public.app_notifications
    (recipient_user_id, actor_user_id, actor_display, kind,
     source_kind, source_id, contact_id, preview, link)
  select aur.user_id, null,
         coalesce(nullif(trim(p_actor_display),''), 'System'),
         'system', p_source_kind, p_source_id, p_contact_id, v_preview,
         nullif(trim(coalesce(p_link,'')),'')
  from auth_user_roles aur
  where aur.role = any(p_roles) and not aur.service_account; /* no in-app notifications for unattended logins */

  get diagnostics n = row_count;
  return n;
end; $function$;
