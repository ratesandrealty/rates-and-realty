-- cma_history(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.cma_history(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v jsonb;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'slug', slug, 'property_address', property_address,
      'link_url', 'https://homes.ratesandrealty.com/cma/'||slug,
      'pdf_drive_url', pdf_drive_url, 'pdf_file_name', pdf_file_name,
      'include_acquisition', include_acquisition, 'include_rentals', include_rentals,
      'view_count', view_count, 'created_at', created_at
    ) order by created_at desc), '[]'::jsonb)
  into v from public.cma_snapshots where contact_id = p_contact_id;
  return v;
end; $function$;
