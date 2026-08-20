-- monitor_deadman_check()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-20. This layer had NO git history:
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
  v_beat        timestamptz;
  v_err         text;
  v_age_min     numeric;
  v_dead        text[] := '{}';
  v_lines       text := '';
  v_key         text;
  v_last_sent   timestamptz;
  v_detail      jsonb := '[]'::jsonb;
begin
  /* A WATCHER CANNOT WATCH ITSELF. deploy_watch_run writes its own last_run on
     every run, but if its cron job is disabled or it starts throwing, it is not
     running -- so nothing inside it can notice. The check must live somewhere
     with an INDEPENDENT schedule, which is what this already is for
     gdrive-health-monitor. One dead-man, several heartbeats.

     KEYED ON THE SET OF DEAD MONITORS, NOT THE FIRST FOUND. This used to return
     as soon as gdrive was healthy, so a dead deploy-watch would have been
     invisible whenever gdrive was fine, and a gdrive cooldown would have
     silenced the whole channel. That is the exact 32-hour masking failure
     CLAUDE.md records for gdrive-health-monitor's own alerting. The cooldown key
     is the sorted set, so a NEW failure always changes it and always breaks the
     cooldown.

     HONEST LIMIT: alerting is downstream of Postgres working, and NOTHING
     WATCHES THIS FUNCTION. The recursion stops here, at the job with the
     simplest body and the shortest interval. */

  -- gdrive-health-monitor: hourly (job 6), 190 min ~= 3 missed runs
  select (value ->> 'at')::timestamptz into v_beat
    from system_state where key = 'monitor:gdrive_health';
  v_age_min := extract(epoch from (now() - coalesce(v_beat, now() - interval '999 days'))) / 60;
  if v_age_min >= 190 then
    select value ->> 'error' into v_err from system_state where key = 'monitor:gdrive_health_error';
    v_dead := v_dead || 'gdrive_health'::text;
    v_detail := v_detail || jsonb_build_object('monitor','gdrive_health','age_minutes',round(v_age_min));
    v_lines := v_lines
      || '- **[monitoring] gdrive-health-monitor has stopped reporting**' || E'\n'
      || '    - Last completed run: '
      || coalesce(to_char(v_beat at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC ('
                  || round(v_age_min / 60, 1) || ' hours ago)', 'never') || E'\n'
      || '    - Last recorded error: ' || coalesce(v_err, 'none recorded -- it is failing before it can record one') || E'\n'
      || '    - Fix: it runs hourly, so it is crashing before it can report. Drive credential, backup freshness, storage reconciliation, embeddings and indexing are all downstream of this function completing.' || E'\n'
      || '    - Logs: https://supabase.com/dashboard/project/ljywhvbmsibwnssxpesh/functions/gdrive-health-monitor/logs' || E'\n';
  end if;

  -- deploy-watch: every 6h (job 52), 1200 min = 20h ~= 3 missed runs
  select (value ->> 'ran_at')::timestamptz into v_beat
    from system_state where key = 'deploy:watch_last_run';
  v_age_min := extract(epoch from (now() - coalesce(v_beat, now() - interval '999 days'))) / 60;
  if v_age_min >= 1200 then
    v_dead := v_dead || 'deploy_watch'::text;
    v_detail := v_detail || jsonb_build_object('monitor','deploy_watch','age_minutes',round(v_age_min));
    v_lines := v_lines
      || '- **[monitoring] deploy-watch has stopped reporting**' || E'\n'
      || '    - Last completed run: '
      || coalesce(to_char(v_beat at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC ('
                  || round(v_age_min / 60, 1) || ' hours ago)', 'never') || E'\n'
      || '    - It runs every 6 hours (pg_cron job ''deploy-watch''). Check the job still exists and is active.' || E'\n'
      || '    - While it is down NOTHING NOTICES UNDEPLOYED WORK -- which is how 52 commits sat out of production for five days on 2026-08-15.' || E'\n';
  end if;

  if array_length(v_dead, 1) is null then
    return jsonb_build_object('ok', true);
  end if;

  select 'deadman:' || string_agg(dd, '+' order by dd) into v_key from unnest(v_dead) dd;

  select (value ->> 'sent_at')::timestamptz into v_last_sent
    from system_state where key = 'gdrive_alert:' || v_key;
  if v_last_sent is not null and v_last_sent > now() - interval '6 hours' then
    return jsonb_build_object('ok', false, 'dead', v_dead, 'suppressed', 'cooldown', 'detail', v_detail);
  end if;

  perform public.fire_clickup_automation(
    'system_health_alert', null,
    v_key || ':' || to_char(now(), 'YYYY-MM-DD-HH24'),
    jsonb_build_object(
      'fail_count', array_length(v_dead, 1)::text,
      'scan_date', to_char(now() at time zone 'America/Los_Angeles', 'Mon DD, YYYY HH12:MI AM') || ' PT',
      'fail_list', v_lines,
      'warn_summary', 'none',
      'dashboard_url', 'https://admin.ratesandrealty.com/dashboard/admin.html'));

  /* The bell too, which is the channel that actually gets read. An alert nobody
     opens is a log. */
  perform public.app_notify_system(
    p_source_kind   => 'monitor_deadman',
    p_source_id     => null,
    p_body          => 'Monitor dead-man: ' || array_to_string(v_dead, ', ')
                       || ' has stopped reporting. Whatever it watches is now unwatched.',
    p_actor_display => 'Monitor dead-man',
    p_roles         => array['admin']);

  insert into system_state (key, value, updated_at)
  values ('gdrive_alert:' || v_key,
          jsonb_build_object('sent_at', now(), 'dead', v_dead, 'detail', v_detail), now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;

  return jsonb_build_object('ok', false, 'dead', v_dead, 'alerted', true, 'detail', v_detail);
end;
$function$;
