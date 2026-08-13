-- _fs_has_section(p_data jsonb, p_key text)
-- language: plpgsql
-- Captured from production 2026-08-13.

CREATE OR REPLACE FUNCTION public._fs_has_section(p_data jsonb, p_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare sc jsonb := coalesce(p_data->'scenarios','[]'::jsonb);
begin
  if p_key = 'bridge' then
    return coalesce((p_data->'bridge'->>'on')::boolean, false);
  elsif p_key = 'people' then
    return jsonb_array_length(coalesce(p_data->'_people','[]'::jsonb)) > 1;
  elsif p_key = 'lender_credits' then
    return exists (select 1 from jsonb_array_elements(sc) e
                   where coalesce(public._fs_num(e->>'lenderCredits'),0) <> 0);
  elsif p_key = 'fee_schedule' then
    return jsonb_array_length(sc) > 0;
  end if;
  return false;
end; $function$;
