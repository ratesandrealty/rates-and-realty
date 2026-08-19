-- quote_reply_match(p_in_reply_to text, p_references text, p_from_email text, p_to_email text, p_cc_email text, p_subject text, p_body text, p_gmail_thread_id text)
-- language: plpgsql
-- Captured from production 2026-08-19.

CREATE OR REPLACE FUNCTION public.quote_reply_match(p_in_reply_to text DEFAULT NULL::text, p_references text DEFAULT NULL::text, p_from_email text DEFAULT NULL::text, p_to_email text DEFAULT NULL::text, p_cc_email text DEFAULT NULL::text, p_subject text DEFAULT NULL::text, p_body text DEFAULT NULL::text, p_gmail_thread_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Shared HOI/VOE reply correlation. One matcher for both tables because the
   correlation is identical and only the target table differs.

   The ladder, strongest first:
     1. In-Reply-To / References -> rfc_message_id   (survives a stripped token)
     2. gmail_thread_id          -> the same Gmail conversation
     3. hoi_/voe_ token in addressing, subject or body
     4. sender address, ONLY when it identifies exactly one row

   EVERY TIER IS RESTRICTED TO ROWS WE HAVE A SEND RECORD FOR — gmail_message_id
   or rfc_message_id present, or (tier 2) a gmail_thread_id, which is only ever
   written by a send or an adopt. Rows predating those columns went out through
   MailerSend, which returned no id, so nothing about them can be corroborated
   and a reply must attach to NOTHING rather than be guessed onto history.

   rfc_message_id is the RFC header, NOT the Gmail API id. They are different
   strings and matching In-Reply-To against the API id can never hit.

   'unmatched' and 'ambiguous_address' are legitimate outcomes and are NEVER
   upgraded to a guess. */
declare
  v_ids       text[];
  v_token     text;
  v_kind      text := null;
  v_row_id    uuid := null;
  v_contact   uuid := null;
  v_matched   text := 'unmatched';
  v_haystack  text;
  v_n         int;
  v_from      text;
  v_thread    text := nullif(trim(coalesce(p_gmail_thread_id, '')), '');
begin
  v_ids := array(
    select distinct m[1]
    from regexp_matches(concat_ws(' ', p_in_reply_to, p_references), '<[^<>\s]+>', 'g') as m
  );

  if array_length(v_ids, 1) is not null then
    select 'hoi', id, contact_id into v_kind, v_row_id, v_contact
    from public.hoi_quote_requests
    where rfc_message_id = any(v_ids)
    limit 1;

    if v_row_id is null then
      select 'voe', id, contact_id into v_kind, v_row_id, v_contact
      from public.loan_orders
      where rfc_message_id = any(v_ids)
      limit 1;
    end if;

    if v_row_id is not null then v_matched := 'in_reply_to'; end if;
  end if;

  /* TIER 2 — the same Gmail conversation. */
  if v_row_id is null and v_thread is not null then
    select 'hoi', id, contact_id into v_kind, v_row_id, v_contact
    from public.hoi_quote_requests
    where gmail_thread_id = v_thread
    limit 1;

    if v_row_id is null then
      /* Deliberately NOT restricted to order_type='voe'. A title company
         replying in the thread we started is the same fact as an HR department
         doing so, and tiers 3 and 4 below cannot serve non-VOE orders at all. */
      select 'voe', id, contact_id into v_kind, v_row_id, v_contact
      from public.loan_orders
      where gmail_thread_id = v_thread
      limit 1;
    end if;

    if v_row_id is not null then v_matched := 'thread'; end if;
  end if;

  if v_row_id is null then
    v_haystack := concat_ws(' ', p_to_email, p_cc_email, p_subject, p_body);
    v_token := substring(v_haystack from '(?:hoi|voe)_[0-9a-f]{32}');

    if v_token is not null then
      if v_token like 'hoi\_%' then
        select 'hoi', id, contact_id into v_kind, v_row_id, v_contact
        from public.hoi_quote_requests
        where reply_token = v_token
          and (gmail_message_id is not null or rfc_message_id is not null)
        limit 1;
      else
        select 'voe', id, contact_id into v_kind, v_row_id, v_contact
        from public.loan_orders
        where voe_reply_token = v_token
          and (gmail_message_id is not null or rfc_message_id is not null)
        limit 1;
      end if;
      if v_row_id is not null then v_matched := 'token'; end if;
    end if;
  end if;

  v_from := lower(nullif(trim(coalesce(p_from_email, '')), ''));
  if v_row_id is null and v_from is not null then
    select count(*) into v_n from (
      select id from public.hoi_quote_requests
       where lower(agent_email) = v_from
         and (gmail_message_id is not null or rfc_message_id is not null)
      union all
      select id from public.loan_orders
       where order_type = 'voe' and lower(hr_contact_email) = v_from
         and (gmail_message_id is not null or rfc_message_id is not null)
    ) c;

    if v_n = 1 then
      select 'hoi', id, contact_id into v_kind, v_row_id, v_contact
      from public.hoi_quote_requests
       where lower(agent_email) = v_from
         and (gmail_message_id is not null or rfc_message_id is not null)
      limit 1;
      if v_row_id is null then
        select 'voe', id, contact_id into v_kind, v_row_id, v_contact
        from public.loan_orders
         where order_type = 'voe' and lower(hr_contact_email) = v_from
           and (gmail_message_id is not null or rfc_message_id is not null)
        limit 1;
      end if;
      if v_row_id is not null then v_matched := 'address_unique'; end if;
    elsif v_n > 1 then
      /* DELIBERATELY NO ROW. Taking the most RECENT order for an address is a
         guess, and it is wrong exactly when it matters: one agent address is
         already on two borrowers, so "most recent" would file a reply about one
         onto the other's record — silently, on borrower NPI. An unattached reply
         is a visible gap somebody can act on; a confidently misattached one is a
         record of a conversation that did not happen. */
      v_matched := 'ambiguous_address';
    end if;
  end if;

  return jsonb_build_object(
    'kind',        v_kind,
    'row_id',      v_row_id,
    'contact_id',  v_contact,
    'reply_token', v_token,
    'matched_by',  v_matched
  );
end;
$function$;
