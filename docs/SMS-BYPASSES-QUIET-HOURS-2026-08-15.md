# Seven functions send SMS without going through `sms-service`

**Logged, not fixed.** Raised while planning Step 6, because the task nudge was
about to be given a send path and `loan-date-nudges` is the obvious model to
copy. It should not be copied.

## The rule this breaks

`sms-service` holds `quietHours()` — the TCPA guard added on 2026-08-10, staged
behind `SMS_QUIET_HOURS`, with the eight-value `quiet_hours_bypass` closed set
described in CLAUDE.md. That guard exists in exactly one place.

**A function that calls `https://api.twilio.com/2010-04-01/Accounts/…/Messages.json`
itself never reaches it.** Not "bypasses the flag" — never evaluates the check at
all, so nothing is written to `audit_log` as `SMS_WOULD_BLOCK` either. When
`SMS_QUIET_HOURS` is eventually turned on, these seven keep sending at 2am and
the staging data will not have predicted them.

## The list

Measured 2026-08-15 by grepping every edge function for the Twilio Messages
endpoint and cross-referencing `quietHours` / `quiet_hours_bypass`:

| function | direct Twilio calls | mentions quiet hours | on cron |
|---|---|---|---|
| ~~`proactive-followups`~~ | **0 — ROUTED 2026-08-15** | via sms-service | job 20 daily 15:00Z, job 21 every 6h |
| **`loan-date-nudges`** | 1 | no | **job 38 daily 15:00Z** |
| **`send-scheduled-sms`** | 1 | no | **job 39 EVERY MINUTE** |
| `sms-inbound-reconcile` | 2 | no | job 40 daily 13:20Z |
| `sms-assistant` | 1 | no | — |
| `ocr-mms-upload` | 1 | no | — |
| `twilio-inbound` | 1 | no | — |
| `sms-service` | 1 | **5** | — (the one that does it right) |

`gdrive-health-monitor` references quiet hours and does **not** call Twilio
directly — it goes through `sms-service` with `quiet_hours_bypass:'staff_alert'`.
That is the shape the others should have.

## Not all seven are equal

**The three that matter** are outbound traffic to people who did not just
message us:

- **`proactive-followups`** — job 21 runs **every six hours**, so it fires at
  00:00, 06:00, 12:00 and 18:00 UTC. 00:00Z is 4pm/5pm Pacific, and 06:00Z is
  **10pm/11pm Pacific**. This is the clearest live exposure.
- **`loan-date-nudges`** — job 38, 15:00Z daily (8am PDT), so its *schedule* is
  currently safe. It is on this list because it CAN send at any hour if invoked
  directly, and because it is the function that texted Rene's real phone during
  an unauthenticated probe. That incident is why "do not live-probe" is written
  into every nudge instruction in this project.
- **`send-scheduled-sms`** — job 39 runs **every minute**, and the whole point
  of the feature is sending at a time somebody chose earlier. Nothing stops that
  chosen time being 3am.

**The four that are arguably fine on the merits** are replies and intake, which
would carry `user_initiated` anyway: `sms-inbound-reconcile`, `sms-assistant`,
`twilio-inbound`, `ocr-mms-upload`. They still belong on the list, because
"exempt in spirit" and "exempt by a declared bypass the code can enumerate" are
not the same thing — the closed set exists precisely so nobody has to guess.

## Why this is worse than a missing feature flag

`SMS_QUIET_HOURS` defaults OFF and logs `SMS_WOULD_BLOCK` to `audit_log` so the
decisions it *would* make are visible before it starts making them. That staging
contract is the reason to trust the eventual flip.

**These seven produce no `SMS_WOULD_BLOCK` rows at all.** So the audit trail
being used to decide whether the guard is safe to enable is silent about every
message they send. Flipping the flag on the strength of that data would be
flipping it on a partial picture — and the shortfall reads as "quiet hours would
have blocked almost nothing", which is the reassuring direction.

## What routing them through `sms-service` involves

Each call site swaps its Twilio fetch for an invoke of `sms-service` and must
**declare a bypass reason** from the closed set — `staff_alert`,
`staff_message`, or `user_initiated`. An unrecognised value fails the send, by
design, so this cannot be done by rote:

- `proactive-followups`, `loan-date-nudges`, `send-scheduled-sms` → borrower
  traffic, **no bypass**, subject to the guard.
- `sms-assistant`, `twilio-inbound`, `sms-inbound-reconcile`, `ocr-mms-upload`
  → `user_initiated`, since each is a reply to something the recipient just did.

Per CLAUDE.md's frontend-first rule the ordering matters here too: change the
caller, confirm it still sends, and only then rely on the guard.

## Two things to check before doing any of it

1. **`NUDGE_FROM`.** `loan-date-nudges` sends from its own number, not the 866
   `sms-service` uses — its header comment says the assistant line is
   deliberate. Routing it through `sms-service` may change which number a
   borrower sees, which is a product decision, not a refactor.
2. **`sms_log` shape.** These functions write their own `sms_log` rows with
   their own `trigger_type`. `sms-service` writes its own. Moving a caller
   changes what its history looks like, and the old rows will not match the new
   ones.

## Routing progress

**1 of 7 routed.** Order is by simplicity, agreed 2026-08-15:
`proactive-followups` ✅ → `sms-assistant` → `ocr-mms-upload` → `twilio-inbound` →
`send-scheduled-sms` → `loan-date-nudges` → `sms-inbound-reconcile`.

`SMS_QUIET_HOURS` remains **OFF**. Routing and enabling are separate decisions;
the flag is not flipped until the audit trail covers all seven.

### What routing one function actually required

Three rehearsal defects surfaced, all the same shape — *a test that writes*:

1. `sms-service`'s dry run inserted the `audit_log` `SMS_WOULD_BLOCK` row while
   its own comment claimed it wrote nothing. That table is the evidence the
   `SMS_QUIET_HOURS` flip will be judged on, so a rehearsal inflates the count
   somebody will read as real traffic the guard would have caught.
2. `proactive-followups`' pre-existing `?dry_run=true` returns BEFORE the send
   helper, so it could not exercise the routed path at all. `?dry_run=send` runs
   the real digest through `sms-service`'s dry run instead.
3. The digest rehearsal wrote its `proactive_alerts_sent` row, which would make
   the next REAL run see "already sent digest today" and stay silent — a test
   that suppresses the thing it is testing. Two rows were written this way
   before it was caught, and deleted.

### The guard could not be proven at 4pm, so the clock is injectable

`dry_run_at` and `dry_run_enforce_quiet_hours` are honoured **only inside a dry
run**. At 16:53 Pacific every US area code is inside the 8am–9pm window, so the
refusal branch is untestable for most of the working day — and CLAUDE.md already
records the social failure that follows: somebody runs the suite at the wrong
hour, sees the "wrong" answer, and repairs a working guard into uselessness.

Proven with `+1 714 555 0142`, both directions, nothing sent and nothing written:

| probe | simulated local time | bypass | verdict |
|---|---|---|---|
| borrower-facing | 2:00 AM | none | **blocked** — "Texts are limited to 8:00 AM–9:00 PM" |
| staff alert | 2:00 AM | `staff_alert` | **through** |
| borrower-facing | 2:00 PM | none | **through** |

The middle row is the one that matters for this function: `proactive-followups`
alerts Rene, not a borrower, and must still reach him at 2am — muting a monitor
overnight is how the 32-hour masking window happened.

Nothing else here is fixed. Nothing else here is scheduled.
