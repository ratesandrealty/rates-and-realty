-- order_timeline(p_contact_id uuid, p_order_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.order_timeline(p_contact_id uuid, p_order_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text;
  v jsonb;
  v_order_types text[] := array['title','escrow','hoi','appraisal','voe','payoff','mortgage_payoff'];
begin
  v_role := coalesce(public.current_app_role(),'');
  if not (public.is_admin() or v_role in ('va','loa','agent','staff')) then
    raise exception 'not authorized';
  end if;

  select coalesce(jsonb_agg(x order by x.ts desc), '[]'::jsonb) into v from (
    -- (A) documents from the OLD upload path (uploaded_documents), only processing-order types
    select ud.created_at as ts, 'document' as kind, lower(ud.document_type) as order_type,
           ud.file_name as text, coalesce(ud.gdrive_file_url, ud.file_url) as url,
           coalesce(ud.uploaded_by::text,'') as who, null::text as who_role, ud.id as ref_id
    from uploaded_documents ud
    where ud.contact_id = p_contact_id
      and lower(coalesce(ud.document_type,'')) = any(v_order_types)

    union all
    -- (B) documents from the new path (order_documents), backward compat
    select od.created_at, 'document', od.order_type, od.file_name, od.gdrive_file_url,
           od.uploaded_by_display, od.uploaded_by_role, od.id
    from order_documents od
    where od.contact_id = p_contact_id and (p_order_id is null or od.order_id = p_order_id)

    union all
    -- (C) notes / requests
    select onote.created_at,
           case when onote.source='update_request' then 'request' else 'note' end,
           (select lower(lo.order_type) from loan_orders lo where lo.id = onote.order_id),
           onote.note_text, null::text, onote.author_display, null::text, onote.id
    from order_notes onote
    where onote.contact_id = p_contact_id and (p_order_id is null or onote.order_id = p_order_id)
      and coalesce(onote.source,'') <> 'order_document'
  ) x;
  return v;
end; $function$;
