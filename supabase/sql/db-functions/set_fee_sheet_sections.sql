-- set_fee_sheet_sections(p_slug text, p_sections jsonb)
-- language: plpgsql
-- Captured from production 2026-08-13.

CREATE OR REPLACE FUNCTION public.set_fee_sheet_sections(p_slug text, p_sections jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text; v_row public.fee_sheet_snapshots;
  v_cur jsonb; v_out jsonb; k text; v_valid jsonb; v_mode text; v_eff text; v_elsewhere text;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;

  select * into v_row from public.fee_sheet_snapshots where slug = p_slug;
  if v_row.id is null then raise exception 'no such fee sheet link'; end if;

  v_cur := coalesce(v_row.share_sections, '{}'::jsonb);
  v_out := v_cur;
  select jsonb_agg(x->>'key') into v_valid from jsonb_array_elements(public._fs_share_section_keys()) x;

  /* The EFFECTIVE mode is resolved once, up front, and includes a mode arriving
     in THIS patch. jsonb_object_keys has no defined order, so checking a section
     against the stored mode inside the loop would give a different verdict
     depending on which key Postgres happened to visit first. */
  if p_sections ? 'mode' then
    v_eff := coalesce(nullif(p_sections->>'mode',''), v_row.data->>'mode');
  else
    v_eff := coalesce(nullif(v_cur->>'mode',''), v_row.data->>'mode');
  end if;

  for k in select jsonb_object_keys(p_sections) loop
    if k = 'mode' then
      v_mode := nullif(p_sections->>'mode','');
      if v_mode is null then
        v_out := v_out - 'mode';
      else
        if not exists (select 1 from jsonb_array_elements(public._fs_share_mode_keys()) m
                        where m->>'key' = v_mode) then
          raise exception 'unknown comparison mode: %', v_mode;
        end if;
        if not public._fs_has_mode(v_row.data, v_mode) then
          raise exception 'this snapshot has no % data — the link would render an empty sheet', v_mode;
        end if;
        v_out := jsonb_set(v_out, '{mode}', to_jsonb(v_mode), true);
      end if;
    else
      if not (v_valid ? k) then
        raise exception 'unknown share section: %', k;
      end if;
      if coalesce((p_sections->>k)::boolean, false) then
        if not public._fs_has_section(v_row.data, k, v_eff) then
          /* Two different causes, two different fixes, so they must not share a
             message. "not shown in buydown mode" sent at someone whose snapshot
             simply has no co-borrower would have them switching modes forever. */
          select m->>'key' into v_elsewhere
            from jsonb_array_elements(public._fs_share_mode_keys()) m
           where public._fs_has_section(v_row.data, k, m->>'key')
             and public._fs_has_mode(v_row.data, m->>'key')
           limit 1;
          if v_elsewhere is null then
            raise exception 'this snapshot has no % to show', k;
          end if;
          raise exception 'the % section is not drawn in % mode — it shows in % mode', k, coalesce(v_eff,'this'), v_elsewhere;
        end if;
        if k = 'bridge' and not public._fs_bridge_usable(v_row.data) then
          raise exception 'this link''s bridge addendum has no amount or no rate — it would tell the borrower the quote is unfinished';
        end if;
      end if;
      v_out := jsonb_set(v_out, array[k], to_jsonb(coalesce((p_sections->>k)::boolean, false)), true);
    end if;
  end loop;

  update public.fee_sheet_snapshots set share_sections = v_out where slug = p_slug;
  return v_out;
end; $function$;
