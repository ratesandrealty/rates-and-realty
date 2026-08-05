-- sms_thread(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sms_thread(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v jsonb;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id,
      'direction', s.direction,
      'from', s.from_phone,
      'to', s.to_phone,
      'body', s.body,
      'status', s.status,
      'at', coalesce(s.sent_at, s.created_at),
      'scheduled_at', s.scheduled_at,
      'is_scheduled', (s.status = 'scheduled'),
      'media_url', s.media_url,
      'trigger', s.trigger_type
    ) order by coalesce(s.scheduled_at, s.sent_at, s.created_at)), '[]'::jsonb)
  into v
  from public.sms_log s
  where s.contact_id = p_contact_id
    and coalesce(s.status,'') <> 'cancelled';

  return jsonb_build_object('contact_id', p_contact_id, 'events', v);
end; $function$;
