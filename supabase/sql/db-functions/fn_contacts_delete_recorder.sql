-- BEFORE DELETE recorder on public.contacts. A RECORDER, NOT A GATE.
-- delete-contacts holds the gate; this only ever writes. If the insert fails it
-- RAISES WARNING and the delete proceeds — a recorder that can refuse is one that
-- can lock you out of your own data.
--
-- Exists because 43 contact deletions left nothing but a cascade artifact on
-- contact_earnings with a null actor, and zero rows at table_name='contacts'.
-- The extra columns make a null actor DIAGNOSTIC rather than merely missing.
create or replace function public.fn_contacts_delete_recorder()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  begin
    insert into public.audit_log (table_name, row_id, operation, old_data, new_data, changed_by)
    values (
      'contacts', OLD.id::text, 'DELETE_OBSERVED', to_jsonb(OLD),
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
    raise warning 'fn_contacts_delete_recorder: could not record delete of % (%)', OLD.id, sqlerrm;
  end;
  return OLD;
end
$fn$;

drop trigger if exists trg_contacts_delete_recorder on public.contacts;
create trigger trg_contacts_delete_recorder
  before delete on public.contacts
  for each row execute function public.fn_contacts_delete_recorder();
