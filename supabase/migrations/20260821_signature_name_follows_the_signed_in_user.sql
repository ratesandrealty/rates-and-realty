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
-- email_signature_identity(p_mailbox text)
-- language: plpgsql
-- Captured from production 2026-08-21.

CREATE OR REPLACE FUNCTION public.email_signature_identity(p_mailbox text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; v_source text;
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff'))
    then raise exception 'not authorized'; end if;

  /* SAME PRECEDENCE AS email_signature_get, and it has to be — this powers the
     "Signing as <name> · <mailbox>" line the composer shows, and a line that
     names a different person than the signature below it is worse than no line.
     `stale` is read from WHICHEVER ROW SUPPLIED THE NAME, for the same reason:
     a staleness warning computed against a different account describes someone
     who is not being named. */
  select btrim(coalesce(ur.display_name,'')) as display_name,
         ur.display_name_updated_at, ur.credentials_rotated_at
  into r
  from auth_user_roles ur
  where ur.user_id = auth.uid() and btrim(coalesce(ur.display_name,'')) <> '';

  if found then v_source := 'user'; else
    select btrim(coalesce(ur.display_name,'')) as display_name,
           ur.display_name_updated_at, ur.credentials_rotated_at
    into r
    from auth_user_roles ur join auth.users u on u.id = ur.user_id
    where lower(u.email) = lower(p_mailbox);
    v_source := 'mailbox';
  end if;

  return jsonb_build_object(
    'mailbox', p_mailbox,
    'display_name', nullif(coalesce(r.display_name,''), ''),
    'display_name_updated_at', r.display_name_updated_at,
    'credentials_rotated_at', r.credentials_rotated_at,
    /* 'user' = signed in as themselves; 'mailbox' = fell back to the account
       that owns the address, which is what a server-side or nameless caller
       gets. Exposed so the UI can say which without guessing. */
    'name_source', case when nullif(coalesce(r.display_name,''),'') is null then null else v_source end,
    /* Stale = the name predates the last password reset on this login, i.e. it
       may belong to whoever held the account before. */
    'stale', (coalesce(r.display_name,'') <> ''
              and r.credentials_rotated_at is not null
              and (r.display_name_updated_at is null
                   or r.display_name_updated_at < r.credentials_rotated_at))
  );
end;
$function$;
