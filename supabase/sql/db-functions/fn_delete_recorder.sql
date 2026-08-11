-- fn_delete_recorder()
-- language: plpgsql
-- Captured from production 2026-08-11.

CREATE OR REPLACE FUNCTION public.fn_delete_recorder()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  begin
    insert into public.audit_log (table_name, row_id, operation, old_data, new_data, changed_by)
    values (
      TG_TABLE_NAME,
      coalesce(to_jsonb(OLD)->>'id', '(no id column)'),
      'DELETE_OBSERVED',
      to_jsonb(OLD),                       -- the whole row, so a delete is reversible by hand
      jsonb_build_object(
        'recorded_by',      'fn_delete_recorder',
        'auth_uid',         auth.uid(),
        'db_user',          current_user,
        'session_user',     session_user,
        'client_addr',      coalesce(host(inet_client_addr()), '(local/none)'),
        'application_name', coalesce(nullif(current_setting('application_name', true), ''), '(unset)'),
        /* The question actually asked when a row vanishes is not "which uid"
           but "did this come through the app at all". */
        'route_hint',       case
                              when auth.uid() is not null then 'session via PostgREST'
                              when current_user = 'service_role' then 'service role (edge function)'
                              else 'DIRECT DB — not through the app'
                            end
      ),
      auth.uid()
    );
  exception when others then
    /* A RECORDER, NOT A GATE. It must never raise: a logbook that can refuse a
       delete is a new failure mode on a working path. Same principle as
       recordRun() in gdrive-health-monitor and fn_contacts_delete_recorder. */
    raise warning 'fn_delete_recorder: could not record delete of %.% (%)',
      TG_TABLE_NAME, coalesce(to_jsonb(OLD)->>'id','?'), sqlerrm;
  end;
  return OLD;
end $function$;
