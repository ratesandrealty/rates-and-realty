-- notify_inbound_reply(p_contact_id uuid, p_message text, p_summary text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.notify_inbound_reply(p_contact_id uuid, p_message text, p_summary text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_enabled text; v_owner uuid; v_cell text;
  v_name text; v_first text; v_link text; v_preview text; v_sms text;
begin
  select value into v_enabled from app_config where key='inbound_notify_enabled';
  select value into v_cell    from app_config where key='owner_cell_phone';
  select value::uuid into v_owner from app_config where key='owner_user_id';

  select nullif(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')),''), first_name
    into v_name, v_first
  from contacts where id = p_contact_id;
  v_name  := coalesce(v_name, 'A lead');
  v_first := coalesce(v_first, 'lead');

  -- deep link to the conversation in the CRM (lead detail, text thread)
  v_link := 'https://admin.ratesandrealty.com/admin/lead-detail?contact_id='
            || p_contact_id || '#text';

  v_preview := left(coalesce(nullif(trim(p_summary),''), p_message), 140);

  -- dashboard notification (bell + badge pick this up via notifications_unread_count/list)
  insert into app_notifications(recipient_user_id, actor_display, kind, source_kind,
                                contact_id, preview, is_read)
  values (v_owner, v_name, 'sms_inbound', 'sms', p_contact_id,
          v_name || ' replied: ' || v_preview, false);

  -- text body for the owner's cell (kept short; deep link included)
  v_sms := '💬 ' || v_first || ' replied: "' || left(coalesce(nullif(trim(p_summary),''), p_message),110)
           || '"  Open & reply: ' || v_link;

  return jsonb_build_object(
    'notified', true,
    'enabled', coalesce(v_enabled,'true') = 'true',
    'owner_cell', v_cell,
    'sms_text', v_sms,
    'deep_link', v_link,
    'contact_name', v_name);
end; $function$;
