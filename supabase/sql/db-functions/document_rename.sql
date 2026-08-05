-- document_rename(p_id uuid, p_new_name text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.document_rename(p_id uuid, p_new_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_row uploaded_documents;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  if coalesce(trim(p_new_name),'') = '' then raise exception 'name required'; end if;

  update public.uploaded_documents
     set file_name = trim(p_new_name)
   where id = p_id
   returning * into v_row;

  if v_row.id is null then raise exception 'document not found'; end if;
  return jsonb_build_object('id', v_row.id, 'file_name', v_row.file_name,
                            'gdrive_file_id', v_row.gdrive_file_id);
end; $function$;
