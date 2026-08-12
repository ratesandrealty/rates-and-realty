-- get_fee_sheet_snapshot(p_slug text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-12. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.get_fee_sheet_snapshot(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* PUBLIC, ANONYMOUS. What this returns is a disclosure decision.
 *
 * origComp is stripped ALWAYS (see _fs_redact) — no opt-in, it is the comp rate.
 * Section visibility is OPT-IN: an absent key means hidden, so the ten links that
 * pre-date share_sections inherit the safe default with no backfill.
 *
 * WHAT CAN AND CANNOT BE REMOVED FROM THE PAYLOAD, stated because the difference
 * matters and is easy to get wrong:
 *   _people          — purely presentational, so it is genuinely REMOVED when
 *                      hidden. Nothing downstream reads it.
 *   lenderCredits    — feeds cashToClose (down + closing − credits − govFee). It
 *                      STAYS in the payload when the section is hidden, and only
 *                      the line item is suppressed on the page. Zeroing it would
 *                      raise the borrower's cash-to-close by the credit amount —
 *                      a privacy change that moves a number is a new problem, the
 *                      same trap the origFee work avoided.
 *   fee_schedule     — presentational only; the rates and points behind it are
 *                      needed to compute payments, so this hides the breakdown,
 *                      not the inputs.
 */
declare v_row public.fee_sheet_snapshots; v_data jsonb; v_sec jsonb;
begin
  select * into v_row from public.fee_sheet_snapshots where slug = p_slug;
  if v_row.id is null then return jsonb_build_object('status','not_found'); end if;
  if v_row.revoked_at is not null then
    return jsonb_build_object('status','revoked','revoked_at',v_row.revoked_at);
  end if;
  if v_row.expires_at is not null and v_row.expires_at <= now() then
    return jsonb_build_object('status','expired','expired_at',v_row.expires_at);
  end if;

  update public.fee_sheet_snapshots
     set view_count = view_count + 1, last_viewed_at = now()
   where id = v_row.id;

  v_sec := jsonb_build_object(
    'lender_credits', coalesce((v_row.share_sections->>'lender_credits')::boolean, false),
    'fee_schedule',   coalesce((v_row.share_sections->>'fee_schedule')::boolean, false),
    'people',         coalesce((v_row.share_sections->>'people')::boolean, false));

  v_data := public._fs_redact(v_row.data);
  if not (v_sec->>'people')::boolean then
    v_data := v_data - '_people';
  end if;

  return jsonb_build_object(
    'status','ok', 'slug', v_row.slug, 'data', v_data,
    'sections', v_sec,
    'borrower_name', v_row.borrower_name, 'created_at', v_row.created_at);
end; $function$;
