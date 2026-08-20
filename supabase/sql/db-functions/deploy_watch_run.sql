-- deploy_watch_run(p_notify boolean)
-- language: plpgsql
-- Captured from production 2026-08-20.

CREATE OR REPLACE FUNCTION public.deploy_watch_run(p_notify boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_threshold_hours int;
  v_quiet_hours     int;
  v_row             record;
  v_at              timestamptz;
  v_age_hours       numeric;
  v_state           text;
  v_commit          text;
  v_body            text;
  v_last_notified   timestamptz;
  v_sent            boolean := false;
  v_result          jsonb;
begin
  -- Tunable without a migration; sane defaults if app_config has no row.
  v_threshold_hours := coalesce((select nullif(value,'')::int from app_config where key='deploy_watch_threshold_hours'), 48);
  v_quiet_hours     := coalesce((select nullif(value,'')::int from app_config where key='deploy_watch_quiet_hours'), 24);

  select s.value, s.updated_at into v_row from system_state s where s.key = 'deploy:last_success';

  if v_row is null then
    /* THREE OUTCOMES, NOT TWO. A missing heartbeat is UNKNOWN, not healthy.
       CLAUDE.md: never add a check that can pass when it could not run. This is
       the state on the very first run, before any deploy has stamped one — and
       it is also what a broken record-deploy.mjs would look like, so it must be
       visible rather than silently green. */
    v_state := 'unknown';
    v_body  := 'Deploy watcher: NO DEPLOY HEARTBEAT RECORDED. '
            || 'Either nothing has been deployed through tools/deploy.sh since the watcher was installed, '
            || 'or tools/record-deploy.mjs is failing. This is not "healthy" — it is unverified.';
  else
    v_at     := coalesce((v_row.value->>'at')::timestamptz, v_row.updated_at);
    v_commit := v_row.value->>'commit';
    v_age_hours := round(extract(epoch from (now() - v_at)) / 3600.0, 1);

    if v_age_hours <= v_threshold_hours then
      v_state := 'fresh';
      v_body  := null;
    else
      v_state := 'stale';
      v_body  := format(
        'Deploy watcher: nothing has deployed for %s hours (%s days). Last verified deploy %s%s. '
        || 'Committed work may be sitting out of production — that is exactly how 52 commits went unshipped for five days on 2026-08-15. '
        || 'Run: bash tools/deploy.sh',
        v_age_hours,
        round(v_age_hours / 24.0, 1),
        to_char(v_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') || ' PT',
        case when v_commit is null then '' else ' (' || v_commit || ')' end);
    end if;
  end if;

  -- Quiet period, so a genuinely idle week does not notify hourly.
  select (value->>'at')::timestamptz into v_last_notified
    from system_state where key = 'deploy:watch_last_notified';

  if p_notify and v_body is not null
     and (v_last_notified is null or now() - v_last_notified > make_interval(hours => v_quiet_hours)) then
    perform public.app_notify_system(
      p_source_kind   => 'deploy_watch',
      p_source_id     => null,
      p_body          => v_body,
      p_actor_display => 'Deploy watcher',
      p_contact_id    => null,
      p_roles         => array['admin'],
      p_link          => null);
    insert into system_state(key, value, updated_at)
      values ('deploy:watch_last_notified', jsonb_build_object('at', now(), 'state', v_state), now())
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
    v_sent := true;
  end if;

  v_result := jsonb_build_object(
    'state', v_state,
    'age_hours', v_age_hours,
    'threshold_hours', v_threshold_hours,
    'last_deploy_at', v_at,
    'last_commit', v_commit,
    'notified', v_sent,
    'body', v_body);

  -- Its own logbook, overwritten each run, so a silent watcher is distinguishable
  -- from a watcher that has never run.
  insert into system_state(key, value, updated_at)
    values ('deploy:watch_last_run', v_result || jsonb_build_object('ran_at', now()), now())
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;

  return v_result;
end;
$function$;
