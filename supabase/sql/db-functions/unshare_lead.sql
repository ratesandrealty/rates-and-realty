-- unshare_lead(p_contact_id uuid, p_user_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.unshare_lead(p_contact_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  delete from public.lead_shares where contact_id = p_contact_id and shared_with_user_id = p_user_id;
  return true;
end; $function$;
