-- get_cma_snapshot(p_slug text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.get_cma_snapshot(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.cma_snapshots;
begin
  select * into v_row from public.cma_snapshots where slug = p_slug;
  if v_row.id is null then return null; end if;
  update public.cma_snapshots set view_count = view_count + 1, last_viewed_at = now() where id = v_row.id;
  return jsonb_build_object(
    'slug', v_row.slug, 'data', v_row.data, 'borrower_name', v_row.borrower_name,
    'property_address', v_row.property_address,
    'include_acquisition', v_row.include_acquisition, 'include_rentals', v_row.include_rentals,
    'created_at', v_row.created_at);
end; $function$;
