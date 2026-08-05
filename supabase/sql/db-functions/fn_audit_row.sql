-- fn_audit_row()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.fn_audit_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(OLD) else null end;
  v_new jsonb := case when tg_op in ('UPDATE','INSERT') then to_jsonb(NEW) else null end;
  v_row_id text;
begin
  v_row_id := coalesce(
    case when tg_op = 'DELETE' then v_old->>'id'         else v_new->>'id'         end,
    case when tg_op = 'DELETE' then v_old->>'contact_id' else v_new->>'contact_id' end
  );
  insert into public.audit_log(table_name, row_id, operation, old_data, new_data, changed_by)
  values (tg_table_name, v_row_id, tg_op, v_old, v_new, auth.uid());
  return case when tg_op = 'DELETE' then OLD else NEW end;
end
$function$;
