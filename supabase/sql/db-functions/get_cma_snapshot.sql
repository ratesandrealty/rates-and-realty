-- get_cma_snapshot(p_slug text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-12. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.get_cma_snapshot(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* PUBLIC, ANONYMOUS. Mirrors get_fee_sheet_snapshot: status decided BEFORE the
 * view counter moves, so a revoked link stops accruing views, and an explicit
 * status so the page can say "no longer available" instead of rendering blank. */
declare v_row public.cma_snapshots;
begin
  select * into v_row from public.cma_snapshots where slug = p_slug;
  if v_row.id is null then return jsonb_build_object('status','not_found'); end if;
  if v_row.revoked_at is not null then
    return jsonb_build_object('status','revoked','revoked_at',v_row.revoked_at);
  end if;
  if v_row.expires_at is not null and v_row.expires_at <= now() then
    return jsonb_build_object('status','expired','expired_at',v_row.expires_at);
  end if;

  update public.cma_snapshots set view_count = view_count + 1, last_viewed_at = now()
   where id = v_row.id;

  return jsonb_build_object(
    'status','ok',
    'slug', v_row.slug,
    'data', public._cma_redact(v_row.data, v_row.include_acquisition, v_row.include_rentals),
    'borrower_name', v_row.borrower_name,
    'property_address', v_row.property_address,
    'include_acquisition', v_row.include_acquisition,
    'include_rentals', v_row.include_rentals,
    'created_at', v_row.created_at);
end; $function$;
