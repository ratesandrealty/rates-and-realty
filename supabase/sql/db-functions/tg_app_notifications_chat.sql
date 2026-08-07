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

  /* SMS half removed 2026-08-07 — see send_daily_digest for the full reasoning.
   * It duplicated what the chat notification already delivers in-app and by
   * email, reached only the one admin phone, and restoring it meant granting a
   * Postgres function the ability to send from the business line. This path was
   * also the riskiest of the four: it fired per app_notifications INSERT, and
   * that table went from 22 rows all-time to 16 in a single week once the
   * share-nudge and task-note work started writing to it. If a phone nudge is
   * wanted, use send-push and the existing VAPID keys, not SMS. */

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
