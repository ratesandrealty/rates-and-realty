-- _cma_redact(p_data jsonb, p_acq boolean, p_rent boolean)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public._cma_redact(p_data jsonb, p_acq boolean, p_rent boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
/* ALLOWLIST. Anything not named here does not reach an anonymous caller.
 *
 * THE TRADE-OFF, STATED ON PURPOSE: a field added to public/cma.html renders
 * blank until it is added here too, because this drops unknown keys. That is the
 * correct direction to fail on a borrower-facing surface -- a missing figure is
 * visible, a leaked one is not -- but THIS LIST AND public/cma.html MUST BE
 * EDITED TOGETHER. The render-check spec for /cma asserts real figures, so a
 * forgotten key fails a check rather than going quietly blank.
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
  /* `v` is the payload FORMAT version -- no property or borrower data, and it is
     what lets a future page detect an old snapshot. Kept deliberately. */
  o := public._jsonb_pick(v, array[
         'v','generated_at','borrower_name','property_address',
         'include_acquisition','include_rentals']);

  if jsonb_typeof(v->'subject') = 'object' then
    o := o || jsonb_build_object('subject', public._jsonb_pick(v->'subject', array[
           'address','propertyType','bedrooms','bathrooms','squareFootage',
           'latitude','longitude']));
  end if;

  if jsonb_typeof(v->'value') = 'object' then
    o := o || jsonb_build_object('value',
           public._jsonb_pick(v->'value', array['estimate','low','high']));
  end if;

  /* stats: addedCount and soldCount dropped -- computed by pull-comps, never rendered. */
  if jsonb_typeof(v->'stats') = 'object' then
    o := o || jsonb_build_object('stats', public._jsonb_pick(v->'stats', array[
           'avgPricePerSqft','medianPrice','avgPrice','compCount','radiusMiles']));
  end if;

  /* comps[]: dropped id, correlation, daysOnMarket, description, listingType,
     lotSize, mlsName, mlsNumber, propertyType, source, yearBuilt -- raw MLS
     record fields carried through from pull-comps and never shown. */
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

  /* acquisition: `inputs` dropped -- see header. Also dropped from results:
     flip.max_buy / total_project_cost / hm_loan / hm_points_amt /
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
