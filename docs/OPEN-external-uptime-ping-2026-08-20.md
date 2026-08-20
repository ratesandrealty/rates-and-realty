# OPEN — the end of the monitoring chain, and what closing it would take

**Held deliberately. Not a bug; a known boundary.**

## The chain, and where it stops

```
gdrive-health-monitor  ─┐
deploy-watch           ─┴─▶  monitor_deadman_check   ─▶  ???
   (each writes a heartbeat)      (job 'monitor-deadman', */30)
```

`monitor_deadman_check` notices when either watched monitor stops reporting. It
is the job with the simplest body and the shortest interval, which is why the
recursion stops there — but it stops there **unwatched**.

Two failure modes are therefore invisible from inside:

1. **`monitor-deadman` itself is disabled, dropped, or throwing.** Everything
   downstream goes quiet and quiet is what healthy looks like.
2. **pg_cron is not running at all**, or the database is unreachable. Every
   heartbeat, every check and both alert channels are downstream of Postgres
   working.

Neither can be closed by anything else in this database, because anything else in
this database shares the dependency. **It needs a heartbeat observed from
outside.**

## What closing it would take — the three decisions, not just the work

### 1. A service

Standard shape is a dead-man's-switch / cron-monitor endpoint: something posts to
a URL on a schedule, and the service alerts when a post does not arrive. Candidates
differ mainly in who they page and what they cost:

- a hosted cron-monitor (Healthchecks.io, Cronitor, Better Stack and similar)
- Cloudflare Workers Cron + an alert — plausible, since the site is already a
  Worker, but it shares no dependency with Postgres, which is the point
- an uptime monitor hitting a small public endpoint that reports monitor freshness

**This is a decision, not a detail:** it introduces a third-party with a
dependency on our alerting, and one more account to keep alive.

### 2. A secret

The ping URL is a credential — anyone holding it can fake a heartbeat and keep the
alarm silent forever. So it belongs in the vault, not in `pg_proc` in cleartext.
`CLAUDE.md` already records this exact hazard: `trigger_score_recalc` and
`fire_lender_automation` both paste the service key into function source, and
`verify_cron_secret()` exists specifically so Postgres callers can prove
themselves without holding one.

Whatever is chosen should follow the `verify_cron_secret` pattern rather than
adding a tenth place a secret lives.

### 3. Which channel it pages

The bell is in the database. If the database is the thing that is down, the bell
is down with it. So the external monitor must page somewhere genuinely separate —
SMS to Rene's cell, or email from the monitoring service itself. That decision
interacts with quiet hours: `gdrive-health-monitor` already declares
`staff_alert` for exactly this reason, and an external service will not know to.

## Why it is worth doing eventually

Everything built today — `deploy_watch_run`, the extended dead-man, `monitor_runs`,
the heartbeats — improves the odds that a failure is *noticed*. None of it survives
the case where the thing doing the noticing is itself down. That case has happened
before in this project in a smaller form: the `${RED}` bug on 2026-08-01 killed
`gdrive-health-monitor` outright and the only symptom was silence, which is what
prompted the dead-man switch in the first place.

The dead-man closed that one level. This is the next level up, and it is the last
one reachable without leaving the building.

## Why it is being held

It needs a service chosen, an account created, a secret provisioned into the vault
and a paging channel decided. None of that is a code change, and picking a vendor
inside an unrelated work session is how a dependency arrives that nobody
remembers agreeing to.

**Recommendation when it is picked up:** whichever service, wire it to
`monitor_deadman_check`'s own success — a small function that posts the ping only
when the dead-man ran and returned — so the external heartbeat proves the *whole
internal chain*, not just that Postgres accepted a connection.
