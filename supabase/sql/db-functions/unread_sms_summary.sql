-- unread_sms_summary()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.unread_sms_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v jsonb;
begin
  v_role := coalesce(public.current_app_role(),'');
  if not (public.is_admin() or v_role in ('va','loa','agent','staff')) then
    raise exception 'not authorized'; end if;
  select jsonb_build_object(
    'unread_count', (select count(*) from app_notifications where kind='sms_inbound' and coalesce(is_read,false)=false),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('preview',preview,'contact_id',contact_id,'at',created_at) order by created_at desc),'[]'::jsonb)
       from (select preview, contact_id, created_at from app_notifications
             where kind='sms_inbound' and coalesce(is_read,false)=false
             order by created_at desc limit 6) s)
  ) into v;
  return v;
end; $function$;
