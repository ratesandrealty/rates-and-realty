-- condition_set_status(p_condition_id uuid, p_status text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.condition_set_status(p_condition_id uuid, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  if p_status not in ('pending','in_review','cleared','waived') then
    raise exception 'invalid status %', p_status;
  end if;
  update public.loan_conditions
     set status = p_status,
         cleared_at = case when p_status='cleared' then now() else null end,
         cleared_by = case when p_status='cleared' then auth.uid() else null end,
         updated_at = now()
   where id = p_condition_id;
  return jsonb_build_object('condition_id', p_condition_id, 'status', p_status);
end; $function$;
