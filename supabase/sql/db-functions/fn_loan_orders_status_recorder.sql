-- fn_loan_orders_status_recorder()
-- language: plpgsql
-- Captured from production 2026-08-10.

CREATE OR REPLACE FUNCTION public.fn_loan_orders_status_recorder()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.status is distinct from OLD.status then
    begin
      insert into public.audit_log (table_name, row_id, operation, old_data, new_data, changed_by)
      values ('loan_orders', NEW.id::text, 'STATUS_CHANGE',
        jsonb_build_object('status', OLD.status, 'ordered_at', OLD.ordered_at),
        jsonb_build_object(
          'status', NEW.status, 'ordered_at', NEW.ordered_at, 'order_type', NEW.order_type,
          'auth_uid', auth.uid(), 'db_user', current_user,
          'application_name', coalesce(nullif(current_setting('application_name', true),''), '(unset)'),
          'route_hint', case when auth.uid() is not null then 'session via PostgREST'
                             when current_user = 'service_role' then 'service role (edge function)'
                             else 'DIRECT DB - not through the app' end),
        auth.uid());
    exception when others then
      raise warning 'fn_loan_orders_status_recorder: could not record % (%)', NEW.id, sqlerrm;
    end;
  end if;
  return NEW;
end $function$;
