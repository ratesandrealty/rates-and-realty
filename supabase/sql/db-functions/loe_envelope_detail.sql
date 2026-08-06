-- loe_envelope_detail(p_loe_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-06. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.loe_envelope_detail(p_loe_id uuid)
 RETURNS TABLE(document_html text, document_title text, status text, signers jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role() = 'authenticated' and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then raise exception 'admin only'; end if;
  return query
  select r.document_html, r.document_title, r.status,
         coalesce((
           select jsonb_agg(jsonb_build_object('name', s.name, 'email', s.email, 'status', s.status))
           from signature_signers s where s.request_id = r.id
         ), '[]'::jsonb)
  from loe_requests l
  join signature_requests r on r.id = l.envelope_id
  where l.id = p_loe_id;
end; $function$;
