-- _fs_share_mode_keys()
-- language: sql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public._fs_share_mode_keys()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select '[
    {"key":"rate",     "label":"Rate Comparison"},
    {"key":"single",   "label":"Single Rate"},
    {"key":"price",    "label":"Price Comparison"},
    {"key":"property", "label":"Property Comparison"},
    {"key":"buydown",  "label":"Buydown"},
    {"key":"heloc",    "label":"HELOC"}
  ]'::jsonb;
$function$;
