-- vendor_directory_delete(p_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.vendor_directory_delete(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_count int;
begin
  /* THE GUARD USED TO BE:
         if coalesce(auth.role(),'') is distinct from 'service_role' and not public.is_admin() then raise
     which never fires for ANON — anon's role is 'anon', not 'authenticated' —
     so it refused signed-in non-admins while letting an unauthenticated caller
     straight through. anon also held EXECUTE, and the anon key is printed in
     every page's source. Verified over real HTTP before the fix: this returned
     HTTP 200 to the public anon key.

     Asks the positive question now: is the caller an admin (or an internal
     service-role call)? Everything else raises. */
  if coalesce(auth.role(),'') is distinct from 'service_role' and not public.is_admin() then
    raise exception 'admin only';
  end if;
  delete from vendor_directory where id = p_id;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $function$;
