-- loan_date_set_met(p_contact_id uuid, p_date_key text, p_met boolean, p_note text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.loan_date_set_met(p_contact_id uuid, p_date_key text, p_met boolean, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (is_admin() or coalesce((select role from public.auth_user_roles where user_id=auth.uid() limit 1),'') in ('admin','agent','loa','va')) then
    raise exception 'not authorized';
  end if;
  update public.loan_key_dates
    set completed = coalesce(p_met,false),
        completed_at = case when p_met then now() else null end,
        completed_note = case when p_met then p_note else null end,
        updated_at = now()
  where contact_id = p_contact_id and date_key = p_date_key;
  if not found then
    -- create the row if it doesn't exist yet (met with no date value)
    insert into public.loan_key_dates(contact_id, date_key, completed, completed_at, completed_note)
    values (p_contact_id, p_date_key, coalesce(p_met,false), case when p_met then now() else null end, p_note);
  end if;
  return jsonb_build_object('ok', true, 'date_key', p_date_key, 'completed', coalesce(p_met,false));
end; $function$;
