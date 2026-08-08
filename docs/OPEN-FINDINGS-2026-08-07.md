# Open findings — 2026-08-07

Written so these survive the session. Each entry says what is true, how it was
established, and what would close it.

**Update 2026-08-08:** §1 (`delete-contacts`) and the `twilio-voice` half of §8
are now **CLOSED** — guards landed, re-verified against the deployed functions,
and §3's count re-derived from a fresh tool run. Closed entries are marked in
place and keep their original reasoning; everything unmarked is still open.

Two of these were found only because a claim was challenged rather than accepted.
That is worth saying at the top: the counts in this file have been wrong three
times, and each correction came from opening a file rather than trusting a
pattern.

---

## 1. `delete-contacts` — ~~open~~ **CLOSED 2026-08-07**

**State: GUARDED AND AUDITED. Verified against the deployed function 2026-08-08.**

`requireStaff(req, { roles: ['admin'] })` runs **before `req.json()`** — deliberately,
per require-staff's own note 2: a check placed after body parsing is one a later
action can be written in front of by accident. Admin-only rather than the default
staff list, because the VA login is shared and rotating and a contact delete
cascades a borrower's whole tree.

An `audit_log` row is now written **before** the delete, and if that write fails
the contact is **not** deleted (`reason: 'audit_failed'`). That ordering is the
only one where "audited" and "deleted" cannot come apart — a post-hoc audit that
fails leaves a destroyed record with no trace, which is the gap that made the
seven April–May deletions unanswerable.

Re-verified against the DEPLOYED function, not the repo:

```
no credential:  {"success":false,"error":"missing authorization"}   HTTP 401
anon key (208): {"success":false,"error":"invalid session"}         HTTP 401
```

The second is the one that matters: the anon key is a project-signed JWT, so it
satisfies a gateway. `requireStaff` calls `getUser()` on it, gets no user, and
rejects — the distinction `verify_jwt` cannot make.

`verify_jwt` stays pinned `false`, correctly: the pin is a stability control, not
an access one, and flipping it would add nothing this check does not already do.

**Still open from this finding:** `listing-alert-actions` continues to return a
resolved `contact_id` to an unauthenticated caller. The delete path it fed is now
shut, but handing out a borrower's uuid for an email address is worth closing on
its own.

The original finding is preserved below for the reasoning, which still explains
why the audit row exists.

---

### Original entry (2026-08-07), retained for context

**State at the time: FRONTEND HALF DONE, GUARD NOT WRITTEN.**

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

## 3. Functions with no in-function authorization: **64**

**Corrected five times. Do not quote an older number.** Was 66; two functions
were guarded on 2026-08-07 and the figure was re-derived on 2026-08-08 from a
fresh tool run, not by editing the old arithmetic.

```
audit-function-guards 'no auth' rows                       69
minus _shared (a library, not a function)                  -1
minus tour-public-view (share_token capability gate)       -1
minus refi-watch, critical-date-reminders,
      post-close-followups (x-cron-key compare)            -3
= 64
```

The tool scans 129 directory entries — the 128 deployed functions plus `_shared`.

**What moved, and why the two changes are not symmetrical:**

- The raw count fell **70 → 69** because `delete-contacts` gained a guard and the
  detector now recognises it (`require* helper`). One function, one row.
- The `+1` for `twilio-voice` is **gone**, but it never was a raw-count row.
  `twilio-voice` always read as guarded to the tool; the `+1` was a manual
  correction added by hand because the check it found only covered the
  form-encoded webhook half, leaving five JSON admin actions open. Those are now
  behind `requireStaff` too, so the manual correction is retired rather than
  recalculated.

Verified against the DEPLOYED functions on 2026-08-08, all five JSON actions,
both credentials:

```
get_token / make_call / voicemail_drop / call_status / log_call
  no credential:  {"error":"missing authorization"}   HTTP 401
  anon key (208): {"error":"invalid session"}         HTTP 401
```

And the webhook half still answers on its **signature**, not the guard — an
unsigned form-encoded POST returns **403**, and `?action=record_notice`, which
Twilio fetches with no JWT, still returns **200**. If the guard had leaked into
the Twilio path those would have been 401 and 401.

`identity` is now `'u_' + actorUid` derived from the verified caller
(`twilio-voice/index.ts:726`), not the hardcoded `'rene_duarte'`. That is a
source reading on a drift-clean function, not a runtime proof — minting a token
requires a real session, which the negative tests deliberately do not have.

