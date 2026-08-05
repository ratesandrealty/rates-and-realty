-- monitor_deadman_check()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.monitor_deadman_check()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_beat      timestamptz;
  v_last_sent timestamptz;
  v_err       text;
  v_age_min   numeric;
begin
  select (value ->> 'at')::timestamptz into v_beat
    from system_state where key = 'monitor:gdrive_health';

  v_age_min := extract(epoch from (now() - coalesce(v_beat, now() - interval '999 days'))) / 60;

  if v_age_min < 190 then
    return jsonb_build_object('ok', true, 'age_minutes', round(v_age_min));
  end if;

  select value ->> 'error' into v_err
    from system_state where key = 'monitor:gdrive_health_error';

  select (value ->> 'sent_at')::timestamptz into v_last_sent
    from system_state where key = 'gdrive_alert:monitor_deadman';
  if v_last_sent is not null and v_last_sent > now() - interval '6 hours' then
    return jsonb_build_object('ok', false, 'age_minutes', round(v_age_min),
                              'suppressed', 'cooldown', 'last_error', v_err);
  end if;

  perform public.fire_clickup_automation(
    'system_health_alert',
    null,
    'monitor-deadman:' || to_char(now(), 'YYYY-MM-DD-HH24'),
    jsonb_build_object(
      'fail_count', '1',
      'scan_date', to_char(now() at time zone 'America/Los_Angeles',
                           'Mon DD, YYYY HH12:MI AM') || ' PT',
      'fail_list',
        '- **[monitoring] gdrive-health-monitor has stopped reporting**' || E'\n' ||
        '    - Last completed run: ' ||
          coalesce(to_char(v_beat at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC (' ||
                   round(v_age_min / 60, 1) || ' hours ago)', 'never') || E'\n' ||
        '    - Last recorded error: ' || coalesce(v_err, 'none recorded - it is failing before it can record one') || E'\n' ||
        '    - Fix: it runs hourly, so it is crashing before it can report. Nothing it watches is being watched: Drive credential, backup freshness, storage reconciliation, embeddings, indexing are all downstream of this function completing.' || E'\n' ||
        '    - Logs: https://supabase.com/dashboard/project/ljywhvbmsibwnssxpesh/functions/gdrive-health-monitor/logs' || E'\n',
      'warn_summary', 'none',
      'dashboard_url', 'https://admin.ratesandrealty.com/dashboard/admin.html'
    )
  );

  insert into system_state (key, value, updated_at)
  values ('gdrive_alert:monitor_deadman',
          jsonb_build_object('sent_at', now(), 'age_minutes', round(v_age_min),
                             'last_error', v_err), now())
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at;

  return jsonb_build_object('ok', false, 'age_minutes', round(v_age_min),
                            'alerted', true, 'last_error', v_err);
end;
$function$;
