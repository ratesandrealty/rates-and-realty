-- email_signature_set(p_mailbox text, p_html text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.email_signature_set(p_mailbox text, p_html text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  insert into email_signatures(mailbox, signature_html, updated_by, updated_at)
  values (p_mailbox, coalesce(p_html,''), auth.uid(), now())
  on conflict (mailbox) do update set signature_html = excluded.signature_html,
    updated_by = auth.uid(), updated_at = now();
  return jsonb_build_object('ok', true);
end; $function$;
