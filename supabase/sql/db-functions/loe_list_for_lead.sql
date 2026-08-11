-- loe_list_for_lead(p_contact_id uuid, p_application_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.
--
-- 2026-08-11: signer_contact_ids ADDED to the result.
-- loe-send action:'send_package' refuses a package whose letters do not share
-- one signer set ("Send it as its own package"). Without this column the LOE
-- card could not see that rule and could only discover it by being refused
-- after the user had already chosen. It now groups the picker by signer set,
-- so the refusal is unreachable from the UI rather than merely handled.
--
-- Changing RETURNS TABLE needs DROP + CREATE; CREATE OR REPLACE will not do it.
-- Grants do not survive the drop, so the migration re-granted postgres, anon,
-- authenticated, service_role AND public, matching the ACL that was there
-- before. Additive for callers: PostgREST returns JSON objects and every
-- consumer reads named fields.

CREATE OR REPLACE FUNCTION public.loe_list_for_lead(p_contact_id uuid, p_application_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, contact_id uuid, application_id uuid, topic text, category text, title text, status text, body text, details text, envelope_id uuid, sent_at timestamp with time zone, signed_at timestamp with time zone, signed_pdf_url text, created_at timestamp with time zone, updated_at timestamp with time zone, signer_contact_ids uuid[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then raise exception 'admin only'; end if;
  return query
  select l.id, l.contact_id, l.application_id, l.topic, l.category, l.title,
         l.status, l.body, l.details, l.envelope_id,
         l.sent_at, l.signed_at, l.signed_pdf_url, l.created_at, l.updated_at,
         l.signer_contact_ids
  from public.loe_requests l
  where l.contact_id = p_contact_id
     or (p_application_id is not null and l.application_id = p_application_id)
  order by l.created_at desc;
end; $function$;
