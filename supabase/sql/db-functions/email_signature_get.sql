-- email_signature_get(p_mailbox text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.email_signature_get(p_mailbox text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v text;
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff'))
    then raise exception 'not authorized'; end if;
  select signature_html into v from email_signatures where mailbox = p_mailbox;
  return coalesce(v,'');
end; $function$;
