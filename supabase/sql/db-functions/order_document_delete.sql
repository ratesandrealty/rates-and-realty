-- order_document_delete(p_doc_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.order_document_delete(p_doc_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then raise exception 'admin only — VAs cannot delete documents'; end if;
  delete from public.order_documents where id = p_doc_id;
  return jsonb_build_object('ok', true);
end; $function$;
