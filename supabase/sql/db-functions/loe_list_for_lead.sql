-- loe_list_for_lead(p_contact_id uuid, p_application_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.loe_list_for_lead(p_contact_id uuid, p_application_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, contact_id uuid, application_id uuid, topic text, category text, title text, status text, body text, details text, envelope_id uuid, sent_at timestamp with time zone, signed_at timestamp with time zone, signed_pdf_url text, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role() = 'authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
  return query
  select l.id, l.contact_id, l.application_id, l.topic, l.category, l.title,
         l.status, l.body, l.details, l.envelope_id,
         l.sent_at, l.signed_at, l.signed_pdf_url, l.created_at, l.updated_at
  from public.loe_requests l
  where l.contact_id = p_contact_id
     or (p_application_id is not null and l.application_id = p_application_id)
  order by l.created_at desc;
end; $function$;
