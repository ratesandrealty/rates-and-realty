-- condition_list(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.condition_list(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v jsonb;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', lc.id, 'condition_text', lc.condition_text, 'category', lc.category,
      'status', lc.status, 'stage', lc.stage, 'sort_order', lc.sort_order,
      'cleared_at', lc.cleared_at, 'notes', lc.notes,
      'attachments', coalesce((
        select jsonb_agg(jsonb_build_object(
            'id', a.id, 'file_name', a.file_name, 'file_url', a.file_url,
            'gdrive_file_id', a.gdrive_file_id, 'uploaded_document_id', a.uploaded_document_id,
            'attached_at', a.attached_at) order by a.attached_at)
        from public.condition_attachments a where a.condition_id = lc.id), '[]'::jsonb)
    ) order by lc.sort_order nulls last, lc.created_at), '[]'::jsonb)
  into v
  from public.loan_conditions lc
  where lc.contact_id = p_contact_id;
  return v;
end; $function$;
