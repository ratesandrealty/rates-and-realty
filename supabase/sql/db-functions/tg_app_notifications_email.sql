-- tg_app_notifications_email()
-- language: plpgsql   SECURITY DEFINER
-- Captured 2026-08-06 (quiet hours).

CREATE OR REPLACE FUNCTION public.tg_app_notifications_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email      text;
  v_actor      text := coalesce(new.actor_display, 'Someone');
  v_lead_name  text;
  v_task_title text;
  v_context    text;
  v_url        text;
  v_note       text;
  v_subject    text;
  v_html       text;
  v_when       text;
  v_cuid       bigint;
  v_phone      text;
  v_sms        text;
  v_is_reminder boolean := (new.kind = 'reminder');
  v_actor_clean text := regexp_replace(coalesce(new.actor_display,'Rene'), '\s*\(reminder to self\)\s*', '', 'g');
begin
  if new.contact_id is not null then
    select nullif(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')), '')
      into v_lead_name from contacts c where c.id = new.contact_id;
  end if;

  v_note := coalesce(regexp_replace(coalesce(new.preview,''), '<[^>]*>', '', 'g'), '');
  if new.source_kind = 'contact_note' and new.source_id is not null then
    select coalesce(cn.note_text, v_note) into v_note from contact_notes cn where cn.id = new.source_id;
  elsif new.source_kind = 'task_note' and new.source_id is not null then
    select t.title into v_task_title from tasks t where t.id = new.source_id;
  end if;
  v_note := coalesce(nullif(trim(v_note),''), new.preview, '(no text)');

  if new.source_kind = 'task_note' then
    v_context := 'on the task' || coalesce(' "' || v_task_title || '"', '') || coalesce(' for ' || v_lead_name, '');
    if new.contact_id is not null then
      v_url := 'https://admin.ratesandrealty.com/admin/lead-detail.html?contact_id=' || new.contact_id
               || '#vatask=' || coalesce(new.source_id::text, '');
    else
      v_url := 'https://admin.ratesandrealty.com/admin/people.html';
    end if;
  else
    v_context := 'in a note on ' || coalesce('the lead ' || v_lead_name, 'a lead');
    if new.contact_id is not null then
      v_url := 'https://admin.ratesandrealty.com/admin/lead-detail.html?contact_id=' || new.contact_id;
    else
      v_url := 'https://admin.ratesandrealty.com/admin/people.html';
    end if;
  end if;

  select u.email::text into v_email from auth.users u where u.id = new.recipient_user_id;
  if v_email is not null and v_email <> '' then
    v_when := to_char(new.created_at at time zone 'America/Los_Angeles', 'Mon DD, YYYY "at" HH12:MI AM') || ' PT';

    if v_is_reminder then
      v_subject := '🔔 Reminder' || coalesce(' — ' || v_lead_name, '');
      v_html :=
        '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;">'
        || '<p style="font-size:15px;color:#1a1a1a;margin:0 0 4px;"><strong>Reminder to yourself</strong> '
           || v_context || '.</p>'
        || '<p style="color:#777;font-size:12px;margin:0 0 14px;">' || v_when || '</p>'
        || '<blockquote style="margin:0 0 18px;padding:12px 14px;border-left:3px solid #C9A84C;background:#faf7ef;color:#1a1a1a;border-radius:4px;white-space:pre-wrap;">' || v_note || '</blockquote>'
        || '<p style="margin:0 0 8px;"><a href="' || v_url || '" style="display:inline-block;padding:11px 20px;background:#C9A84C;color:#1a1a1a;text-decoration:none;border-radius:6px;font-weight:700;">Open '
           || coalesce(v_lead_name || '''s lead', 'in the CRM') || ' →</a></p>'
        || '<p style="color:#aaa;font-size:11px;margin:14px 0 0;">You set this reminder by @-mentioning yourself in the Rates &amp; Realty CRM.</p>'
        || '</div>';
    else
      v_subject := v_actor_clean || ' mentioned you' || coalesce(' — ' || v_lead_name, '');
      v_html :=
        '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;">'
        || '<p style="font-size:15px;color:#1a1a1a;margin:0 0 4px;"><strong>' || v_actor_clean || '</strong> mentioned you ' || v_context || '.</p>'
        || '<p style="color:#777;font-size:12px;margin:0 0 14px;">' || v_when || '</p>'
        || '<blockquote style="margin:0 0 18px;padding:12px 14px;border-left:3px solid #C9A84C;background:#faf7ef;color:#1a1a1a;border-radius:4px;white-space:pre-wrap;">' || v_note || '</blockquote>'
        || '<p style="margin:0 0 8px;"><a href="' || v_url || '" style="display:inline-block;padding:11px 20px;background:#C9A84C;color:#1a1a1a;text-decoration:none;border-radius:6px;font-weight:700;">Open '
           || coalesce(v_lead_name || '''s lead', 'in the CRM') || ' →</a></p>'
        || '<p style="color:#aaa;font-size:11px;margin:14px 0 0;">You received this because you were @-mentioned in the Rates &amp; Realty CRM.</p>'
        || '</div>';
    end if;

    begin
      perform net.http_post(
        url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/email-service',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := jsonb_build_object('action','send','to_email',v_email,'subject',v_subject,'html',v_html)
      );
    exception when others then null; end;
  end if;

  select clickup_user_id into v_cuid
  from auth_user_roles where user_id = new.recipient_user_id and clickup_user_id is not null limit 1;
  if v_cuid is not null then
    begin
      perform net.http_post(
        url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/clickup-mention-ping',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := jsonb_build_object(
          'title', case when v_is_reminder then '🔔 Reminder' else '💬 ' || v_actor_clean || ' mentioned you' end || coalesce(' — ' || v_lead_name, ''),
          'description', v_note || E'\n\nOpen the lead: ' || v_url,
          'priority', 'high',
          'assignees', jsonb_build_array(v_cuid))
      );
    exception when others then null; end;
  end if;

  select notify_phone into v_phone
  from auth_user_roles where user_id = new.recipient_user_id and notify_phone is not null limit 1;
  if v_phone is not null and v_phone <> '' and not public.is_quiet_hours(new.recipient_user_id) then
    v_sms := case when v_is_reminder then '🔔 Reminder' else '💬 ' || v_actor_clean || ' mentioned you' end
             || coalesce(' on ' || v_lead_name, '') || ': '
             || left(v_note, 90) || E'\n' || v_url;
    begin
      perform net.http_post(
        url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/sms-service',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := jsonb_build_object('trigger','custom','to_phone',v_phone,
                                   'params', jsonb_build_object('message', v_sms))
      );
    exception when others then null; end;
  end if;

  return new;
exception when others then
  return new;
end;
$function$;
