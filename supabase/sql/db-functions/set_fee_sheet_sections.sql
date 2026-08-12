-- set_fee_sheet_sections(p_slug text, p_sections jsonb)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public.set_fee_sheet_sections(p_slug text, p_sections jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_row public.fee_sheet_snapshots; v_clean jsonb;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  v_clean := jsonb_build_object(
    'lender_credits', coalesce((p_sections->>'lender_credits')::boolean, false),
    'fee_schedule',   coalesce((p_sections->>'fee_schedule')::boolean, false),
    'people',         coalesce((p_sections->>'people')::boolean, false),
    'bridge',         coalesce((p_sections->>'bridge')::boolean, false));

  /* REFUSE TO REVEAL A BRIDGE THAT CANNOT RENDER — the uby9s8x rule, applied at
     the moment the section is switched on rather than only at mint. Turning it
     on later would otherwise reintroduce exactly the state that guard prevents:
     a borrower opening a link whose section says the quote is unfinished. */
  if coalesce((v_clean->>'bridge')::boolean, false) then
    select * into v_row from public.fee_sheet_snapshots where slug = p_slug;
    if v_row.id is null then raise exception 'no such fee sheet link'; end if;
    if not public._fs_bridge_usable(v_row.data) then
      raise exception 'this link''s bridge addendum has no amount or no rate — it would tell the borrower the quote is unfinished';
    end if;
  end if;

  update public.fee_sheet_snapshots set share_sections = v_clean
   where slug = p_slug returning * into v_row;
  if v_row.id is null then raise exception 'no such fee sheet link'; end if;
  return v_clean;
end; $function$;
