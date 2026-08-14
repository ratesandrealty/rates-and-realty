-- _fs_has_section(p_data jsonb, p_key text, p_mode text)
-- language: plpgsql
-- Captured from production 2026-08-14.

CREATE OR REPLACE FUNCTION public._fs_has_section(p_data jsonb, p_key text, p_mode text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  sc   jsonb := coalesce(p_data->'scenarios','[]'::jsonb);
  mode text  := coalesce(nullif(p_mode,''), p_data->>'mode', 'rate');
  bdpp numeric;
begin
  if p_key = 'bridge' then
    if mode not in ('rate','single') then return false; end if;
    return coalesce((p_data->'bridge'->>'on')::boolean, false);

  elsif p_key = 'buydown' then
    /* A SECTION, NOT THE MODE. In buydown mode the buydown IS the page, there is
       nothing to opt into, and a checkbox there would read as switching the page
       off. So it is offered only in the four comparison modes. */
    if mode not in ('rate','single','price','property') then return false; end if;
    /* The same three things buydownAddendumPub refuses on, in the same order: a
       note rate, a structure it knows how to draw, and a resolvable loan.
       BD_STRUCTURES in public/fee.html is the other half of this list — an
       unknown structure makes _bdSchedule return null and the addendum render
       nothing, which is exactly the dead-looking checkbox this avoids. */
    if coalesce(public._fs_num(p_data->'buydown'->>'rate'),0) <= 0 then return false; end if;
    if coalesce(nullif(p_data->'buydown'->>'structure',''),'2-1')
         not in ('1-0','1-1','2-1','3-2-1') then return false; end if;
    /* Loan basis, mirroring _bdLoan(): an explicit loan always works. The
       purchase-less-down fallback is sound only where the sheet has ONE loan
       basis — in price/property every column carries its own price, so the
       fallback would state a loan quoted nowhere on the page. */
    if coalesce(public._fs_num(p_data->'buydown'->>'loan'),0) > 0 then return true; end if;
    if mode in ('price','property') then return false; end if;
    bdpp := coalesce(public._fs_num(p_data->'common'->>'purchasePrice'),0);
    return greatest(0, bdpp - (bdpp * coalesce(public._fs_num(p_data->'common'->>'downPct'),0) / 100)) > 0;

  elsif p_key = 'people' then
    -- every renderer draws headerName, so this is mode-independent
    return jsonb_array_length(coalesce(p_data->'_people','[]'::jsonb)) > 1;

  elsif p_key = 'lender_credits' then
    if mode not in ('rate','single','price','property') then return false; end if;
    return exists (select 1 from jsonb_array_elements(sc) e
                   where coalesce(public._fs_num(e->>'lenderCredits'),0) <> 0);

  elsif p_key = 'fee_schedule' then
    if mode = 'heloc' then
      return coalesce(public._fs_num(p_data->'heloc'->>'draw'),0) > 0;
    end if;
    if mode not in ('rate','single','price','property') then return false; end if;
    if mode = 'price'    then return jsonb_array_length(coalesce(p_data->'price_scenarios','[]'::jsonb)) > 0; end if;
    if mode = 'property' then return jsonb_array_length(coalesce(p_data->'property_scenarios','[]'::jsonb)) > 0; end if;
    return jsonb_array_length(sc) > 0;
  end if;
  return false;
end; $function$;
