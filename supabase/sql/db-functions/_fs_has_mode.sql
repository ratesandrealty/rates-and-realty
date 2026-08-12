-- _fs_has_mode(p_data jsonb, p_mode text)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public._fs_has_mode(p_data jsonb, p_mode text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
begin
  if p_mode in ('rate','single') then
    return jsonb_array_length(coalesce(p_data->'scenarios','[]'::jsonb)) > 0;
  elsif p_mode = 'price' then
    return jsonb_array_length(coalesce(p_data->'price_scenarios','[]'::jsonb)) > 0;
  elsif p_mode = 'property' then
    return jsonb_array_length(coalesce(p_data->'property_scenarios','[]'::jsonb)) > 0;
  elsif p_mode = 'buydown' then
    /* Same rule create_fee_sheet_snapshot mints on: a rate, and a loan from
       either the explicit override or purchase price less down. */
    return coalesce(public._fs_num(p_data->'buydown'->>'rate'),0) > 0
       and (coalesce(public._fs_num(p_data->'buydown'->>'loan'),0) > 0
            or greatest(0, coalesce(public._fs_num(p_data->'common'->>'purchasePrice'),0)
                 - (coalesce(public._fs_num(p_data->'common'->>'purchasePrice'),0)
                    * coalesce(public._fs_num(p_data->'common'->>'downPct'),0) / 100)) > 0);
  elsif p_mode = 'heloc' then
    return coalesce(public._fs_num(p_data->'heloc'->>'draw'),0) > 0;
  end if;
  return false;
end; $function$;
