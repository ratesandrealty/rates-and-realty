-- order_email_send(p_order_id uuid, p_to_email text, p_subject text, p_html text, p_from_key text, p_to_name text, p_cc text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.order_email_send(p_order_id uuid, p_to_email text, p_subject text, p_html text, p_from_key text DEFAULT 'rene'::text, p_to_name text DEFAULT NULL::text, p_cc text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_lead uuid; v_from text; v_from_name text; v_reply text;
  v_note_id uuid; v_order_type text; v_label text;
  v_rene text := 'rene@ratesandrealty.com';
  v_proc text := 'processing@ratesandrealty.com';
  v_bcc_parts text[]; v_part text; v_bcc_clean text[]; v_bcc text;
  v_cc_parts text[]; v_cc_clean text[]; v_cc text;
begin
  if auth.role() = 'authenticated'
     and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','lender','staff')) then
    raise exception 'staff only';
  end if;
  if coalesce(trim(p_to_email),'')='' or coalesce(trim(p_subject),'')='' or coalesce(trim(p_html),'')='' then
    raise exception 'to_email, subject, html required';
  end if;

  select contact_id, order_type, coalesce(label, upper(order_type))
    into v_lead, v_order_type, v_label
  from public.loan_orders where id = p_order_id;

  if p_from_key = 'processing' then
    v_from := v_proc; v_from_name := 'Rates & Realty Processing';
  else
    v_from := v_rene; v_from_name := 'Rene Duarte';
  end if;

  -- BCC both internal addresses (so each Gmail gets a copy), minus the sender (can't BCC the From)
  -- and minus the To recipient.
  v_bcc_parts := array[v_rene, v_proc];
  v_bcc_clean := array[]::text[];
  foreach v_part in array v_bcc_parts loop
    if lower(v_part) <> lower(v_from)                       -- don't BCC the sender
       and lower(v_part) <> lower(trim(p_to_email))          -- don't BCC the recipient
       and not (lower(v_part) = any(select lower(x) from unnest(v_bcc_clean) x)) then
      v_bcc_clean := v_bcc_clean || v_part;
    end if;
  end loop;
  v_bcc := nullif(array_to_string(v_bcc_clean, ','), '');

  -- CC = any caller-supplied CC only (the internal copies go via BCC now), deduped vs To
  v_cc := null;
  if coalesce(trim(p_cc),'') <> '' then
    v_cc_parts := string_to_array(replace(p_cc,' ',''), ',');
    v_cc_clean := array[]::text[];
    foreach v_part in array v_cc_parts loop
      if v_part is not null and trim(v_part) <> '' and lower(trim(v_part)) <> lower(trim(p_to_email))
         and not (lower(trim(v_part)) = any(select lower(x) from unnest(v_cc_clean) x)) then
        v_cc_clean := v_cc_clean || trim(v_part);
      end if;
    end loop;
    v_cc := nullif(array_to_string(v_cc_clean, ','), '');
  end if;

  -- replies reach BOTH inboxes
  v_reply := v_rene || ',' || v_proc;

  begin
    perform net.http_post(
      url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/email-service',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object(
        'action','send','to_email',p_to_email,'to_name',p_to_name,'subject',p_subject,'html',p_html,
        'from_email',v_from,'reply_to',v_reply,'cc',v_cc,'bcc',v_bcc,'contact_id',v_lead,
        'activity_title','📧 ' || v_label || ' email → ' || coalesce(p_to_name, p_to_email) || ' (from ' || v_from || ')')
    );
  exception when others then null; end;

  insert into public.order_notes(order_id, contact_id, note_text, is_follow_up, author_user_id, author_display, source, created_at)
  values(p_order_id, v_lead,
         '📧 Emailed ' || coalesce(p_to_name, p_to_email) || ' from ' || v_from
           || ' (copies to rene@ + processing@)'
           || E'\nSubject: ' || p_subject,
         true, auth.uid(),
         case when p_from_key='processing' then 'Processing (VA)' else 'Rene' end,
         'processing', now())
  returning id into v_note_id;

  return jsonb_build_object('success', true, 'note_id', v_note_id, 'from', v_from, 'bcc', v_bcc, 'cc', v_cc, 'reply_to', v_reply);
end; $function$;
