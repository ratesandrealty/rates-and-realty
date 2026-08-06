-- is_quiet_hours(p_user uuid, p_at timestamp with time zone)
-- language: sql   SECURITY DEFINER
-- Captured 2026-08-06 (quiet hours).

CREATE OR REPLACE FUNCTION public.is_quiet_hours(p_user uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Is it currently quiet hours for this user, in THEIR timezone?
 *
 * Handles windows that cross midnight, which both of these do: 21:00-07:00 PT
 * and 22:00-06:00 PHT. A naive `local between start and end` returns FALSE for
 * every hour of both windows, because start > end — it would have silently
 * disabled the whole feature while looking correct.
 *
 * No row, or enabled=false, means never quiet: an unconfigured user keeps
 * today's behaviour rather than losing alerts to a default nobody chose. */
  select coalesce((
    select case
      when not q.enabled then false
      when q.start_local <= q.end_local
        then (p_at at time zone q.tz)::time >= q.start_local
         and (p_at at time zone q.tz)::time <  q.end_local
      else (p_at at time zone q.tz)::time >= q.start_local
        or  (p_at at time zone q.tz)::time <  q.end_local
    end
    from notification_quiet_hours q where q.user_id = p_user
  ), false);
$function$;
