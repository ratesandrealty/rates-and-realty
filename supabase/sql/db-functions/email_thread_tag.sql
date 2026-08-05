-- email_thread_tag(p_thread_id text, p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.email_thread_tag(p_thread_id text, p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_n int;
begin
  v_role := coalesce(public.current_app_role(),'');
  if not (public.is_admin() or v_role in ('va','loa','agent','staff')) then
    raise exception 'not authorized';
  end if;
  if coalesce(trim(p_thread_id),'') = '' then raise exception 'thread id required'; end if;

  insert into public.email_thread_tags(gmail_thread_id, contact_id, tagged_by, tagged_at)
  values (p_thread_id, p_contact_id, auth.uid(), now())
  on conflict (gmail_thread_id) do update
    set contact_id = excluded.contact_id, tagged_by = excluded.tagged_by, tagged_at = now();

  update public.email_log set contact_id = p_contact_id
   where gmail_thread_id = p_thread_id
     and (contact_id is distinct from p_contact_id);
  get diagnostics v_n = row_count;

  return jsonb_build_object('ok', true, 'messages_filed', v_n);
end; $function$;
