-- app_notify_mentions(p_source_kind text, p_source_id uuid, p_body text, p_actor_user_id uuid, p_actor_display text, p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.app_notify_mentions(p_source_kind text, p_source_id uuid, p_body text, p_actor_user_id uuid, p_actor_display text, p_contact_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  m text; v_uid uuid; n int := 0; v_preview text;
  v_pemail text; v_pname text; v_pid uuid;
  v_lead_name text; v_lead_email text; v_lead_phone text; v_lead_loan text; v_lead_status text;
  v_url text; v_subject text; v_html text; v_when text; v_note text;
  v_actor text; v_summary text; v_is_self boolean;
begin
  if coalesce(trim(p_body),'') = '' then return 0; end if;
  v_preview := left(regexp_replace(p_body, '\s+', ' ', 'g'), 180);
  v_note := coalesce(nullif(trim(p_body),''), '(no text)');
  v_actor := coalesce(nullif(trim(p_actor_display),''), 'Rene Duarte');

  if p_contact_id is not null then
    select nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
           c.email, c.phone, coalesce(c.loan_type, c.closing_loan_type), c.pipeline_status
      into v_lead_name, v_lead_email, v_lead_phone, v_lead_loan, v_lead_status
    from contacts c where c.id = p_contact_id;
    v_url := 'https://admin.ratesandrealty.com/admin/lead-detail.html?contact_id=' || p_contact_id;
  end if;
  v_when := to_char(now() at time zone 'America/Los_Angeles', 'Mon DD, YYYY "at" HH12:MI AM') || ' PT';

  for m in
    select distinct lower(arr[1])
    from regexp_matches(p_body, '@([A-Za-z0-9._-]+)', 'g') as t(arr)
  loop
    select aur.user_id into v_uid
    from auth_user_roles aur
    join auth.users u on u.id = aur.user_id
    where lower(split_part(u.email,'@',1)) = m
    limit 1;

    if v_uid is not null then
      v_is_self := (v_uid = p_actor_user_id);
      insert into public.app_notifications(recipient_user_id, actor_user_id, actor_display, kind,
                                           source_kind, source_id, contact_id, preview)
      values (v_uid, p_actor_user_id,
              case when v_is_self then v_actor || ' (reminder to self)' else v_actor end,
              case when v_is_self then 'reminder' else 'mention' end,
              p_source_kind, p_source_id, p_contact_id, v_preview);
      n := n + 1;
      continue;
    end if;

    if m like 'rp-%' then
      select t.partner_id, t.display, t.email
        into v_pid, v_pname, v_pemail
      from team_roster() t
      where t.kind = 'partner' and t.handle = m
      limit 1;

      if v_pemail is not null and v_pemail <> '' then
        v_subject := v_actor || ' shared a lead with you'
                     || coalesce(' — ' || v_lead_name, '');

        v_html :=
          '<div style="font-family:''Segoe UI'',Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">'
          || '<div style="background:#1a1a1a;border-radius:10px 10px 0 0;padding:20px 24px;">'
          ||   '<div style="color:#C9A84C;font-size:13px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;">Rates &amp; Realty</div>'
          ||   '<div style="color:#ffffff;font-size:20px;font-weight:700;margin-top:4px;">New Lead Shared With You</div>'
          || '</div>'
          || '<div style="border:1px solid #e6e6e6;border-top:none;border-radius:0 0 10px 10px;padding:24px;">'
          ||   '<p style="font-size:15px;color:#1a1a1a;margin:0 0 4px;line-height:1.5;"><strong>'
                 || v_actor || '</strong> mentioned you'
                 || coalesce(' and shared <strong>' || v_lead_name || '</strong>', '')
                 || ' with you.</p>'
          ||   '<p style="color:#777;font-size:12px;margin:0 0 20px;">' || v_when || '</p>'
          ||   '<div style="background:#faf8f2;border:1px solid #eadfc2;border-radius:8px;padding:16px 18px;margin:0 0 20px;">'
          ||     '<div style="font-size:12px;font-weight:700;color:#9a7d2e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Lead Details</div>'
          ||     '<table style="width:100%;border-collapse:collapse;font-size:14px;color:#1a1a1a;">'
          ||       case when v_lead_name   is not null then '<tr><td style="padding:5px 0;color:#666;width:110px;">Name</td><td style="padding:5px 0;font-weight:700;color:#111;">'||v_lead_name||'</td></tr>' else '' end
          ||       case when v_lead_email  is not null then '<tr><td style="padding:5px 0;color:#666;">Email</td><td style="padding:5px 0;color:#111;"><a href="mailto:'||v_lead_email||'" style="color:#1a5fb4;text-decoration:none;">'||v_lead_email||'</a></td></tr>' else '' end
          ||       case when v_lead_phone  is not null then '<tr><td style="padding:5px 0;color:#666;">Phone</td><td style="padding:5px 0;color:#111;"><a href="tel:'||v_lead_phone||'" style="color:#1a5fb4;text-decoration:none;">'||v_lead_phone||'</a></td></tr>' else '' end
          ||       case when v_lead_loan   is not null then '<tr><td style="padding:5px 0;color:#666;">Loan Type</td><td style="padding:5px 0;font-weight:600;color:#111;">'||v_lead_loan||'</td></tr>' else '' end
          ||       case when v_lead_status is not null then '<tr><td style="padding:5px 0;color:#666;">Status</td><td style="padding:5px 0;color:#111;">'||v_lead_status||'</td></tr>' else '' end
          ||     '</table>'
          ||   '</div>'
          ||   '<div style="font-size:12px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.5px;margin:0 0 6px;">Note from ' || v_actor || '</div>'
          ||   '<blockquote style="margin:0 0 22px;padding:14px 16px;border-left:4px solid #C9A84C;background:#f7f7f7;color:#1a1a1a;border-radius:4px;white-space:pre-wrap;font-size:14px;line-height:1.55;">'
                 || v_note || '</blockquote>'
          ||   '<p style="margin:0 0 6px;color:#1a1a1a;font-size:14px;">Questions? Just reply to this email — it goes straight to ' || v_actor || '.</p>'
          ||   '<p style="color:#999;font-size:11px;margin:18px 0 0;border-top:1px solid #eee;padding-top:12px;">'
                 || 'You received this because ' || v_actor || ' @-mentioned you in the Rates &amp; Realty CRM.</p>'
          || '</div>'
          || '</div>';

        v_summary := 'Shared ' || coalesce(v_lead_name,'this lead') || ' with ' || coalesce(v_pname, m)
                     || '. Note: "' || left(v_note, 180) || '"';

        begin
          perform net.http_post(
            url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/email-service',
            headers := '{"Content-Type": "application/json"}'::jsonb,
            body := jsonb_build_object(
              'action','send','to_email',v_pemail,'subject',v_subject,'html',v_html,
              'reply_to','rene@ratesandrealty.com',
              'to_name', v_pname,
              'contact_id', p_contact_id,
              'activity_title', '📤 Shared lead with ' || coalesce(v_pname, m) || ' (referral partner)',
              'activity_summary', v_summary
            )
          );
          n := n + 1;
        exception when others then null; end;
      end if;
    end if;
  end loop;

  return n;
end; $function$;
