-- power_dialer_zero_help(p_filter text, p_stage text, p_partner_id uuid, p_source text, p_tag_ids uuid[], p_callable_only boolean, p_min_loan numeric)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.power_dialer_zero_help(p_filter text DEFAULT 'all'::text, p_stage text DEFAULT NULL::text, p_partner_id uuid DEFAULT NULL::uuid, p_source text DEFAULT NULL::text, p_tag_ids uuid[] DEFAULT NULL::uuid[], p_callable_only boolean DEFAULT false, p_min_loan numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare arr jsonb := '[]'::jsonb; cnt record;
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not public.is_admin() then raise exception 'admin only'; end if;
  select * into cnt from public.power_dialer_counts();

  if lower(coalesce(p_filter,'all')) <> 'all' then
    arr := arr || jsonb_build_object('key','bucket','label','Switch to All leads',
      'count', public.power_dialer_match_count('all',p_stage,p_partner_id,p_source,p_tag_ids,p_callable_only,p_min_loan));
  end if;
  if p_stage is not null then
    arr := arr || jsonb_build_object('key','stage','label','Clear the stage filter',
      'count', public.power_dialer_match_count(p_filter,null,p_partner_id,p_source,p_tag_ids,p_callable_only,p_min_loan));
  end if;
  if p_partner_id is not null then
    arr := arr || jsonb_build_object('key','partner','label','Clear the partner filter',
      'count', public.power_dialer_match_count(p_filter,p_stage,null,p_source,p_tag_ids,p_callable_only,p_min_loan));
  end if;
  if p_tag_ids is not null then
    arr := arr || jsonb_build_object('key','tags','label','Clear the tag filter',
      'count', public.power_dialer_match_count(p_filter,p_stage,p_partner_id,p_source,null,p_callable_only,p_min_loan));
  end if;
  if p_source is not null then
    arr := arr || jsonb_build_object('key','source','label','Clear the source filter',
      'count', public.power_dialer_match_count(p_filter,p_stage,p_partner_id,null,p_tag_ids,p_callable_only,p_min_loan));
  end if;
  if coalesce(p_callable_only,false) then
    arr := arr || jsonb_build_object('key','callable','label','Turn off "callable now only"',
      'count', public.power_dialer_match_count(p_filter,p_stage,p_partner_id,p_source,p_tag_ids,false,p_min_loan));
  end if;
  if p_min_loan is not null then
    arr := arr || jsonb_build_object('key','minloan','label','Remove the minimum-loan filter',
      'count', public.power_dialer_match_count(p_filter,p_stage,p_partner_id,p_source,p_tag_ids,p_callable_only,null));
  end if;

  return jsonb_build_object(
    'current', public.power_dialer_match_count(p_filter,p_stage,p_partner_id,p_source,p_tag_ids,p_callable_only,p_min_loan),
    'total_active', cnt.total_active,
    'callable_now_total', public.power_dialer_match_count('all',null,null,null,null,true,null),
    'buckets', jsonb_build_object('due',cnt.due,'new',cnt.new_leads,'stale',cnt.stale,'scheduled',cnt.scheduled,'all',cnt.total_active),
    'relax', arr
  );
end;
$function$;
