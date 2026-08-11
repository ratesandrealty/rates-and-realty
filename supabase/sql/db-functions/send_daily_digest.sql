-- send_daily_digest(p_dry_run boolean)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.send_daily_digest(p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d jsonb; v_new int; v_new7 int; v_active int; v_due int; v_open int; v_hot int; v_quiet int;
  v_quiet_names text; v_subject text; v_html text;
  vp jsonb; v_va_done7 int; v_va_open int; v_va_overdue int; v_va_median numeric;
  v_link text := 'https://admin.ratesandrealty.com/dashboard/admin.html';
  r record; v_sent int := 0; v_results jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not is_admin() then raise exception 'admin only'; end if;

  d := dashboard_command_center();
  v_new    := coalesce((d->'kpis'->>'new_leads')::int,0);
  v_new7   := coalesce((d->'kpis'->>'new_leads_7d')::int,0);
  v_active := coalesce((d->'kpis'->>'active_pipeline')::int,0);
  v_due    := coalesce((d->'kpis'->>'tasks_due_today')::int,0);
  v_open   := coalesce((d->'kpis'->>'tasks_open')::int,0);
  v_hot    := coalesce((d->'kpis'->>'hot_leads')::int,0);
  v_quiet  := jsonb_array_length(d->'attention');

  vp := va_productivity_report((now() - interval '7 days')::date, now()::date);
  v_va_done7   := coalesce((vp->'kpis'->>'completed_in_range')::int, 0);
  v_va_open    := coalesce((vp->'kpis'->>'open_now')::int, 0);
  v_va_overdue := coalesce((vp->'kpis'->>'overdue_now')::int, 0);
  v_va_median  := coalesce((vp->'kpis'->>'median_turnaround_hrs')::numeric, 0);

  select string_agg((x->>'name') || ' (' || coalesce(x->>'days_quiet','?') || 'd)', ', ')
    into v_quiet_names
    from (select value as x from jsonb_array_elements(d->'attention') limit 3) t;

  v_subject := '☀️ Daily brief — ' || v_new || ' new leads, ' || v_active || ' active (' || v_quiet || ' quiet)';
  v_html := '<div style="font-family:Arial,sans-serif;max-width:560px;">'
    || '<h2 style="color:#1a1a1a;margin:0 0 8px;">☀️ Your daily brief</h2>'
    || '<ul style="font-size:15px;color:#333;line-height:1.7;">'
    || '<li><strong>' || v_new || '</strong> new leads to work'
       || case when v_new7>0 then ' (' || v_new7 || ' added this week)' else '' end || '</li>'
    || '<li><strong>' || v_active || '</strong> active deals — <strong>' || v_quiet || '</strong> gone quiet'
       || coalesce(': ' || v_quiet_names, '') || '</li>'
    || '<li><strong>' || v_due || '</strong> tasks due today (' || v_open || ' open total)</li>'
    || '<li><strong>' || v_hot || '</strong> hot leads</li>'
    || '</ul>'
    || '<div style="margin:14px 0 6px;padding:12px 14px;background:#F7F3E8;border-left:4px solid #C9A84C;border-radius:4px;font-size:14px;color:#333;line-height:1.7;">'
    || '<strong style="color:#1a1a1a;">VA productivity (last 7 days)</strong><br>'
    || '<strong>' || v_va_done7 || '</strong> tasks completed'
    || ' &nbsp;·&nbsp; <strong>' || v_va_open || '</strong> open now'
    || case when v_va_overdue > 0
            then ' &nbsp;·&nbsp; <strong style="color:#b3261e;">' || v_va_overdue || '</strong> overdue'
            else '' end
    || case when v_va_median > 0
            then ' &nbsp;·&nbsp; median turnaround <strong>' || v_va_median::text || 'h</strong>'
            else '' end
    || '</div>'
    || '<p><a href="' || v_link || '" style="display:inline-block;padding:10px 18px;background:#C9A84C;color:#1a1a1a;text-decoration:none;border-radius:6px;font-weight:700;">Open the dashboard →</a></p>'
    || '</div>';

  for r in
    select distinct on (aur.user_id) aur.user_id, u.email::text as email, aur.role
    from auth_user_roles aur join auth.users u on u.id = aur.user_id
    where aur.role in ('admin','va')
  loop
    if not p_dry_run then
      if r.email is not null and r.email <> '' then
        begin perform net.http_post(
          url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/email-service',
          headers := public.internal_call_headers(),
          body := jsonb_build_object('action','send','to_email',r.email,'subject',v_subject,'html',v_html));
        exception when others then null; end;
      end if;
      /* THE SMS HALF WAS REMOVED ON 2026-08-07. Do not restore it.
       *
       * It sent a condensed copy of the email above — same numbers, plus the
       * dashboard link — so it carried nothing the email does not. It reached
       * ONE number: only the admin row has a notify_phone, so the VA never got
       * it, while the email reaches them both.
       *
       * It had also been dead since 2026-07-31 with no establishable cause. Three
       * separate blockers accumulated afterwards (sms-service pinned verify_jwt
       * on 08-03, an in-function getUser() gate on 08-05, and this call carrying
       * no Authorization at all), but none of them explains the original stop,
       * and the Postgres layer had no git history before 08-05 to check against.
       *
       * Restoring it would have meant granting a database function the ability
       * to send from the business line — sms-service, which was an open SMS
       * relay on 2026-08-06. That is a bad trade for ~34 duplicate messages a
       * month to one phone.
       *
       * IF A PHONE NUDGE IS WANTED LATER, USE PUSH, NOT SMS. send-push and the
       * VAPID keys already exist, cost nothing per message, and need no grant on
       * the SMS relay. */
    end if;
    v_sent := v_sent + 1;
    v_results := v_results || jsonb_build_object('email', r.email, 'role', r.role);
  end loop;

  return jsonb_build_object('dry_run', p_dry_run, 'recipients', v_sent, 'subject', v_subject,
                            'va', jsonb_build_object(
                              'completed_7d', v_va_done7, 'open_now', v_va_open, 'overdue_now', v_va_overdue,
                              'median_turnaround_hrs', v_va_median),
                            'detail', v_results);
end; $function$;
