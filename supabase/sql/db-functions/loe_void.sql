-- loe_void(p_loe_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.loe_void(p_loe_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role() = 'authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
  update public.loe_requests set status='voided', updated_at=now() where id=p_loe_id;
end; $function$;
