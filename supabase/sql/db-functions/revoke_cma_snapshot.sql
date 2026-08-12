-- revoke_cma_snapshot(p_slug text, p_revoke boolean)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public.revoke_cma_snapshot(p_slug text, p_revoke boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_row public.cma_snapshots;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  update public.cma_snapshots
     set revoked_at = case when p_revoke then now() else null end,
         revoked_by = case when p_revoke then auth.uid() else null end
   where slug = p_slug returning * into v_row;
  if v_row.id is null then raise exception 'no such CMA link'; end if;
  return jsonb_build_object('slug', v_row.slug, 'revoked', v_row.revoked_at is not null);
end; $function$;
