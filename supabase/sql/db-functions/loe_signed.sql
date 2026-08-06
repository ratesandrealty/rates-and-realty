-- loe_signed()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-06. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.loe_signed()
 RETURNS TABLE(id uuid, contact_id uuid, application_id uuid, borrower_name text, topic text, category text, title text, signed_at timestamp with time zone, signed_pdf_url text, envelope_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role() = 'authenticated' and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then raise exception 'admin only'; end if;
  return query
  select l.id, l.contact_id, l.application_id,
         trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')) as borrower_name,
         l.topic, l.category, l.title, l.signed_at, l.signed_pdf_url, l.envelope_id
  from public.loe_requests l
  left join public.contacts c on c.id = l.contact_id
  where l.status = 'signed'
  order by l.signed_at desc nulls last, l.updated_at desc;
end; $function$;
