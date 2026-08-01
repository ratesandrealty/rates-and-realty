-- ── DEAD-MAN'S SWITCH FOR gdrive-health-monitor ─────────────────────────────
--
-- WHY THIS IS SQL AND NOT MORE TYPESCRIPT
--
-- On 2026-08-01 a generator emitted a bare ${RED} into three alert branches of
-- gdrive-health-monitor with no such constant in TypeScript scope. Every run
-- that selected one of those branches threw "RED is not defined" and returned
-- 500. pg_cron dutifully recorded the 500 in net._http_response and told nobody.
-- The only symptom was silence — and silence is exactly what a healthy monitor
-- looks like. It went unnoticed because the branch selected up to then used a
-- literal emoji; the storage reconciliation check going unhealthy is what
-- finally routed execution into a broken branch.
--
-- The monitor now stamps system_state 'monitor:gdrive_health' on every run that
-- reaches a response, and its fatal catch tries to alert. Neither is sufficient:
-- both are JavaScript in the same module as the bug. A typo in the catch block,
-- an import that fails to resolve, a Deno boot error — any of those and the
-- self-report dies alongside the thing it was meant to report on.
--
-- So the check that actually guarantees someone hears lives here. It has no
-- template literals, no constants, no imports, and does not require
-- gdrive-health-monitor to load at all.
--
-- HONEST LIMIT: alerting still leaves Postgres over net.http_post to an edge
-- function (clickup-auto-create, via the same fire_clickup_automation every
-- other SQL-side alert in this database uses). If the entire edge runtime is
-- down, neither channel works. That is a genuinely different failure from a
-- code bug in one function — louder, and not the one this switch exists for.
-- The service key is deliberately not embedded here: this file is committed.
--
-- Threshold: the monitor runs hourly (cron.job id 6, '7 * * * *'). Three missed
-- runs tolerates one transient boot failure and still surfaces the same morning.

create or replace function public.monitor_deadman_check()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_beat      timestamptz;
  v_last_sent timestamptz;
  v_err       text;
  v_age_min   numeric;
begin
  select (value ->> 'at')::timestamptz into v_beat
    from system_state where key = 'monitor:gdrive_health';

  -- Never stamped means either the heartbeat shipped moments ago and no run has
  -- completed yet, or the monitor has never once run to completion. Both are
  -- worth saying out loud rather than defaulting to healthy.
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
        '    - Last recorded error: ' || coalesce(v_err, 'none recorded — it is failing before it can record one') || E'\n' ||
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
$$;

revoke all on function public.monitor_deadman_check() from anon, authenticated;

-- Every 30 minutes. Cheap: one indexed row read, and it returns on the healthy
-- path before touching anything else.
select cron.schedule('monitor-deadman', '*/30 * * * *',
                     $$select public.monitor_deadman_check();$$);
