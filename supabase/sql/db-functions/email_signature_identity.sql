-- email_signature_identity(p_mailbox text)
-- language: plpgsql
-- Captured from production 2026-08-21.

CREATE OR REPLACE FUNCTION public.email_signature_identity(p_mailbox text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; v_source text; v_is_service boolean := false;
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff'))
    then raise exception 'not authorized'; end if;

  select coalesce(ur.is_service_account,false) into v_is_service
  from auth_user_roles ur where ur.user_id = auth.uid();

  if coalesce(v_is_service,false) then
    /* Say it in the UI rather than rendering a blank. "Signing as" is the line
       that caught the original mis-signing; a service account sending mail is
       exactly as worth stating. */
    return jsonb_build_object(
      'mailbox', p_mailbox, 'display_name', null,
      'display_name_updated_at', null, 'credentials_rotated_at', null,
      'name_source', 'service_account', 'stale', false);
  end if;

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
    'name_source', case when nullif(coalesce(r.display_name,''),'') is null then null else v_source end,
    'stale', (coalesce(r.display_name,'') <> ''
              and r.credentials_rotated_at is not null
              and (r.display_name_updated_at is null
                   or r.display_name_updated_at < r.credentials_rotated_at))
  );
end;
$function$;
