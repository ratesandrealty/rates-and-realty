-- loe_save(p_loe_id uuid, p_contact_id uuid, p_application_id uuid, p_topic text, p_category text, p_title text, p_details text, p_body text, p_signer_contact_ids uuid[], p_status text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.loe_save(p_loe_id uuid, p_contact_id uuid, p_application_id uuid, p_topic text, p_category text, p_title text, p_details text, p_body text, p_signer_contact_ids uuid[], p_status text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid;
begin
  if auth.role() = 'authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
  if p_loe_id is not null then
    update public.loe_requests set
      topic = coalesce(nullif(p_topic,''), topic),
      category = coalesce(p_category, category),
      title = p_title,
      details = p_details,
      body = coalesce(p_body, body),
      application_id = coalesce(p_application_id, application_id),
      signer_contact_ids = p_signer_contact_ids,
      status = coalesce(p_status, status),
      updated_at = now()
    where id = p_loe_id returning id into v_id;
    return v_id;
  else
    insert into public.loe_requests(contact_id, application_id, topic, category, title, details, body, signer_contact_ids, status)
    values (p_contact_id, p_application_id, coalesce(nullif(p_topic,''),'Letter of Explanation'), p_category, p_title, p_details, p_body, p_signer_contact_ids, coalesce(p_status,'drafted'))
    returning id into v_id;
    return v_id;
  end if;
end; $function$;
