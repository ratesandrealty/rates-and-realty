-- order_email_envelope(p_order_id uuid, p_to_email text, p_from_key text, p_cc text)
-- language: plpgsql
-- Captured from production 2026-08-06.

CREATE OR REPLACE FUNCTION public.order_email_envelope(p_order_id uuid, p_to_email text, p_from_key text DEFAULT 'processing'::text, p_cc text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Resolve WHO an order email goes to. Sends nothing and claims nothing.
 *
 * The addressing rules are worth keeping in SQL — BCC both internal mailboxes,
 * minus the sender (you cannot BCC your own From) and minus the To recipient,
 * and dedupe caller CC against To. What does NOT belong here is the send:
 * order_email_send used net.http_post, which is fire-and-forget, wrapped in
 * `exception when others then null`, and then wrote an order_note reading
 * "📧 Emailed X" and returned success:true UNCONDITIONALLY. It could not know
 * the outcome and said it did anyway. Same class as alert_sent and
 * app_notify_mentions: a call that returns cleanly and proves nothing. */
declare
  v_lead uuid; v_from text; v_from_name text; v_label text; v_order_type text;
  v_rene text := 'rene@ratesandrealty.com';
  v_proc text := 'processing@ratesandrealty.com';
  v_part text; v_bcc text[] := array[]::text[]; v_cc text[] := array[]::text[];
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only'; end if;

  select contact_id, order_type, coalesce(label, upper(order_type))
    into v_lead, v_order_type, v_label
  from public.loan_orders where id = p_order_id;

  if p_from_key = 'processing' then v_from := v_proc; v_from_name := 'Rates & Realty Processing';
  else v_from := v_rene; v_from_name := 'Rene Duarte'; end if;

  foreach v_part in array array[v_rene, v_proc] loop
    if lower(v_part) <> lower(v_from)
       and lower(v_part) <> lower(trim(coalesce(p_to_email,'')))
       and not (lower(v_part) = any(select lower(x) from unnest(v_bcc) x)) then
      v_bcc := v_bcc || v_part;
    end if;
  end loop;

  if coalesce(trim(p_cc),'') <> '' then
    foreach v_part in array string_to_array(replace(p_cc,' ',''), ',') loop
      if nullif(trim(v_part),'') is not null
         and lower(trim(v_part)) <> lower(trim(coalesce(p_to_email,'')))
         and not (lower(trim(v_part)) = any(select lower(x) from unnest(v_cc) x)) then
        v_cc := v_cc || trim(v_part);
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'contact_id', v_lead, 'label', v_label,
    'from_email', v_from, 'from_name', v_from_name,
    'reply_to', v_rene || ',' || v_proc,
    'cc',  nullif(array_to_string(v_cc, ','), ''),
    'bcc', nullif(array_to_string(v_bcc, ','), ''));
end; $function$;
