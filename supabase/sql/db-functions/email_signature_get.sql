-- email_signature_get(p_mailbox text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-21. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.email_signature_get(p_mailbox text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_html text;
  v_name text;
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff'))
    then raise exception 'not authorized'; end if;

  select signature_html into v_html from email_signatures where mailbox = p_mailbox;
  if v_html is null then return ''; end if;

  -- 1. the signed-in user
  select btrim(coalesce(r.display_name,'')) into v_name
  from auth_user_roles r where r.user_id = auth.uid();

  -- 2. fall back to whoever owns the mailbox
  if coalesce(v_name,'') = '' then
    select btrim(coalesce(r.display_name,'')) into v_name
    from auth_user_roles r join auth.users u on u.id = r.user_id
    where lower(u.email) = lower(p_mailbox);
  end if;

  if coalesce(v_name,'') = '' then
    -- No name: drop the name block entirely, company block stands alone.
    v_html := regexp_replace(v_html, '<!--NAME-->.*?<!--/NAME-->', '', 'gs');
  else
    -- Escape before substituting: a name is admin-entered, but it is still text
    -- being spliced into HTML that goes to a borrower.
    v_html := replace(v_html, '{{display_name}}',
                      replace(replace(replace(v_name,'&','&amp;'),'<','&lt;'),'>','&gt;'));
    v_html := replace(replace(v_html, '<!--NAME-->', ''), '<!--/NAME-->', '');
  end if;

  return v_html;
end;
$function$;
