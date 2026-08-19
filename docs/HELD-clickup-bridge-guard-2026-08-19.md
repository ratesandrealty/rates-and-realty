# Held: the `clickup-bridge` guard — 2026-08-19

**Not built. Deliberately.** It is the last of the six confirmed-open Tier A
functions and the only one that cannot be closed the way the other four were.
Everything needed to do it is here; what is missing is a pass of its own.

## Why it is not a `requireStaff(req)` drop-in

**Two of its callers reach it with NO Authorization header, by design**, and its
pin comment in `supabase/config.toml` says so:

- **pg_cron job 15** (`clickup-bridge-sync`, `*/15`)
- **`sms-assistant`**, whose `create_clickup_task` / `list_my_tasks_today` header
  comment records that a stray bearer used to 401 at the gateway

The bridge authenticates to ClickUp with the raw `CLICKUP_API_TOKEN`; it has
never needed a Supabase credential of its own. A plain `requireStaff` would 401
both on the first request.

**This has already happened once, and the pin records the cost:** the function
was deployed UNPINNED on 2026-07-31 10:17, took the CLI default of
`verify_jwt = true`, and every caller was 401'd at the gateway from that moment.
The cron sync stopped refreshing `clickup_task_cache` and Rene's SMS task
creation returned "auth error (401)". **Nothing alerted.** It was the fourth
instance of that exact failure, after `send-scheduled-sms`,
`send-scheduled-emails` and `sms-service`.

## The order, which is the whole point

Same shape as `send-scheduled-sms`, and it must not be compressed:

1. **Re-header pg_cron job 15 to `internal_call_headers()` FIRST**, so it sends
   `x-internal-secret` — the secret Postgres reads from the vault at call time,
   verified in-DB by `verify_cron_secret()`. Confirm a production run returns 200
   **by reading `net._http_response`**, not by trusting
   `cron.job_run_details.status = 'succeeded'`, which only ever means the request
   was queued.
2. **Give `sms-assistant` the service key** on its two bridge calls (it already
   holds one), or route it through `internal_call_headers()` as well.
3. **Then** land `requireStaff(req, { allowInternal: true })`, before `req.json()`.
4. `verify_jwt` stays **false** — the pin is correct and must not be flipped as
   part of this. The gateway cannot be the control here; the in-function guard is.

## The browser half, separately

Six browser call sites, five sending the anon key:

| caller | identity |
|---|---|
| `admin/js/task-capture.js:488` | **session** (`access_token`) |
| `admin/lead-detail.html:11372` | anon key |
| `admin/va-tasks.html:858` | anon key |
| `dashboard/utils/clickup-automations.js:318` | anon key |
| `dashboard/utils/clickup-tasks.js:25` | anon key |
| `dashboard/utils/clickup-widget.js:52` | anon key |

Those five move to `fnFetch` and get confirmed **before** the guard, exactly as
`bot-admin` and `lead-scorer` were. Note `clickup-bridge` is also one of the
functions whose anonymous GET returns its **full route listing** (measured: HTTP
200 with a `routes[]` array), so the disclosure closes with the guard.

## Two internal callers that DO hold the service key

`clickup-auto-create` and `sms-assistant` both have it — `sms-assistant` simply
does not send it on these two calls today.

## Current state, measured 2026-08-19

Anonymous POST → **HTTP 200**, full route listing returned. Reaches `app_config`,
`clickup_task_cache`, `tasks`, `contacts` and `clickup_outbox` with the service
role.

Tier A stands at **4 of 6 closed** (`borrower-drive`, `gdrive-sync`, `bot-admin`,
`lead-scorer`); `portal-data` is correctly open as the borrower portal's own
backend; this is the one that remains.