**64 remains a LOWER BOUND on the problem, and the reason is unchanged.** The
detector tests whether a check EXISTS in a file. It has never tested **which code
paths that check governs**. `twilio-voice` was the proof: the control was there,
the tool found it, and the function was still half-open for months. Nothing in
`tools/audit-function-guards.mjs` tests reachability, so any function serving two
caller shapes from one entry point can still read as fully guarded while being
open on one of them. Assume the real figure is higher than 64 until a
reachability check exists.

Every correction was a **detector gap**, not a code change:

| missed pattern | functions | why the detector missed it |
|---|---|---|
| `share_token` row token | `tour-public-view` | it only knew `form_token` |
| `x-cron-key` compare | `refi-watch`, `critical-date-reminders`, `post-close-followups` | it knew `x-cron-secret` and `x-internal-secret`, not this third name |

`tools/audit-function-guards.mjs` still does not recognise either pattern. **The
64 is an upper bound on unguarded, not a proven floor** — a fourth convention
could still be hiding, exactly as the third was. And `twilio-voice` showed a
second, worse way to be wrong: a pattern the detector DOES recognise, governing
only part of the function.

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

## 8. SMS delivery is not recorded anywhere — and the "18%" figure was invented

**CORRECTION FIRST.** Toll-free verification on **+18668919394 has been APPROVED
since 2023-12-05**, confirmed in the Twilio console's Regulatory Information tab.
Approved toll-free numbers have no sending caps.

Any claim that verification was never started, or that ~18% of outbound SMS fails
because of it, is **FALSE**. The 18% figure has no source: it appears in no
document, no code comment, no commit message and no commit diff in this repo's
entire history (`git log --all -S"18%"` returns nothing relevant). It was
asserted in conversation and never had a basis. Do not carry it forward.

One written trace of the same false premise survived in code — a comment in
`supabase/functions/gdrive-health-monitor/index.ts` (commit `7f1abef`) referring
to "the toll-free deliverability problem" as established fact while arguing for
shorter alert bodies. **Amended 2026-08-07.** The segment-reduction change it
justifies is still correct on its own merits — one emoji really does force
GSM-7 to UCS-2 and cut a segment from 153 characters to 67, which is a real
cost and a real truncation risk — so the change stands and only the stated
reason was replaced.

**What is actually true is worse, and is a visibility gap rather than a
delivery problem:**

`sms_log` holds 413 `sent`, 2 `blocked` (both genuine opt-outs, working as
intended), 19 `received`, and **zero** `failed`, since 2026-04-02. That looks
like a flawless channel. It is not evidence of one.

`sms-service`'s `sendTwilioSMS()` posts exactly three parameters:

```ts
const params: Record<string,string> = {To:formatPhone(to),From:(fromOverride||'').trim()||TWILIO_FROM,Body:body};
if (mediaUrl) params.MediaUrl = mediaUrl;
```

**There is no `StatusCallback`.** `status` is written once, at insert, from
`result.sent` — which is true whenever the Twilio *API* returned a SID. That is
"Twilio accepted it for sending", not "it arrived". A message accepted and then
rejected by the carrier, or silently dropped, is recorded as `sent` forever.

Nothing anywhere consumes Twilio message-status webhooks. `StatusCallback` /
`MessageStatus` appear nowhere in any edge function except the **voice** paths
(`twilio-voice`, `click-to-call`). `twilio-inbound` handles only inbound bodies
(`From`, `Body`), writing `status: 'received'`.

So the honest statement is: **we have no delivery data at all, and never have.**
The zero-failure record is the absence of a sensor, not a clean signal.

**Smallest change that would fix it** (not built):

1. `sms-service` → `sendTwilioSMS()`: add one parameter,
   `params.StatusCallback = '<SUPABASE_URL>/functions/v1/twilio-inbound'`.
2. `twilio-inbound`: branch when the form body carries `MessageStatus`, and
   `update sms_log set status = <MessageStatus>, error_message = <ErrorCode>
   where twilio_sid = <MessageSid>`.

No schema change is needed — `sms_log.status` and `sms_log.twilio_sid` both
already exist and the SID is already stored on every send. `twilio-inbound` is
already pinned `verify_jwt = false`, so Twilio can reach it.

