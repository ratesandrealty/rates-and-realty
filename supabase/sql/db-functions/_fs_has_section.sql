-- _fs_has_section(p_data jsonb, p_key text, p_mode text)
-- language: plpgsql
-- Captured from production 2026-08-13.

CREATE OR REPLACE FUNCTION public._fs_has_section(p_data jsonb, p_key text, p_mode text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  sc   jsonb := coalesce(p_data->'scenarios','[]'::jsonb);
  mode text  := coalesce(nullif(p_mode,''), p_data->>'mode', 'rate');
begin
  if p_key = 'bridge' then
    if mode not in ('rate','single') then return false; end if;
    return coalesce((p_data->'bridge'->>'on')::boolean, false);

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
