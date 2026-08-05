-- cma_snapshot_attach_pdf(p_slug text, p_pdf_url text, p_pdf_file_id text, p_pdf_name text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.cma_snapshot_attach_pdf(p_slug text, p_pdf_url text, p_pdf_file_id text, p_pdf_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_row cma_snapshots;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  update public.cma_snapshots
     set pdf_drive_url = p_pdf_url, pdf_drive_file_id = p_pdf_file_id, pdf_file_name = p_pdf_name
   where slug = p_slug
   returning * into v_row;
  if v_row.id is null then raise exception 'snapshot not found'; end if;
  return jsonb_build_object('slug', v_row.slug, 'pdf_drive_url', v_row.pdf_drive_url);
end; $function$;
