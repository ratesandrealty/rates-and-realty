-- get_fee_sheet_snapshot(p_slug text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-14. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.get_fee_sheet_snapshot(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.fee_sheet_snapshots; v_data jsonb; v_sec jsonb; v_mode text;
begin
  select * into v_row from public.fee_sheet_snapshots where slug = p_slug;
  if v_row.id is null then return jsonb_build_object('status','not_found'); end if;
  /* Archived is reported as REVOKED, deliberately. Archiving is a tidy-up of
     Rene's panel; to whoever holds the link it must be the same refusal, with
     the same word, as a link that was pulled. A distinct status would leak the
     fact that the link still exists and tell a borrower they were filed away. */
  if v_row.revoked_at is not null or v_row.archived_at is not null then
    return jsonb_build_object('status','revoked',
             'revoked_at', coalesce(v_row.revoked_at, v_row.archived_at));
  end if;
  if v_row.expires_at is not null and v_row.expires_at <= now() then
    return jsonb_build_object('status','expired','expired_at',v_row.expires_at);
  end if;

  update public.fee_sheet_snapshots
     set view_count = view_count + 1, last_viewed_at = now()
   where id = v_row.id;

  v_mode := coalesce(nullif(v_row.share_sections->>'mode',''), v_row.data->>'mode');

  select coalesce(jsonb_object_agg(
           k->>'key',
           coalesce((v_row.share_sections->>(k->>'key'))::boolean, false)
             and public._fs_has_section(v_row.data, k->>'key', v_mode)), '{}'::jsonb)
    into v_sec
  from jsonb_array_elements(public._fs_share_section_keys()) k;

  v_data := public._fs_redact(v_row.data);
  if v_mode is not null then v_data := jsonb_set(v_data, '{mode}', to_jsonb(v_mode), true); end if;
  if not coalesce((v_sec->>'people')::boolean,false) then
    v_data := v_data - '_people';
  end if;
  /* NOT MERELY HIDDEN — REMOVED, same as _people. A section that is off must not
     ship its numbers to an anonymous holder of the URL, or "hidden" is a CSS
     claim rather than a disclosure one.
     Guarded on the MODE: in buydown mode the buydown is the whole page and the
     section flag is always false there (see _fs_has_section), so an unguarded
     strip would blank every buydown link. */
  if coalesce(v_mode,'') <> 'buydown'
     and not coalesce((v_sec->>'buydown')::boolean,false) then
    v_data := v_data - 'buydown';
  end if;
  /* Same rule for the bridge, and it matters more: data.bridge holds the value
     and mortgage balance of somebody's OTHER property. No mode guard is needed
     here, unlike buydown — there is no bridge MODE, so the flag being false
     always means the section is off. */
  if not coalesce((v_sec->>'bridge')::boolean,false) then
    v_data := v_data - 'bridge';
  end if;

  return jsonb_build_object(
    'status','ok', 'slug', v_row.slug, 'data', v_data,
    'sections', v_sec,
    'borrower_name', v_row.borrower_name, 'created_at', v_row.created_at);
end; $function$;
