-- order_document_add(p_order_id uuid, p_contact_id uuid, p_order_type text, p_file_name text, p_gdrive_file_id text, p_gdrive_file_url text, p_file_size bigint, p_file_type text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.order_document_add(p_order_id uuid, p_contact_id uuid, p_order_type text, p_file_name text, p_gdrive_file_id text, p_gdrive_file_url text, p_file_size bigint DEFAULT NULL::bigint, p_file_type text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_id uuid; v_disp text;
begin
  v_role := coalesce(public.current_app_role(),'');
  if not (public.is_admin() or v_role in ('va','loa','agent','staff')) then
    raise exception 'not authorized';
  end if;
  select coalesce(nullif(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')),''), email)
    into v_disp from auth_user_roles aur left join contacts c on false where aur.user_id = auth.uid() limit 1;

  insert into public.order_documents(order_id, contact_id, order_type, file_name,
    gdrive_file_id, gdrive_file_url, file_size, file_type,
    uploaded_by_user_id, uploaded_by_display, uploaded_by_role)
  values (p_order_id, p_contact_id, lower(p_order_type), p_file_name,
    p_gdrive_file_id, p_gdrive_file_url, p_file_size, p_file_type,
    auth.uid(), coalesce(v_disp, case when public.is_admin() then 'Admin' else 'VA' end),
    case when public.is_admin() then 'admin' else v_role end)
  returning id into v_id;

  -- log to the order timeline (reuse order_notes as the activity spine, flagged as an upload)
  insert into public.order_notes(order_id, contact_id, note_text, is_follow_up, author_user_id, author_display, source)
  values (p_order_id, p_contact_id, '📄 Uploaded: '||p_file_name, false, auth.uid(),
          coalesce(v_disp, case when public.is_admin() then 'Admin' else 'VA' end), 'order_document');

  return jsonb_build_object('id', v_id, 'ok', true);
end; $function$;
