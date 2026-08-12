-- _fs_redact(p_data jsonb)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public._fs_redact(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
/* Strip the compensation RATE from a public fee-sheet payload and replace it
 * with the already-derived DOLLAR figure the page renders.
 *
 * origComp is the loan officer's compensation percentage. It has no business on
 * a borrower-facing link, and it was being returned to any anonymous caller with
 * the slug. The Origination FEE in dollars stays: it is a required borrower
 * disclosure and it feeds subtotalA -> totalLoanCosts -> cash to close, so
 * removing it would make the sheet stop reconciling.
 *
 * The arithmetic mirrors public/fee.html EXACTLY, which is the whole risk here:
 *   buildInp:      loanAmount = max(0, pp - pp*downPct/100)
 *   calcScenario:  origFee    = loanAmount * origComp/100
 *   calcPriceColumn:    origComp = col.origComp ?? 1.5, downPct = col.downPct ?? 20
 *   calcPropertyColumn: origComp is HARDCODED 1.5 — the stored column value is
 *                       ignored by the renderer, so it must be ignored here too
 *                       or property sheets would move.
 */
declare
  v jsonb := coalesce(p_data, '{}'::jsonb);
  c jsonb := coalesce(v->'common', '{}'::jsonb);
  la_common numeric;
  pp numeric; dp numeric;
  arr jsonb; el jsonb; out_arr jsonb; la numeric; comp numeric;
begin
  pp := public._fs_num(c->>'purchasePrice');
  dp := public._fs_num(c->>'downPct');
  la_common := greatest(0, pp - (pp * dp / 100));

  -- scenarios[] (rate / single): loan amount comes from `common`
  arr := v->'scenarios';
  if jsonb_typeof(arr) = 'array' then
    out_arr := '[]'::jsonb;
    for el in select * from jsonb_array_elements(arr) loop
      comp := coalesce((el->>'origComp')::numeric, 0);
      out_arr := out_arr || jsonb_build_array(
        (el - 'origComp') || jsonb_build_object('origFee', round(la_common * comp / 100, 2)));
    end loop;
    v := jsonb_set(v, '{scenarios}', out_arr);
  end if;

  -- price_scenarios[]: per-column purchase price / down %, per-column origComp (default 1.5)
  arr := v->'price_scenarios';
  if jsonb_typeof(arr) = 'array' then
    out_arr := '[]'::jsonb;
    for el in select * from jsonb_array_elements(arr) loop
      pp := coalesce((el->>'purchasePrice')::numeric, 0);
      dp := coalesce((el->>'downPct')::numeric, 20);
      la := greatest(0, pp - (pp * dp / 100));
      comp := coalesce((el->>'origComp')::numeric, 1.5);
      out_arr := out_arr || jsonb_build_array(
        (el - 'origComp') || jsonb_build_object('origFee', round(la * comp / 100, 2)));
    end loop;
    v := jsonb_set(v, '{price_scenarios}', out_arr);
  end if;

  -- property_scenarios[]: renderer hardcodes origComp 1.5
  arr := v->'property_scenarios';
  if jsonb_typeof(arr) = 'array' then
    out_arr := '[]'::jsonb;
    for el in select * from jsonb_array_elements(arr) loop
      pp := coalesce((el->>'purchasePrice')::numeric, 0);
      dp := coalesce((el->>'downPct')::numeric, 20);
      la := greatest(0, pp - (pp * dp / 100));
      out_arr := out_arr || jsonb_build_array(
        (el - 'origComp') || jsonb_build_object('origFee', round(la * 1.5 / 100, 2)));
    end loop;
    v := jsonb_set(v, '{property_scenarios}', out_arr);
  end if;

  return v;
end; $function$;
