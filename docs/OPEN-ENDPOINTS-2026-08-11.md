# Open edge functions — the whole set, 2026-08-11

**Read-only sweep. Nothing here was changed** except `extract-conditions`, which
was closed first (commit `b1e2b7f`) and is no longer in the list.

The question was whether `extract-conditions` was the last one in that shape.
**It was not. There are 59 more.**

## Criterion

LIVE `verify_jwt = false` **AND** no in-function check of any kind. Live values
read from the deployed function list, not `config.toml` — 41 of the 59 are not
pinned at all, so the file would have told me nothing.

`verify_jwt = true` was not treated as safety: the anon key is a project-signed
JWT printed in every page's source. As it happens the distinction is moot here —
**zero** functions have no in-function check while pinned true.

## The set

| | count |
|---|---|
| deployed functions | 130 |
| no in-function auth the detector recognises | 65 |
| …of those, LIVE `verify_jwt = false` | 63 |
| …minus hand-verified false positives | **59 open** |
| can SEND (SMS / email) | ~~11~~ **9** — see the correction below |
| spend AI credits per call | 16 |
| write borrower data with the service role | 48 |

### Can send — leaves the system under the business identity

| function | can do |
|---|---|
| `bot-process-queue` | SENDS-SMS,SERVICE-ROLE,WRITES-DB |
| `campaign-send-now` | SENDS-SMS,SENDS-EMAIL,SERVICE-ROLE,WRITES-DB |
| `contact-intelligence` | SENDS-SMS,SPENDS-AI,SERVICE-ROLE,WRITES-DB |
| `listing-alert-actions` | SENDS-EMAIL,SERVICE-ROLE,WRITES-DB |
| `loan-date-nudges` | SENDS-SMS,SERVICE-ROLE |
| `send-scheduled-emails` | SENDS-EMAIL,SERVICE-ROLE |
| `send-scheduled-sms` | SENDS-SMS,SERVICE-ROLE |
| `tours-admin` | SENDS-SMS,SERVICE-ROLE,WRITES-DB |
| `tours-send-reminders` | SENDS-SMS,SERVICE-ROLE,WRITES-DB |

#### CORRECTION 2026-08-11 — two of these were never senders

`lead-scorer` and `sms-inbound-reconcile` were listed above as SENDS-SMS. They
are not. Verified against source, not inferred:

| function | actual Twilio capability |
|---|---|
| `lead-scorer` | **none.** Zero references to Twilio, `sms-service`, `email-service` or any send helper anywhere in the file. It READS `sms_log` to compute an engagement score. |
| `sms-inbound-reconcile` | **read-only.** One Twilio call, a `GET` of `Messages.json` to list what arrived. Every write is a DB write. |

The tag appears to come from a table-name heuristic — both touch `sms_log` —
which is not the same question as whether a function can put a message on the
wire.

**This mattered because the tag set the priority order.** These two were worked
as senders 3–4 of 7, ahead of functions that genuinely can send. Both still
deserved their guards — `sms-inbound-reconcile` writes `sms_suppressions`, and a
recorded opt-out is a compliance record — but on the strength of what they
WRITE, not what they send. Re-derive the ordering from capability before using
this list to schedule work again.

Send count corrected from 11 to **9**.

### Spends AI credits on every call (no send capability)

| function | can do |
|---|---|
| `ai-chat` | SPENDS-AI |
| `campaign-ai-generate` | SPENDS-AI,SERVICE-ROLE,WRITES-DB |
| `canva-generate` | SPENDS-AI |
| `chat-ai` | SPENDS-AI,SERVICE-ROLE,WRITES-DB |
| `chunk-guidelines` | SPENDS-AI,SERVICE-ROLE,WRITES-DB |
| `chunk-guidelines-large` | SPENDS-AI,SERVICE-ROLE,WRITES-DB,STORAGE |
| `claude-ai` | SPENDS-AI |
| `commercial-ai` | SPENDS-AI,SERVICE-ROLE,WRITES-DB |
| `extract-lead-from-image` | SPENDS-AI |
| `guideline-ai` | SPENDS-AI,SERVICE-ROLE |
| `guidelines-ai` | SPENDS-AI,SERVICE-ROLE,WRITES-DB |
| `guidelines-library` | SPENDS-AI,SERVICE-ROLE,WRITES-DB |
| `scan-doc-to-1003` | SPENDS-AI |
| `sms-draft-assist` | SPENDS-AI,SERVICE-ROLE |
| `video-chat` | SPENDS-AI,SERVICE-ROLE,WRITES-DB |

### Writes borrower data with the service role (no send, no AI spend)

| function | can do |
|---|---|
| `automation-config` | SERVICE-ROLE,WRITES-DB |
| `bot-admin` | SERVICE-ROLE,WRITES-DB |
| `campaign-audience-resolve` | SERVICE-ROLE,WRITES-DB |
| `clickup-auto-create` | SERVICE-ROLE,WRITES-DB |
| `clickup-bridge` | SERVICE-ROLE,WRITES-DB |
| `clickup-lender-sync` | SERVICE-ROLE,WRITES-DB |
| `clickup-setup` | SERVICE-ROLE,WRITES-DB |
| `clickup-sync` | SERVICE-ROLE,WRITES-DB |
| `commercial-intake` | SERVICE-ROLE,WRITES-DB,STORAGE |
| `commercial-match` | SERVICE-ROLE,WRITES-DB |
| `emc-lender-import` | SERVICE-ROLE,WRITES-DB |
| `generate-preapproval` | SERVICE-ROLE |
| `lender-guidelines` | SERVICE-ROLE,WRITES-DB,STORAGE |
| `listing-alert-matcher` | SERVICE-ROLE,WRITES-DB |
| `mortgage-calc` | SERVICE-ROLE |
| `news-feed` | SERVICE-ROLE,WRITES-DB |
| `newsletter-signup` | SERVICE-ROLE,WRITES-DB |
| `portal-data` | SERVICE-ROLE,WRITES-DB,STORAGE |
| `portal-profile` | SERVICE-ROLE,WRITES-DB |
| `send-push` | SERVICE-ROLE,WRITES-DB |
| `short-link` | SERVICE-ROLE,WRITES-DB |
| `submit-showing` | SERVICE-ROLE,WRITES-DB |
| `track-event` | SERVICE-ROLE,WRITES-DB |
| `treasury-yields` | SERVICE-ROLE,WRITES-DB |
| `upload-guideline` | SERVICE-ROLE,WRITES-DB,STORAGE |
| `weekly-backup` | SERVICE-ROLE,WRITES-DB,DRIVE |
| `borrower-drive` | SERVICE-ROLE,WRITES-DB,DRIVE |

