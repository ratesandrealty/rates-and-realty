-- partner_goal_set(p_partner_id uuid, p_metric text, p_period text, p_target numeric)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.partner_goal_set(p_partner_id uuid, p_metric text, p_period text, p_target numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not public.is_admin() then raise exception 'admin only'; end if;
  insert into partner_goals(partner_id, metric, period, target, updated_at, updated_by)
  values (p_partner_id, lower(p_metric), lower(p_period), p_target, now(), auth.uid())
  on conflict (partner_id) do update
    set metric=excluded.metric, period=excluded.period, target=excluded.target,
        updated_at=now(), updated_by=auth.uid();
end;
$function$;
