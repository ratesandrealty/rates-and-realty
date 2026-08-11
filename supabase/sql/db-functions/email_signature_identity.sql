-- email_signature_identity(p_mailbox text)
-- language: plpgsql
-- Captured from production 2026-08-11.

CREATE OR REPLACE FUNCTION public.email_signature_identity(p_mailbox text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record;
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff'))
    then raise exception 'not authorized'; end if;

  select btrim(coalesce(ur.display_name,'')) as display_name,
         ur.display_name_updated_at, ur.credentials_rotated_at
  into r
  from auth_user_roles ur join auth.users u on u.id = ur.user_id
  where lower(u.email) = lower(p_mailbox);

  return jsonb_build_object(
    'mailbox', p_mailbox,
    'display_name', nullif(coalesce(r.display_name,''), ''),
    'display_name_updated_at', r.display_name_updated_at,
    'credentials_rotated_at', r.credentials_rotated_at,
    /* Stale = the name predates the last password reset on this login, i.e. it
       may belong to whoever held the account before. Only meaningful because
       credentials_rotated_at is stamped by admin-users at the moment it resets
       a password — Supabase exposes no real "password last changed" timestamp
       (auth.audit_log_entries is empty; recovery_sent_at is set by
       generate_link, so it moves on any magic link and not on an admin password
       change). */
    'stale', (coalesce(r.display_name,'') <> ''
              and r.credentials_rotated_at is not null
              and (r.display_name_updated_at is null
                   or r.display_name_updated_at < r.credentials_rotated_at))
  );
end; $function$;