### Everything else

- `canva-proxy`
- `clickup-mention-ping`
- `convert-to-pdf`
- `generate-1003`
- `generate-fee-sheet`
- `generate-heloc-sheet`

---

## What I verified BY HAND, and what the tools alone would have got wrong

`tools/audit-function-guards.mjs` tests whether a check **exists in a file**. It
has never tested **which paths that check governs** — the `twilio-voice` lesson.
So the tool output was a starting list, not the answer.

I re-grepped all 63 for every credential convention the detector is documented as
missing (`x-cron-key`, `share_token`, `form_token`, signature checks, service-key
compares). Seven matched. **Hand-read all seven — and four of the seven matches
were text, not controls:**

| function | verdict | what I read |
|---|---|---|
| `refi-watch` | **guarded** | `x-cron-key` compared at line 47, before any work |
| `critical-date-reminders` | **guarded** | same, line 17 |
| `post-close-followups` | **guarded** | same, line 18 |
| `tour-public-view` | **guarded** | takes `share_token` from the body, looks up `showing_batches` by it, 400 without. A row-held token, same shape as `lender-portal.form_token`. Correct for a borrower-facing page — the token IS the credential |
| `tours-admin` | **OPEN** | `share_token` only ever appears as DATA it emits into a public URL. No check. And it sends SMS |
| `tours-send-reminders` | **OPEN** | same — `share_token` is payload, not credential. Sends SMS |
| `borrower-drive` | **OPEN** | plain `action` dispatch, no check. The `===` my grep matched was string comparison in a config lookup |

**So the automated pass produced four false reassurances in seven.** Pattern
presence is not governance, in both directions — that is the whole point of the
detector caveat, and it applied to my own sweep as hard as to the tool.

### Verified live, by request

Nine send-capable entries were probed with an unauthenticated POST. Every one
reached application code:

```
campaign-send-now       400  {"error":"campaign_id required"}
contact-intelligence    400  {"error":"contact_id required"}
lead-scorer             400  {"error":"Unknown action: …"}
listing-alert-actions   400  {"error":"Unknown action: …"}
send-scheduled-sms      200  {"ok":true,"dry_run":false,"due":0,"sent":0,…}
send-scheduled-emails   200  {"message":"No scheduled emails due","sent":0}
bot-process-queue       200  {"message":"No queued replies due","processed":0}
sms-inbound-reconcile   200  ran a 7-day reconcile, dry_run:false
loan-date-nudges        200  dry_run:false, item_count:5, and it DISCLOSED
                             the business Twilio number and Rene's cell
```

A 400 naming a missing parameter is not a refusal — it is the handler answering.
The five 200s did not merely answer, they **ran their whole job** for an
anonymous caller.

### The probe sent a real SMS, and that is my error

`loan-date-nudges` ignores the `action` field entirely and just runs. I chose a
nonexistent action believing that made the probe inert; it does not, for
cron-shaped functions with no dispatch. **It sent a live text to Rene's cell**
(`+17144728508`, "R&R loan alerts (5): OVERDUE: — Ezequiel Palacios…") at
06:00:12Z.

Confirmed mine rather than the schedule: pg_cron job 38 `loan-date-nudges-daily`
is `0 15 * * *` and last ran 2026-08-10 15:00Z.

This is the failure the probes rule exists for, and it happened while auditing.
Live probing of send-capable functions stopped at that point; the rest of the
sweep is static. **A safe probe of a send-capable endpoint is one that does not
reach it at all.**

It also demonstrates the severity better than the list does: an unauthenticated
request from the open internet made Rene's phone ring.

## The cron key is a hardcoded literal, shared

`refi-watch`, `critical-date-reminders` and `post-close-followups` are genuinely
guarded — by `const CRON_KEY = "rnr-cron-9b1f7a3e8c2d460a85f4e6172c0d9b3e"`,
written into the source of all three rather than read from the environment. It is
in the repo, in git history, and one value covers three functions. Rotating it
means editing and redeploying three functions. Worth moving to a secret before
counting these as closed.

## Order to work in

Blast radius, not alphabet:

1. **The 11 senders.** `campaign-send-now` and `send-scheduled-sms` are the worst
   — SMS from the business line to borrower numbers, which is the TCPA surface
   the quiet-hours work exists to protect.
2. **`weekly-backup`** — service role plus Drive, and it holds rene@'s user
   token.
3. **`portal-data` / `portal-profile`** — borrower-facing, service role, storage.
4. The 16 AI-spend ones — money, not data.
5. The rest.

Each needs the same frontend-first order `extract-conditions` just used, and each
needs its callers audited first: several of these are called by pg_cron, which
cannot hold a session and needs `internal_call_headers()` or a cron key.

**Nothing in this list is fixed. The count is 59.**
