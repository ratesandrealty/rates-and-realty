-- voe_borrower_auth_request(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.voe_borrower_auth_request(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text;
  v_req record;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if not (
       public.is_admin()
       or v_role = 'service_role'
       or coalesce(public.current_app_role(), '') in ('va','loa','agent','staff')
     ) then
    raise exception 'not authorized';
  end if;

  -- Most recent COMPLETED borrower authorization e-sign envelope for this contact.
  select sr.id, sr.document_title, sr.completed_at
    into v_req
  from public.signature_requests sr
  where sr.contact_id = p_contact_id
    and (sr.template_key = 'borrower_authorization' or sr.document_type = 'authorization')
    and sr.status = 'completed'
  order by coalesce(sr.completed_at, sr.created_at) desc
  limit 1;

  if v_req.id is null then
    return jsonb_build_object('found', false, 'envelope_id', null,
                              'title', null, 'completed_at', null);
  end if;

  return jsonb_build_object(
    'found', true,
    'envelope_id', v_req.id,
    'title', coalesce(v_req.document_title, 'Borrower Authorization'),
    'completed_at', v_req.completed_at
  );
end;
$function$;
