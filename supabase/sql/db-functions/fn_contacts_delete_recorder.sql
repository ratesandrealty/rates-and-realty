-- fn_contacts_delete_recorder()
-- language: plpgsql
-- Captured from production 2026-08-11.

CREATE OR REPLACE FUNCTION public.fn_contacts_delete_recorder()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  begin
    insert into public.audit_log (table_name, row_id, operation, old_data, new_data, changed_by)
    values (
      'contacts',
      OLD.id::text,
      'DELETE_OBSERVED',
      to_jsonb(OLD),
      jsonb_build_object(
        'recorded_by',      'fn_contacts_delete_recorder',
        'auth_uid',         auth.uid(),
        'db_user',          current_user,
        'session_user',     session_user,
        'client_addr',      coalesce(host(inet_client_addr()), '(local/none)'),
        'application_name', coalesce(nullif(current_setting('application_name', true), ''), '(unset)'),
        'route_hint',       case
                              when auth.uid() is not null then 'session via PostgREST'
                              when current_user = 'service_role' then 'service role (edge function)'
                              else 'DIRECT DB — not through the app'
                            end
      ),
      auth.uid()
    );
  exception when others then
    -- Never let the logbook stop the delete. Same principle as recordRun() in
    -- gdrive-health-monitor: a monitor that dies because it could not write its
    -- own log is worse than a gap in the log.
    raise warning 'fn_contacts_delete_recorder: could not record delete of % (%)', OLD.id, sqlerrm;
  end;
  return OLD;
end
$function$;
