-- _fs_share_section_keys()
-- language: sql
-- Captured from production 2026-08-14.

CREATE OR REPLACE FUNCTION public._fs_share_section_keys()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  /* Order is display order. Labels say what becomes VISIBLE — a control labelled
     with what it HIDES gets read backwards about half the time, and reading this
     one backwards is how compensation reaches an agent. */
  select '[
    {"key":"fee_schedule",   "label":"Fee breakdown"},
    {"key":"lender_credits", "label":"Lender credits"},
    {"key":"people",         "label":"Co-borrowers"},
    {"key":"bridge",         "label":"Bridge addendum"},
    {"key":"buydown",        "label":"Buydown schedule"}
  ]'::jsonb;
$function$;
