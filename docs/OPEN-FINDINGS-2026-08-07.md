# Open findings — 2026-08-07

Written so these survive the session. **Nothing here is fixed.** Each entry says
what is true, how it was established, and what would close it.

Two of these were found only because a claim was challenged rather than accepted.
That is worth saying at the top: the counts in this file have been wrong three
times, and each correction came from opening a file rather than trusting a
pattern.

---

## 1. `delete-contacts` is open — latent, not actively exploited

**State: FRONTEND HALF DONE, GUARD NOT WRITTEN.**

`admin/people.html` now sends the signed-in user's session token (commit on
2026-08-07, copied from `admin/lead-detail.html:17093`). The function itself is
unchanged: **no auth, `verify_jwt = false`, service-role credential**.

The entire gate is a shape check:

```ts
const { contact_ids } = await req.json();
if (!Array.isArray(contact_ids) || !contact_ids.length)
  return new Response(JSON.stringify({ error: 'contact_ids array required' }), { status: 400, headers: cors });
```

It then DELETEs from `contacts` with the service key. All FK constraints are
`ON DELETE CASCADE`, so one call removes the borrower's whole tree. **No audit or
activity row is written** — the only record is the edge log, and nothing records
who asked.

**Why it is latent rather than active:** `contacts.id` is `uuid` v4,
`gen_random_uuid()`, 1,045 rows. Not enumerable, and anon cannot list them —
`contacts_select_scoped` returns `Content-Range: */0` to the anon key.

**Why it is still real:** ids are obtainable without authenticating.
`listing-alert-actions` is unauthenticated by design (borrower portal) and does:

```ts
const { data: c } = await sb.from('contacts').select('id').eq('email', lookupEmail).single();
contact_id = c?.id || null;
...
}).select().single();
return ok({ success: true, alert: newAlert, ... });   // newAlert carries contact_id
```

So an email address yields that person's uuid, and the uuid yields a cascaded
delete. Two unauthenticated calls. **Established by reading source; never tested
against data, real or fixture** — a fixture test would still have proved the
endpoint open by deleting something.

**To close:** confirm bulk delete still works on `/admin/people`, then guard the
function with `requireStaff`. Separately, stop `listing-alert-actions` returning
the resolved `contact_id`.

---

## 2. The `⚠️ Sync Failure Alert` n8n workflow has been 401ing since 08-04

**State: BROKEN IN PRODUCTION, NOT FIXED.**

Workflow `⚠️ Sync Failure Alert` (id `qdVAByVmmqJFKjj7`), node
**`Send Failure Email`**:

```
url:     https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/email-service
headers: Content-Type: application/json        <- and nothing else
```

`email-service` gained an in-function guard in `79ca8d1` on **2026-08-04
00:37:42**. This call carries no Authorization and no apikey, so it has failed
every time since.

**It is the workflow that reports every other workflow's failure**, wired as the
default error workflow. So n8n failures have been silent for the same period.
Same root cause as the five DB callers fixed on 08-07 — the guard's caller audit
covered browser and Postgres callers and never looked at n8n.

**To close:** give it the same treatment as the DB callers — an internal
credential the guard accepts. Note n8n cannot read the vault, so
`internal_call_headers()` does not apply; it needs its own path.

---

## 3. Functions with no in-function authorization: **65**

**Corrected three times. Do not quote an older number.**

```
audit-function-guards 'no auth' rows                       70
minus _shared (a library, not a function)                  -1
minus tour-public-view (share_token capability gate)       -1
minus refi-watch, critical-date-reminders,
      post-close-followups (x-cron-key compare)            -3
= 65
```

Every correction was a **detector gap**, not a code change:

| missed pattern | functions | why the detector missed it |
|---|---|---|
| `share_token` row token | `tour-public-view` | it only knew `form_token` |
| `x-cron-key` compare | `refi-watch`, `critical-date-reminders`, `post-close-followups` | it knew `x-cron-secret` and `x-internal-secret`, not this third name |

`tools/audit-function-guards.mjs` still does not recognise either pattern. **The
65 is an upper bound on unguarded, not a proven floor** — a fourth convention
could still be hiding, exactly as the third was.

Grouped by capability (see `docs/EDGE-FUNCTION-CAPABILITY-MAP.md`), the
send-capable ones matter most: `ai-sms-bot`, `campaign-send-now`,
`click-to-call`, `listing-alert-actions`, `listing-alert-matcher`,
`loan-date-nudges`, `newsletter-signup`, `send-listing-alerts`,
`send-scheduled-emails`, `send-scheduled-sms`, `sms-inbound-reconcile`,
`tours-admin`, `tours-send-reminders`, `gdrive-health-monitor`. All read in full;
none has an allowlist, header comparison, IP check or shared-helper call.