**CORRECTION 2026-08-07 — `twilio-inbound` IS signature-validated.** An earlier
version of this section said it was not. That was wrong, and wrong in a way
worth naming: the result is assigned to `const _sig`, and the leading underscore
reads as "deliberately unused". It is used, on the very next line:

```ts
    const _sig = await verifyTwilioRequest(req, rawText, { authToken: Deno.env.get("TWILIO_AUTH_TOKEN") || "", testKey: Deno.env.get("SMS_TEST_KEY") || "" });
    if (!_sig.ok) {
      console.error("[twilio-inbound] REJECTED:", _sig.reason, "url=", _sig.url);
      return twilioForbidden();
    }
```

The same reverse check was run across every other function guarded on a Twilio
signature. **None is a fail-open** — all three branch on the result and return
`twilioForbidden()`:

| function | line | assigned to | branched on? |
|---|---|---|---|
| `twilio-inbound` | 139–142 | `const _sig` | yes |
| `twilio-voice` | 114–118 | `const _sig` | yes, but only when `_isTwilioShape` |
| `sms-assistant` | 1104–1108 | `const auth` | yes |

`twilio-voice` is the one worth understanding rather than filing as fine. Its
check is inside `if (_isTwilioShape)` — form-urlencoded bodies or
`play_voicemail`. That is deliberate and documented: the same function also
serves the browser's JSON admin actions (`get_token`, `make_call`,
`voicemail_drop`, `call_status`, `log_call`), which carry no Twilio signature
and would break if validated. So signature validation is not the gap there —
~~the gap is that those JSON actions have no authorization of their own at all~~.

**CLOSED 2026-08-08.** All five JSON actions now run `requireStaff` **before
`req.json()`**, and the `+1` this contributed to §3 is retired. The split
structure is unchanged and still correct: the Twilio half authenticates on the
**signature**, the browser half on the **session**, and neither check is applied
to the other's callers. Proven on the deployed function — an unsigned
form-encoded POST still gets **403** (signature, not the guard) and
`?action=record_notice`, which Twilio fetches with no JWT at all, still gets
**200**.

The sharpest edge was `get_token`. It mints a **Twilio Voice capability JWT**
with `voice.outgoing.application_sid` set, valid **3600 seconds**, signed with
`TWILIO_API_SECRET`. It used to take no parameters and perform no check, so
anyone who could POST to the URL got one. Its holder was never limited to
bridging a queued call: `Twilio.Device.connect()` with that token hits the TwiML
app, which routes back to this same function's form-encoded branch and returns
`<Dial callerId="+18668919394"><Number>{To}</Number></Dial>` for **whatever `To`
the caller supplies**. That was arbitrary outbound dialling from the business
line, on the account's billing, for an hour per token, with the call logged as
if staff placed it.

Two things changed. Minting now requires a staff session:

```
no credential:  {"error":"missing authorization"}   HTTP 401
anon key (208): {"error":"invalid session"}         HTTP 401
```

And `identity` is now `'u_' + actorUid` derived from that verified session
(`twilio-voice/index.ts:726`), not the hardcoded `'rene_duarte'` every caller
previously shared. That is the more durable half: with one identity for
everybody, a token could not be attributed, revoked, or rate-limited per person
even after a guard was added, and every call placed with one looked like the same
staff member. `grep -c rene_duarte` is now 1, in an explanatory comment.

**Still unfixed:** there is no rate limit on minting and none on placing. A
staff session can still mint unlimited hour-long tokens, and a leaked one is
valid for its full hour with no revocation path. The guard narrows who can
start this, not what a token can do once it exists.

Rename `_sig` to `sig` in both files at some point. The convention says
"unused" about the only line that makes these endpoints safe.

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
- The unguarded count moved 72 → 70 → 69 → 68 → 65 → 66, every step a detector
  gap. The last step was the only one that moved it **up**, and it was a
  different gap: the detector found a real control and could not ask which code
  paths it governed.

The rule that would have prevented all three: **compare against the last state
before the change, and open the file before believing the grep.**

**Addendum 2026-08-08.** The figure is now **64**, and this step was not a
detector gap at all — two functions were actually guarded. Worth keeping the
distinction visible, because "the number went down" has meant two different
things in this file: *we mis-measured* (every step above) and *we fixed
something* (this one). Only the second is progress.
