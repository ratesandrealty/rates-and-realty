-- dialer_views_list()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.dialer_views_list()
 RETURNS TABLE(id uuid, name text, filter text, stage text, partner_id uuid, sort text, source text, tag_ids uuid[], callable_only boolean, min_loan numeric, match_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'must be signed in'; end if;
  return query
  select v.id, v.name, v.filter, v.stage, v.partner_id, v.sort,
         v.source, v.tag_ids, v.callable_only, v.min_loan,
         public.power_dialer_match_count(v.filter, v.stage, v.partner_id, v.source, v.tag_ids, v.callable_only, v.min_loan)
  from dialer_saved_views v
  where v.owner_user_id = auth.uid()
  order by v.name;
end;
$function$;
