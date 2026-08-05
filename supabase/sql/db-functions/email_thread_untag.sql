-- email_thread_untag(p_thread_id text, p_unfile boolean)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.email_thread_untag(p_thread_id text, p_unfile boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text;
begin
  v_role := coalesce(public.current_app_role(),'');
  if not (public.is_admin() or v_role in ('va','loa','agent','staff')) then
    raise exception 'not authorized';
  end if;
  delete from public.email_thread_tags where gmail_thread_id = p_thread_id;
  if p_unfile then
    update public.email_log set contact_id = null where gmail_thread_id = p_thread_id;
  end if;
  return jsonb_build_object('ok', true);
end; $function$;
