-- condition_attach(p_condition_id uuid, p_docs jsonb, p_clear boolean)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.condition_attach(p_condition_id uuid, p_docs jsonb, p_clear boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_contact uuid; d jsonb; v_total int;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  select contact_id into v_contact from public.loan_conditions where id = p_condition_id;
  if v_contact is null then raise exception 'condition not found'; end if;
  for d in select * from jsonb_array_elements(coalesce(p_docs, '[]'::jsonb)) loop
    insert into public.condition_attachments(
      condition_id, contact_id, uploaded_document_id, gdrive_file_id, file_name, file_url, attached_by)
    values(p_condition_id, v_contact,
      nullif(d->>'uploaded_document_id','')::uuid,
      nullif(d->>'gdrive_file_id',''),
      coalesce(nullif(trim(d->>'file_name'),''), 'Document'),
      nullif(d->>'file_url',''),
      auth.uid())
    on conflict do nothing;
  end loop;
  if p_clear then
    update public.loan_conditions
       set status='cleared', cleared_at=now(), updated_at=now()
     where id = p_condition_id;
  end if;
  select count(*) into v_total from public.condition_attachments where condition_id = p_condition_id;
  return jsonb_build_object('condition_id', p_condition_id, 'total_attachments', v_total, 'cleared', p_clear);
end; $function$;
