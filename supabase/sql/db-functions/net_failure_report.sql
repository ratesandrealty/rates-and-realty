-- net_failure_report(p_days integer)
-- language: sql
-- Captured from production 2026-08-07.
--
-- Captured by hand — see the note in capture_net_failures.sql for why
-- recapture-db-functions.mjs could not do it.

CREATE OR REPLACE FUNCTION public.net_failure_report(p_days integer DEFAULT 1)
 RETURNS TABLE(status text, sb_error_code text, occurrences bigint, first_seen timestamp with time zone, last_seen timestamp with time zone, sample_body text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    case
      when f.timed_out then 'timeout'
      when f.status_code is null then 'no response'
      else f.status_code::text
    end                                              as status,
    coalesce(f.sb_error_code, '—')                   as sb_error_code,
    count(*)                                         as occurrences,
    min(f.occurred_at)                               as first_seen,
    max(f.occurred_at)                               as last_seen,
    left(min(f.content), 120)                        as sample_body
  from public.net_call_failures f
  where f.occurred_at > now() - make_interval(days => p_days)
  group by 1, 2
  order by occurrences desc, last_seen desc;
$function$
