-- presence_day(p_user uuid, p_day date)
-- language: plpgsql   SECURITY DEFINER
-- Captured 2026-08-06 (presence heartbeat).

CREATE OR REPLACE FUNCTION public.presence_day(p_user uuid DEFAULT NULL::uuid, p_day date DEFAULT NULL::date)
 RETURNS TABLE(pht_day date, first_beat timestamp with time zone, last_beat timestamp with time zone, active_seconds integer, window_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Active time for ONE PHT day, gap-sessionised at the 10-minute idle cutoff.
 *
 * Bucketed on Asia/Manila deliberately: a shift starting 09:00 PHT is 18:00 PT
 * the PREVIOUS day, so bucketing on Rene's calendar day would cut every shift in
 * half and report two short days instead of one real one.
 *
 * A gap of 10 minutes or less is treated as continuous — that is what absorbs a
 * five-minute dropout instead of fragmenting the day. Gaps longer than that are
 * simply not counted; she is not paid for them and this is not a payslip.
 *
 * Admins may read anyone; everyone else only themselves. */
declare v_user uuid := coalesce(p_user, auth.uid());
begin
  if v_user <> auth.uid() and not is_admin() then raise exception 'not authorized'; end if;

  return query
  with b as (
    select beat_at,
           (beat_at at time zone 'Asia/Manila')::date as d,
           beat_at - lag(beat_at) over (order by beat_at) as gap
    from presence_beats
    where user_id = v_user
      and (p_day is null or (beat_at at time zone 'Asia/Manila')::date = p_day)
  ),
  marked as (
    select *, case when gap is null or gap > interval '10 minutes' then 1 else 0 end as new_window from b
  ),
  windowed as (
    select *, sum(new_window) over (order by beat_at) as win from marked
  ),
  spans as (
    select d, win, min(beat_at) as w_start, max(beat_at) as w_end from windowed group by d, win
  )
  select s.d,
         min(s.w_start),
         max(s.w_end),
         sum(extract(epoch from (s.w_end - s.w_start)))::int,
         count(*)::int
  from spans s group by s.d order by s.d desc;
end; $function$;
