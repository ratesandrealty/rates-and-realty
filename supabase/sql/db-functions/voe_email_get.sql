-- voe_email_get(p_email_log_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-18. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.voe_email_get(p_email_log_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text;
  e public.email_log;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if not (
       public.is_admin()
       or v_role = 'service_role'
       or coalesce(public.current_app_role(), '') in ('va','loa','agent','staff')
     ) then
    raise exception 'not authorized';
  end if;

  select * into e from public.email_log where id = p_email_log_id;

  -- Only expose VOE-related emails through this endpoint (not a generic mail reader).
  if e.id is null
     or not (e.template = 'voe_request'
             or coalesce(e.subject,'') ilike '%verification of employment%'
             or coalesce(e.subject,'') ilike '%VOE%') then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true,
    'id', e.id,
    'direction', e.direction,
    'from', e.from_email,
    'to', e.to_email,
    'cc', e.cc_email,
    'subject', e.subject,
    'body_html', e.body_html,
    'body_text', e.body_text,
    'status', e.status,
    'at', e.created_at,
    -- attachments: [] rather than null, so the caller has one shape to render.
    'attachments', coalesce(e.attachments, '[]'::jsonb)
  );
end; $function$;
