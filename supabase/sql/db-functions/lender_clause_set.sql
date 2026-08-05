-- lender_clause_set(p_lender_id uuid, p_mortgagee_clause text, p_cpl_clause text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.lender_clause_set(p_lender_id uuid, p_mortgagee_clause text, p_cpl_clause text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.role() = 'authenticated' and not (is_admin() or coalesce(current_app_role(),'') in ('va','loa','agent','lender','staff')) then
    raise exception 'not authorized';
  end if;
  update lenders set
    mortgagee_clause = coalesce(nullif(trim(p_mortgagee_clause),''), mortgagee_clause),
    cpl_clause = coalesce(nullif(trim(p_cpl_clause),''), cpl_clause),
    updated_at = now()
  where id = p_lender_id;
  return jsonb_build_object('ok', found, 'lender_id', p_lender_id);
end; $function$;
