-- send_stalled_deals_digest(p_dry_run boolean)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.send_stalled_deals_digest(p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  rpt jsonb;
  stalled jsonb;
  n int;
  v_subject text;
  v_html text;
  v_sms text;
  v_rows text := '';
  v_link text := 'https://admin.ratesandrealty.com/admin/lead-detail.html?contact_id=';
  v_dash text := 'https://admin.ratesandrealty.com/admin/reports.html';
  item jsonb;
  v_age int; v_loan text; v_lc text; v_color text;
  r record; v_sent int := 0; v_results jsonb := '[]'::jsonb;
begin
  if auth.role() = 'authenticated' and not is_admin() then raise exception 'admin only'; end if;

  rpt := pipeline_velocity_report();
  stalled := rpt -> 'stalled_deals';
  n := coalesce(jsonb_array_length(stalled), 0);

  if n = 0 then
    return jsonb_build_object('dry_run', p_dry_run, 'sent', 0, 'stalled', 0, 'note', 'No stalled deals — digest skipped.');
  end if;

  for item in select * from jsonb_array_elements(stalled)
  loop
    v_age  := (item->>'age_days')::int;
    v_loan := case when item->>'loan_amount' is not null
                   then '$' || to_char((item->>'loan_amount')::numeric, 'FM999,999,999')
                   else '—' end;
    v_lc   := coalesce(item->>'last_contact', '—');
    v_color := case when v_age > 90 then '#b3261e' when v_age >= 60 then '#C9A84C' else '#555' end;
    v_rows := v_rows
      || '<tr>'
      || '<td style="padding:8px 10px;border-bottom:1px solid #eee;"><a href="' || v_link || (item->>'id')
         || '" style="color:#1a1a1a;font-weight:600;text-decoration:none;">' || coalesce(item->>'name','(no name)') || '</a></td>'
      || '<td style="padding:8px 10px;border-bottom:1px solid #eee;color:#333;">' || coalesce(item->>'stage','—') || '</td>'
      || '<td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:700;color:' || v_color || ';">' || v_age || 'd</td>'
      || '<td style="padding:8px 10px;border-bottom:1px solid #eee;color:#333;">' || v_loan || '</td>'
      || '<td style="padding:8px 10px;border-bottom:1px solid #eee;color:#777;">' || v_lc || '</td>'
      || '</tr>';
  end loop;

  v_subject := '🔔 ' || n || ' deal' || case when n=1 then '' else 's' end || ' going cold — weekly pipeline check';

  v_html := '<div style="font-family:Arial,sans-serif;max-width:640px;">'
    || '<h2 style="color:#1a1a1a;margin:0 0 4px;">🔔 Deals that need attention</h2>'
    || '<p style="color:#555;font-size:14px;margin:0 0 14px;">' || n
    || ' active deal' || case when n=1 then ' has' else 's have' end
    || ' been in-stage 45+ days. Oldest first — these are at risk of going cold.</p>'
    || '<table style="border-collapse:collapse;width:100%;font-size:14px;">'
    || '<thead><tr style="background:#1a1a1a;color:#fff;text-align:left;">'
    || '<th style="padding:8px 10px;">Borrower</th><th style="padding:8px 10px;">Stage</th>'
    || '<th style="padding:8px 10px;">Age</th><th style="padding:8px 10px;">Loan</th>'
    || '<th style="padding:8px 10px;">Last contact</th></tr></thead>'
    || '<tbody>' || v_rows || '</tbody></table>'
    || '<p style="margin:16px 0 6px;"><a href="' || v_dash
    || '" style="display:inline-block;padding:10px 18px;background:#C9A84C;color:#1a1a1a;text-decoration:none;border-radius:6px;font-weight:700;">Open Pipeline Velocity →</a></p>'
    || '<p style="color:#999;font-size:12px;margin-top:10px;">Red = 90+ days, gold = 60+ days. Active working stages only (excludes new-lead import bucket).</p>'
    || '</div>';

  v_sms := '🔔 R&R weekly: ' || n || ' deal' || case when n=1 then '' else 's' end
        || ' going cold (45d+ in stage). Oldest: ' || (stalled->0->>'name') || ' (' || (stalled->0->>'age_days')
        || 'd, ' || (stalled->0->>'stage') || '). ' || v_dash;

  for r in
    select distinct on (aur.user_id) aur.user_id, u.email::text as email, aur.notify_phone
    from auth_user_roles aur join auth.users u on u.id = aur.user_id
    where aur.role = 'admin'
  loop
    if not p_dry_run then
      if r.email is not null and r.email <> '' then
        begin perform net.http_post(
          url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/email-service',
          headers := public.internal_call_headers(),
          body := jsonb_build_object('action','send','to_email',r.email,'subject',v_subject,'html',v_html));
        exception when others then null; end;
      end if;
      if r.notify_phone is not null and r.notify_phone <> '' then
        begin perform net.http_post(
          url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/sms-service',
          headers := public.internal_call_headers(),
          body := jsonb_build_object('trigger','custom','to_phone',r.notify_phone,
                                     'params', jsonb_build_object('message', v_sms)));
        exception when others then null; end;
      end if;
    end if;
    v_sent := v_sent + 1;
    v_results := v_results || jsonb_build_object('email', r.email, 'sms', (r.notify_phone is not null));
  end loop;

  return jsonb_build_object('dry_run', p_dry_run, 'sent', v_sent, 'stalled', n,
                            'subject', v_subject, 'sms_preview', v_sms, 'detail', v_results);
end;
$function$;