**Related, and separate:** the `x-cron-key` secret is hardcoded in cleartext in
three function sources (`const CRON_KEY = "rnr-cron-…"`) **and** in the n8n
workflow node. It is a working control, but it lives in two places neither of
which is a secret store.

---

## 4. `calcom-webhook` fails open if its secret is ever cleared

**State: NOT A HOLE TODAY. LATENT.**

```ts
async function verifySignature(body: string, signature: string | null): Promise<boolean> {
  if (!CAL_WEBHOOK_SECRET || !signature) return !CAL_WEBHOOK_SECRET;
  ...
}
```

`return !CAL_WEBHOOK_SECRET` returns **true** — accept — when the secret is
empty. Verified against the deployed secret list (not the repo):
`CAL_WEBHOOK_SECRET` is present with digest `e9ce7b6f…`, which differs from the
SHA-256 of the empty string (`e3b0c442…`), so it is non-empty. Set 2026-03-24.

The HMAC is enforced today. Clear or rotate that secret to an empty value and
every unsigned request is accepted silently.

**To close:** invert the default — fail closed when unconfigured.

---

## 5. `campaign-send-now` and `listing-alert-matcher` have no known caller

**State: UNKNOWN, NOT RESOLVED.**

Neither appears in the repo, in any Postgres function body, or in any pg_cron
job. `campaign-send-now`'s own header says it writes `email_log` rows with
`status='scheduled'` for the every-minute cron to collect — so something must
invoke it.

**The most likely explanation is an n8n workflow, and six of eleven were never
opened** (see below). Do not treat "no caller found" as "no caller".

---

## 6. What this audit did NOT cover

- **Six of eleven n8n workflows were never opened.** Node contents unknown:
  `Lender Prospect Follow-Up Reminders`, `Google Calendar Two-Way Sync`,
  `ClickUp → CRM Calendar Daily Sync`, `Rates & Realty — Critical Date
  Reminders`, `Rates & Realty — 5-Month Post-Close Touchpoint`, `Roll Overdue
  Tasks to Tomorrow`. Five were opened: `Borrower Stage Foldering`,
  `⚠️ Sync Failure Alert`, `Contact Folder Creator`, `Lender Folder Creator`,
  `Refi Opportunity Watch`. Of the five, **four call an edge function and three
  of those send no authentication at all** (`gdrive-proxy` ×2, `email-service`
  ×1) — so the unopened six are a live risk, not a formality.
- `search_workflows(query:"functions/v1")` returns 0, which proves nothing: that
  filter matches name and description only, never node contents.

---

## 7. Raw SQL to production is routine here

**82 of 323 project functions are named in no migration**, including
`is_quiet_hours`, `share_nudges_pending`, `share_nudge_dismiss`, `presence_beat`,
`presence_day`, `va_daily_tasks`, `voe_prefill`, `copilot_execute_action`,
`my_capabilities`, `storage_orphan_objects` and the whole `vault_*`, `staff_*`
and `hoi_quote_*` families.

**19 of 201 public tables** likewise, including `notification_quiet_hours`.

There were **zero migrations between 2026-08-01 and 2026-08-07**.

This is not drift — `supabase/sql/db-functions/` does contain all 326 production
function objects (320 files plus 6 overload-suffixed ones covering 3 names), and
every file that changed since the 08-05 capture traces to a named commit. But the
migration table is not a record of how this database got its shape, and should
not be read as one.

---

## Method note, because it changed three answers

Three claims in this session were wrong in the same way: a pattern matched text
that *mentioned* a control rather than *performed* one, or a baseline was
compared against itself.

- `changed=0` from `observe-db-functions` was **circular** — the baseline had been
  recaptured from production minutes earlier. It proves the recapture ran.
- A "05→06 unexplained drift" report named the wrong function: the
  `search_path 'public','auth' → 'public'` hunk belongs to
  `tg_app_notifications_chat`, never to `tg_app_notifications_email`. Both were
  changed by commit `537fb8a` at 2026-08-05 17:38, five hours after the 12:46
  capture used as the baseline.
- The unguarded count moved 72 → 70 → 69 → 68 → 65, every step a detector gap.

The rule that would have prevented all three: **compare against the last state
before the change, and open the file before believing the grep.**
