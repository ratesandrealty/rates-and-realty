-- dashboard_layout_save(p_section_order jsonb, p_hidden_sections jsonb, p_layout_version integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.dashboard_layout_save(p_section_order jsonb, p_hidden_sections jsonb, p_layout_version integer DEFAULT 4)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.user_dashboard_layout(user_id, section_order, hidden_sections, layout_version, updated_at)
  values (auth.uid(), coalesce(p_section_order,'[]'::jsonb), coalesce(p_hidden_sections,'[]'::jsonb),
          coalesce(p_layout_version,4), now())
  on conflict (user_id) do update
    set section_order   = excluded.section_order,
        hidden_sections = excluded.hidden_sections,
        layout_version  = excluded.layout_version,
        updated_at      = now();
  return jsonb_build_object('ok', true);
end; $function$;
