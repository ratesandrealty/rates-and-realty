-- dashboard_layout_get()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.dashboard_layout_get()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select jsonb_build_object(
           'section_order', section_order,
           'hidden_sections', hidden_sections,
           'layout_version', layout_version,
           'updated_at', updated_at)
    into v from public.user_dashboard_layout where user_id = auth.uid();
  return coalesce(v, jsonb_build_object('section_order', null, 'hidden_sections', null,
                                        'layout_version', null, 'updated_at', null));
end; $function$;
