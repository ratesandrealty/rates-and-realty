-- _fs_bridge_usable(p_data jsonb)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public._fs_bridge_usable(p_data jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  b jsonb := coalesce(p_data->'bridge', '{}'::jsonb);
  v numeric; c numeric; bal numeric; amt numeric; rate numeric;
begin
  if not coalesce((b->>'on')::boolean, false) then return true; end if;
  v    := coalesce(public._fs_num(b->>'value'), 0);
  c    := coalesce(public._fs_num(b->>'cltv'), 0);
  bal  := coalesce(public._fs_num(b->>'balance'), 0);
  rate := coalesce(public._fs_num(b->>'rate'), 0);
  amt  := greatest(0, (v * c / 100) - bal);
  return amt > 0 and rate > 0;
end; $function$;
