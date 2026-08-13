-- archive_fee_sheet_snapshot(p_slug text, p_archive boolean)
-- language: plpgsql
-- Captured from production 2026-08-13.

CREATE OR REPLACE FUNCTION public.archive_fee_sheet_snapshot(p_slug text, p_archive boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_row public.fee_sheet_snapshots;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  update public.fee_sheet_snapshots
     set archived_at = case when p_archive then now() else null end,
         archived_by = case when p_archive then auth.uid() else null end
   where slug = p_slug
  returning * into v_row;
  if v_row.id is null then raise exception 'no such fee sheet link'; end if;
  return jsonb_build_object('slug', v_row.slug, 'archived', v_row.archived_at is not null);
end; $function$;
