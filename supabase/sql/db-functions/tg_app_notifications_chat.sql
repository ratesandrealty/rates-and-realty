-- tg_app_notifications_chat()
-- language: plpgsql   SECURITY DEFINER
-- Captured 2026-08-06 (quiet hours).

CREATE OR REPLACE FUNCTION public.tg_app_notifications_chat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email text; v_phone text; v_cuid bigint;
  v_sender text := coalesce(nullif(trim(new.actor_display),''),'A teammate');
  v_prev   text := coalesce(nullif(trim(new.preview),''),'(new message)');
  v_url    text := 'https://admin.ratesandrealty.com/dashboard/admin#chat';
begin
  begin
    select u.email::text into v_email from auth.users u where u.id = new.recipient_user_id;
    if v_email is not null and v_email <> '' then
      perform net.http_post(
        url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/email-service',
        headers := public.internal_call_headers(),
        body := jsonb_build_object('action','send','to_email',v_email,
          'subject','💬 New message from '||v_sender,
          'html','<div style="font-family:Arial,sans-serif;max-width:560px;"><p style="font-size:15px;"><strong>'||v_sender||'</strong> sent you a message:</p><blockquote style="margin:0 0 18px;padding:12px 14px;border-left:3px solid #C9A84C;background:#faf7ef;border-radius:4px;white-space:pre-wrap;">'||v_prev||'</blockquote><p><a href="'||v_url||'" style="display:inline-block;padding:11px 20px;background:#C9A84C;color:#1a1a1a;text-decoration:none;border-radius:6px;font-weight:700;">Open chat →</a></p></div>'));
    end if;
  exception when others then null; end;

  begin
    select notify_phone into v_phone from public.auth_user_roles
      where user_id = new.recipient_user_id and notify_phone is not null limit 1;
    if v_phone is not null and v_phone <> '' and not public.is_quiet_hours(new.recipient_user_id) then
      perform net.http_post(
        url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/sms-service',
        headers := public.internal_call_headers(),
        body := jsonb_build_object('trigger','custom','to_phone',v_phone,
          'params', jsonb_build_object('message','💬 New message from '||v_sender||': '||left(v_prev,110)||E'\n'||v_url)));
    end if;
  exception when others then null; end;

  begin
    select clickup_user_id into v_cuid from public.auth_user_roles
      where user_id = new.recipient_user_id and clickup_user_id is not null limit 1;
    if v_cuid is not null then
      perform net.http_post(
        url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/clickup-mention-ping',
        headers := public.internal_call_headers(),
        body := jsonb_build_object('title','💬 New message from '||v_sender,
          'description',v_prev||E'\n\nOpen chat: '||v_url,'priority','normal','assignees',jsonb_build_array(v_cuid)));
    end if;
  exception when others then null; end;

  return new;
exception when others then return new;
end; $function$;
