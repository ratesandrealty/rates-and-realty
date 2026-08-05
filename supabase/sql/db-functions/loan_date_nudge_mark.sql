-- loan_date_nudge_mark(p_items jsonb)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.loan_date_nudge_mark(p_items jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; n integer;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if not (public.is_admin() or v_role = 'service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'not authorized';
  end if;

  insert into public.nudge_sent(item_type, item_id, stage, sent_on)
  select x->>'item_type', (x->>'item_id')::uuid, x->>'stage', current_date
  from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) x
  on conflict (item_type, item_id, stage, sent_on) do nothing;
  get diagnostics n = row_count;
  return n;
end; $function$;
