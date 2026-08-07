-- capture_net_failures()
-- language: plpgsql
-- Captured from production 2026-08-07.
--
-- Captured BY HAND, not by tools/recapture-db-functions.mjs: that tool shells out
-- to `supabase projects api-keys`, which the installed CLI (v2.98.2) can no
-- longer parse — it rejects the `inserted_at` timestamp on the API-key rows
-- added 2026-08-07. tools/observe-db-functions.mjs is down for the same reason.

CREATE OR REPLACE FUNCTION public.capture_net_failures()
 RETURNS TABLE(inserted integer, already_had integer, window_start timestamp with time zone, window_end timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net'
AS $function$
declare
  v_ins integer;
  v_seen integer;
  v_lo timestamptz;
  v_hi timestamptz;
begin
  select min(created), max(created) into v_lo, v_hi from net._http_response;

  with candidates as (
    select r.id, r.created, r.status_code, r.timed_out, r.error_msg,
           left(regexp_replace(coalesce(r.content, ''), '\s+', ' ', 'g'), 500) as content,
           r.headers ->> 'sb-request-id'                as sb_request_id,
           r.headers ->> 'sb-error-code'                as sb_error_code,
           r.headers ->> 'access-control-allow-methods' as cors_methods
    from net._http_response r
    -- A NULL status is a transport failure (timeout, DNS, TLS) and matters as
    -- much as a 5xx: the call never landed either way.
    where r.status_code is null or r.status_code >= 400
  ), ins as (
    insert into public.net_call_failures
      (response_id, occurred_at, status_code, timed_out, error_msg, content,
       sb_request_id, sb_error_code, cors_methods)
    select id, created, status_code, timed_out, error_msg, content,
           sb_request_id, sb_error_code, cors_methods
    from candidates
    on conflict (response_id) do nothing
    returning 1
  )
  select (select count(*) from ins), (select count(*) from candidates)
    into v_ins, v_seen;

  return query select v_ins, v_seen - v_ins, v_lo, v_hi;
end;
$function$
