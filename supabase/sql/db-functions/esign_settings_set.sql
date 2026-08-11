-- esign_settings_set(p_default_mortgagee_clause text, p_default_lender_id uuid, p_lo_name text, p_lo_nmls text, p_lo_company text, p_lo_company_nmls text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.esign_settings_set(p_default_mortgagee_clause text DEFAULT NULL::text, p_default_lender_id uuid DEFAULT NULL::uuid, p_lo_name text DEFAULT NULL::text, p_lo_nmls text DEFAULT NULL::text, p_lo_company text DEFAULT NULL::text, p_lo_company_nmls text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not is_admin() then
    raise exception 'admin only';
  end if;
  update esign_merge_settings set
    default_mortgagee_clause = coalesce(p_default_mortgagee_clause, default_mortgagee_clause),
    default_lender_id = coalesce(p_default_lender_id, default_lender_id),
    lo_name = coalesce(p_lo_name, lo_name),
    lo_nmls = coalesce(p_lo_nmls, lo_nmls),
    lo_company = coalesce(p_lo_company, lo_company),
    lo_company_nmls = coalesce(p_lo_company_nmls, lo_company_nmls),
    updated_at = now()
  where key = 'default';
  return jsonb_build_object('ok', true);
end; $function$;
