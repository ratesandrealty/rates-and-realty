-- hoi_quote_log(p_contact_id uuid, p_vendor_id uuid, p_company text, p_agent_name text, p_agent_email text, p_agent_phone text, p_subject text, p_body text, p_agent_first text, p_agent_last text, p_status text, p_error text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11.
--
-- 2026-08-11: A FAILED HOI SEND NOW WRITES A ROW.
-- lpHoiSend() called this only AFTER its success check, so a failure left
-- nothing behind: the toast was its only trace and it disappeared. The panel
-- could not show a failure because there was nothing to show, which is why
-- "make failed unmistakable" was only half finishable.
--
-- Three things had to change together, and any one alone leaves it broken:
--   1. hoi_quote_requests.status CHECK did not permit 'failed' — the panel
--      already offered it, so the dropdown would have thrown on save.
--   2. send_error added, because a row saying 'failed' with no reason is the
--      same dead end as a toast that has gone away.
--   3. this function, which hardcoded status 'sent'.
--
-- p_status is a CLOSED SET and an unknown value RAISES rather than defaulting
-- to 'sent' — recording a failure as a success is the exact defect this
-- parameter exists to remove, so a typo must not reach it. A 'failed' row
-- without p_error is refused for the same reason, and sent_at is left null
-- because nothing was sent.
--
-- The 10-argument overload was DROPPED rather than left alongside: p_status and
-- p_error are defaulted, so it serves the old callers unchanged (verified — a
-- 10-named-parameter call resolves here and still writes status 'sent' with
-- sent_at set), and two copies of this insert is how "a failed send writes
-- nothing" comes back. The 8-argument overload predates first/last name
-- splitting and is left alone.

CREATE OR REPLACE FUNCTION public.hoi_quote_log(p_contact_id uuid, p_vendor_id uuid, p_company text, p_agent_name text, p_agent_email text, p_agent_phone text, p_subject text, p_body text, p_agent_first text DEFAULT NULL::text, p_agent_last text DEFAULT NULL::text, p_status text DEFAULT 'sent'::text, p_error text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_first text; v_last text; v_full text; v_status text;
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only'; end if;
  -- prefer explicit first/last; else derive from combined name
  v_first := coalesce(nullif(trim(coalesce(p_agent_first,'')),''), split_part(coalesce(p_agent_name,''),' ',1));
  v_last  := coalesce(nullif(trim(coalesce(p_agent_last,'')),''),
             nullif(trim(substr(coalesce(p_agent_name,''), length(split_part(coalesce(p_agent_name,''),' ',1))+1)),''));
  v_full  := coalesce(nullif(trim(coalesce(p_agent_name,'')),''), nullif(trim(coalesce(v_first,'')||' '||coalesce(v_last,'')),''));
  /* CLOSED SET, and an unknown value FAILS rather than defaulting to 'sent' —
     recording a failure as a success is the defect this parameter exists to
     remove, so it must not be reachable by passing a typo. */
  v_status := lower(trim(coalesce(p_status,'sent')));
  if v_status not in ('draft','sent','failed') then
    raise exception 'hoi_quote_log: p_status must be draft, sent or failed (got %)', p_status;
  end if;
  if v_status = 'failed' and nullif(trim(coalesce(p_error,'')),'') is null then
    raise exception 'hoi_quote_log: a failed send must carry p_error';
  end if;

  insert into public.hoi_quote_requests(contact_id, vendor_id, company_name, agent_name, agent_first_name, agent_last_name, agent_email, agent_phone, subject, body, status, send_error, sent_at)
  values (p_contact_id, p_vendor_id, p_company, v_full, nullif(v_first,''), v_last, p_agent_email, p_agent_phone, p_subject, p_body,
          v_status,
          case when v_status = 'failed' then left(trim(p_error), 500) else null end,
          case when v_status = 'sent'   then now() else null end)
  returning id into v_id;
  return v_id;
end; $function$;
