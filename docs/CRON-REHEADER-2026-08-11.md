# Re-headering the cron jobs onto `internal_call_headers()`

Done ahead of guarding the remaining senders, so that adding a guard is a
guard-only change with the outage risk already removed.

23 of 37 pg_cron jobs call an edge function. 5 already used
`internal_call_headers()`. **16 were rewritten. 4 of those broke and were rolled
back.** Rollback source: `public.cron_job_commands_20260811` (all 37 commands,
snapshotted before any change).

## The assumption that was wrong

The plan rested on: *re-headering is behaviour-neutral while a function still
accepts anything.* True — but **four of the sixteen do not accept anything**, and
I did not check that per function before the bulk rewrite. Three ways a call can
be refused, and only the first was on my mind:

| refusal | example | what it looks like |
|---|---|---|
| in-function `requireStaff` | the ones being guarded | 401 from the function |
| **in-function `x-cron-secret`** | `proactive-followups`, `voe-inbound-poll` | **403 "missing or invalid x-cron-secret"** |
| **gateway `verify_jwt = true`** | `market-rate` | **401 `UNAUTHORIZED_NO_AUTH_HEADER`** |

`internal_call_headers()` sends `x-internal-secret` and **no Authorization
header at all**. So it fails both of the bottom two — a different secret name,
and no JWT for the gateway.

Caught by probing, not by review. Every one of the four returned 200-shaped
success at the `cron.job_run_details` level (`succeeded` = *queued*); only
`net._http_response` showed the 403/401.

## Do NOT re-header these four

| job | function | needs | why |
|---|---|---|---|
| 20 | `proactive-followups?mode=digest` | `x-cron-secret` | own guard, different secret name |
| 21 | `proactive-followups?mode=urgent` | `x-cron-secret` | same |
| 37 | `voe-inbound-poll` | `x-cron-secret` | same |
| 24 | `market-rate` | a JWT | `verify_jwt = true` — the GATEWAY rejects before the function runs |

All four restored byte-exactly and verified `command = snapshot.command`.

Making them consistent would mean either teaching `require-staff` to accept
`x-cron-secret` as well, or migrating those functions to `x-internal-secret` —
a change to a *working* guard, which is not worth doing as a side effect of
tidying headers.

## The 12 that stand

Nothing else in any command changed: url, body, query string, timeout, schedule
and `active` all compared byte-identical against the snapshot with only the
headers argument normalised out. **No JWT remains in any cron command** — the
anon key was previously sitting in `cron.job` in cleartext.

| job | function | was sending | proven after |
|---|---|---|---|
| 32 | `treasury-yields` | no auth header | **200** `upserted:90` (probe) |
| 33 | `news-feed` | no auth header | **200** `upserted:10` (probe) |
| 36 | `gdrive-sync` | anon key | **200** `No pending docs` (natural run 22:40) |
| 9 | `chunk-guidelines-large` | no auth header | ran 22:35 + 22:40, made no HTTP call — its command only POSTs when a guideline is pending |
| 2 | `weekly-backup` | no auth header | awaiting natural run (Sun 08:00) |
| 4 | `send-listing-alerts` | no auth header | awaiting natural run (*/30) |
| 5 | `gdrive-sync-guideline` | anon key | awaiting natural run (03:30) |
| 6 | `gdrive-health-monitor` | anon key | awaiting natural run (hourly :07) |
| 12 | `lead-scorer` | anon key | awaiting natural run (12:00) |
| 15 | `clickup-bridge` | no auth header | awaiting natural run (*/15) |
| 18 | `lead-scorer` | anon key | awaiting natural run (12:00) |
| 19 | `google-token-refresh` | anon key | awaiting natural run (*/30) |

**Not probed, deliberately.** `weekly-backup` writes a full backup to Drive with
rene@'s token that `gdrive-proxy` cannot clean up; `gdrive-health-monitor` has 9
send sites and no dry-run; `lead-scorer`, `gdrive-sync-guideline` and
`send-listing-alerts` do real work off-schedule. None has a dry-run or read-only
path, so per the rule they wait for a natural run rather than being forced.

**What "proven" means here, precisely:** these 12 functions are unguarded, so
nothing yet *reads* `x-internal-secret`. A 200 proves the job still works with
the new header — the header is inert until a guard lands. The header is proven
*accepted* only at the moment its guard is added, which is what was done for
`bot-process-queue` and `tours-send-reminders`.

## Corrections to `docs/OPEN-ENDPOINTS-2026-08-11.md`

Two functions are tagged **SENDS-SMS** and do not send:

- **`sms-inbound-reconcile`** — its only Twilio call is a `GET` of
  `Messages.json`. It writes `sms_suppressions` and raises an in-app alert.
- **`lead-scorer`** — only *reads* `sms_log` to compute an engagement score.

Both still deserve guards; the tag is what is wrong, and it is the tag that sets
the priority order.

## Correction to `CLAUDE.md`

CLAUDE.md states pg_cron job 2 `weekly-crm-backup` is **disabled** pending the R2
sync, and that "nothing is currently producing backups". **It is `active = true`
and last ran 2026-08-09 08:00Z.** Whether it is producing *good* backups is a
separate question — the `fetchSiteFile` soft-404 issue is documented there — but
it is running.
