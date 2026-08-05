-- va_activity_summary(p_days integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_activity_summary(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v jsonb; v_since timestamptz := now() - make_interval(days => greatest(p_days,1));
begin
  v_role := coalesce(public.current_app_role(),'');
  if not (public.is_admin() or v_role in ('va','loa','agent','staff')) then
    raise exception 'not authorized'; end if;

  select jsonb_build_object(
    'days', p_days,
    'docs_uploaded', (select count(*) from uploaded_documents
        where uploaded_at >= v_since or created_at >= v_since),
    'notes_added', (select count(*) from order_notes
        where created_at >= v_since and coalesce(source,'') <> 'update_request'),
    'requests_sent', (select count(*) from order_notes
        where created_at >= v_since and source = 'update_request'),
    'recent', (select coalesce(jsonb_agg(x order by x.ts desc),'[]'::jsonb) from (
        select created_at as ts, 'request' as kind, note_text as label, contact_id
          from order_notes where created_at >= v_since and source='update_request'
        union all
        select created_at, 'note', note_text, contact_id
          from order_notes where created_at >= v_since and coalesce(source,'')<>'update_request'
        order by ts desc limit 8) x)
  ) into v;
  return v;
end; $function$;
