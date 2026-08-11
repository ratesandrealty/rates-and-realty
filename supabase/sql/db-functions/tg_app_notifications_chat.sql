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
  v_phone text; v_cuid bigint; v_req bigint;
  v_sender text := coalesce(nullif(trim(new.actor_display),''),'A teammate');
  v_prev   text := coalesce(nullif(trim(new.preview),''),'(new message)');
  v_url    text := 'https://admin.ratesandrealty.com/dashboard/admin#chat';
begin
  /* EMAIL ARM REMOVED 2026-08-10 — same reasoning as the SMS arm on 08-07,
   * which is recorded a few lines below and applies unchanged with a higher
   * volume. It duplicated what the bell already delivers; chat is a fast medium
   * and an email per message is a slow copy of a fast thing, arriving after the
   * conversation has moved on. It was also the loudest survivor: 21 emails for
   * one conversation in 64 minutes.
   *
   * Combined with the upsert in staff_message_send, a conversation now produces
   * 1 bell entry + 1 ClickUp task + 0 emails, down from 21 / 21 / 21.
   *
   * If an away-from-desk nudge is wanted, use send-push and the existing VAPID
   * keys — which is what the SMS note below already recommended. */

  /* SMS half removed 2026-08-07 — see send_daily_digest for the full reasoning.
   * It duplicated what the chat notification already delivers in-app, reached
   * only the one admin phone, and restoring it meant granting a Postgres
   * function the ability to send from the business line. */

  begin
    select clickup_user_id into v_cuid from public.auth_user_roles
      where user_id = new.recipient_user_id and clickup_user_id is not null limit 1;
    if v_cuid is not null then
      /* Capture the request id. pg_net is fire-and-forget, so the function's
         returned clickup_task_id was previously discarded and the task became
         unreachable — which is why clearing the backlog had to match on a title
         string instead of a key. The id is recorded here and reconciled from
         net._http_response by the sweep; retention there is ~6 hours, which is
         far longer than the round trip. */
      select net.http_post(
        url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/clickup-mention-ping',
        headers := public.internal_call_headers(),
        body := jsonb_build_object('title','💬 New message from '||v_sender,
          'description',v_prev||E'\n\nOpen chat: '||v_url,'priority','normal',
          'assignees',jsonb_build_array(v_cuid))) into v_req;
      if v_req is not null then
        update public.app_notifications
           set external_task_id = 'pending:'||v_req::text
         where id = new.id;
      end if;
    end if;
  exception when others then null; end;

  return new;
exception when others then return new;
end; $function$;
