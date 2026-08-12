-- CMA public payload: strip everything the page does not render.
--
-- The first pass (2026-08-12) removed `da_inputs` and gated `acquisition` /
-- `rental` on their include_ flags. It missed `acquisition.inputs`, which is the
-- SAME investor-modelling input set as `da_inputs` -- hold costs, hard-money rate
-- and points, LTC, ARV, appreciation and refinance assumptions -- one level down
-- inside a section that IS rendered. Stripping the top-level key while an
-- identical copy shipped nested underneath is why this is now an ALLOWLIST
-- rather than a list of things to delete.
--
-- NO PRE-COMPUTE IS NEEDED. Every number public/cma.html displays is either a
-- kept field or is derived client-side from kept fields:
--   * rental avg / median are computed in renderRental() from rental.comps[].rent, kept
--   * stats.compCount is rendered directly, with comps.length as the fallback, both kept
--   * renderAcquisition() reads ONLY acquisition.results.* and acquisition.property.*
--     -- never acquisition.inputs -- so dropping inputs moves nothing
-- This is the opposite of the fee sheet, where origComp fed subtotalA and had to
-- be replaced by a pre-computed origFee. There is no equivalent here.

-- Pick a set of keys off a jsonb object, skipping keys that are absent.
CREATE OR REPLACE FUNCTION public._jsonb_pick(p_obj jsonb, p_keys text[])
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select coalesce(jsonb_object_agg(k, p_obj -> k), '{}'::jsonb)
  from unnest(p_keys) as k
  where p_obj ? k;
$function$;

CREATE OR REPLACE FUNCTION public._cma_redact(p_data jsonb, p_acq boolean, p_rent boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
/* ALLOWLIST. Anything not named here does not reach an anonymous caller.
 *
 * THE TRADE-OFF, STATED ON PURPOSE: a field added to public/cma.html will render
 * as blank until it is added here too, because this function silently drops
 * unknown keys. That is the correct direction to fail on a borrower-facing
 * surface -- a missing figure is visible, a leaked one is not -- but it means
 * THIS LIST AND public/cma.html MUST BE EDITED TOGETHER. The render-check spec
 * for /cma asserts real figures on the page, so a forgotten key here shows up
 * as a failing check rather than a quiet blank.
 */
declare
  v   jsonb := coalesce(p_data, '{}'::jsonb);
  o   jsonb;
  a   jsonb;
  r   jsonb;
  res jsonb;
  arr jsonb;
  el  jsonb;
begin
  /* Top-level scalars. `v` is the payload FORMAT version -- it carries no
     property or borrower data and is what lets a future page detect an old
     snapshot, so it is kept deliberately rather than as an oversight. */
  o := public._jsonb_pick(v, array[
         'v','generated_at','borrower_name','property_address',
         'include_acquisition','include_rentals']);

  -- subject: renderCma() + subjectChips() + initMap()
  if jsonb_typeof(v->'subject') = 'object' then
    o := o || jsonb_build_object('subject', public._jsonb_pick(v->'subject', array[
           'address','propertyType','bedrooms','bathrooms','squareFootage',
           'latitude','longitude']));
  end if;

  -- value: the AVM headline and the gauge
  if jsonb_typeof(v->'value') = 'object' then
    o := o || jsonb_build_object('value',
           public._jsonb_pick(v->'value', array['estimate','low','high']));
  end if;

  /* stats: Market Snapshot. addedCount and soldCount are dropped -- computed by
     pull-comps, never rendered. */
  if jsonb_typeof(v->'stats') = 'object' then
    o := o || jsonb_build_object('stats', public._jsonb_pick(v->'stats', array[
           'avgPricePerSqft','medianPrice','avgPrice','compCount','radiusMiles']));
  end if;

  /* comps[]: compCard() + _pinTooltip() + _pinPopup() + initMap(). Dropped:
     id, correlation, daysOnMarket, description, listingType, lotSize, mlsName,
     mlsNumber, propertyType, source, yearBuilt -- raw MLS record fields carried
     straight through from pull-comps and never shown. */
  if jsonb_typeof(v->'comps') = 'array' then
    arr := '[]'::jsonb;
    for el in select * from jsonb_array_elements(v->'comps') loop
      arr := arr || jsonb_build_array(public._jsonb_pick(el, array[
               'address','status','price','pricePerSqft','photoUrl','listingUrl',
               'bedrooms','bathrooms','squareFootage','distance',
               'latitude','longitude','removedDate','lastSeenDate','listedDate']));
    end loop;
    o := o || jsonb_build_object('comps', arr);
  end if;

  -- rental: only when the flag says the section renders
  if coalesce(p_rent, false) and jsonb_typeof(v->'rental') = 'object' then
    r := public._jsonb_pick(v->'rental', array['estimate','low','high']);
    if jsonb_typeof(v->'rental'->'comps') = 'array' then
      arr := '[]'::jsonb;
      for el in select * from jsonb_array_elements(v->'rental'->'comps') loop
        arr := arr || jsonb_build_array(public._jsonb_pick(el, array[
                 'address','bedrooms','bathrooms','squareFootage','distance','rent']));
      end loop;
      r := r || jsonb_build_object('comps', arr);
    end if;
    o := o || jsonb_build_object('rental', r);
  end if;

  /* acquisition: only when the flag says the section renders, and then only the
     three strategy result sets and the property fundamentals renderAcquisition()
     actually prints. `inputs` is dropped -- see the header. Also dropped from
     results: flip.max_buy / total_project_cost / hm_loan / hm_points_amt /
     hm_interest_carry / profit_margin / coc, brrrr.new_loan / refi_pmt,
     buy_hold.bh_pmt / down_pmt -- all computed, none rendered. */
  if coalesce(p_acq, false) and jsonb_typeof(v->'acquisition') = 'object' then
    a := '{}'::jsonb;

    if jsonb_typeof(v->'acquisition'->'property') = 'object' then
      a := a || jsonb_build_object('property',
             public._jsonb_pick(v->'acquisition'->'property', array[
               'cap_rate','noi_annual','equity_y1','equity_y5','equity_y10',
               'appreciation_pct']));
    end if;

    res := '{}'::jsonb;
    if jsonb_typeof(v->'acquisition'->'results'->'flip') = 'object' then
      res := res || jsonb_build_object('flip',
               public._jsonb_pick(v->'acquisition'->'results'->'flip', array[
                 'gross_profit','roi','annualized_roi','cash_needed','rule_70_pass']));
    end if;
    if jsonb_typeof(v->'acquisition'->'results'->'brrrr') = 'object' then
      res := res || jsonb_build_object('brrrr',
               public._jsonb_pick(v->'acquisition'->'results'->'brrrr', array[
                 'cash_flow','cash_left','dscr','coc']));
    end if;
    if jsonb_typeof(v->'acquisition'->'results'->'buy_hold') = 'object' then
      res := res || jsonb_build_object('buy_hold',
               public._jsonb_pick(v->'acquisition'->'results'->'buy_hold', array[
                 'cash_flow','cash_invested','dscr','coc']));
    end if;
    a := a || jsonb_build_object('results', res);

    o := o || jsonb_build_object('acquisition', a);
  end if;

  return o;
end; $function$;
