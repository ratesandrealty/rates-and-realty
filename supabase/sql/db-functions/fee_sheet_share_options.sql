-- fee_sheet_share_options(p_slug text)
-- language: plpgsql
-- Captured from production 2026-08-13.

CREATE OR REPLACE FUNCTION public.fee_sheet_share_options(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_row public.fee_sheet_snapshots; v_sec jsonb; v_modes jsonb;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  select * into v_row from public.fee_sheet_snapshots where slug = p_slug;
  if v_row.id is null then raise exception 'no such fee sheet link'; end if;

  select jsonb_agg(jsonb_build_object(
           'key', x->>'key', 'label', x->>'label',
           'available', public._fs_has_section(v_row.data, x->>'key', coalesce(nullif(v_row.share_sections->>'mode',''), v_row.data->>'mode')),
           'on', coalesce((v_row.share_sections->>(x->>'key'))::boolean, false))
         order by ord)
    into v_sec
  from jsonb_array_elements(public._fs_share_section_keys()) with ordinality t(x, ord);

  select jsonb_agg(jsonb_build_object(
           'key', m->>'key', 'label', m->>'label',
           'available', public._fs_has_mode(v_row.data, m->>'key'))
         order by ord)
    into v_modes
  from jsonb_array_elements(public._fs_share_mode_keys()) with ordinality t(m, ord);

  return jsonb_build_object(
    'slug', v_row.slug,
    'snapshot_mode', v_row.data->>'mode',
    'mode_override', v_row.share_sections->>'mode',
    'modes', coalesce(v_modes,'[]'::jsonb),
    'sections', coalesce(v_sec,'[]'::jsonb));
end; $function$;
