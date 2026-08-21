# Handoff — dialer, DTMF and the recording gap, 2026-08-21

Stopped mid-thread. Items 1–3 all landed and are deployed. Four things are open,
listed in the order I would take them.

---

## Landed

### 1. `bridgeCall()` removed from the power dialer — it never worked

**`bridge_call` was never implemented.** `git log --all -S "bridge_call"` finds
the name in exactly one commit that touches code: **`e4c0b52`, 2026-06-19,
"power dialer: click-to-call via the user's own phone (bridge_call) so calling
works without the browser Voice SDK"** — which modified `admin/power-dialer.html`
and **no other file**, 48 insertions. The caller shipped without a server side.
`twilio-voice` implements `backfill_call_status, call_status, dial_precheck,
find_by_phone, get_recording, get_token, log_call, make_call, voicemail_drop`,
and anything else hits `err('Unknown action: ' + action)`.

Combined with the SDK 403 below, **the Call button on that page has not worked in
EITHER mode since 2026-06-19.**

Removed rather than written, because `click-to-call` already IS that bridge —
rings a cell, dials the lead, records, guarded by `requireStaff` since `757032f`.
A second one is the two-systems shape that cost repeatedly this session.

**The not-ready state is now loud.** With no fallback, `!_voiceReady` disables the
Call button and says why. The bridge progress bar went with it: `startBridgeBar()`
had no caller left, and code that looks live is the recurring cost here.

**Also fixed, same day:** `admin/power-dialer.html` loaded the Voice SDK from
`sdk.twilio.com/js/voice/releases/2.11.0/twilio.min.js`, which **returns 403
AccessDenied for every version** — 2.10.0, 2.11.0, 2.11.3 and 2.12.0 all checked.
So `typeof Twilio === 'undefined'`, `_voiceReady = false`, and every Call button
silently took the dead fallback. Repointed at the jsdelivr build the dialer modal
and lead-detail already use. Git can date the URL (unchanged since 2026-06-19)
but **not** the 403 — that is Twilio-side, and log retention is 24 hours.

### 2. `ContactId` travels with the dial

`twilio-voice` reads `params.get('ContactId')` and prefers it over
`resolveContactByPhone(dialTo)`, but `admin/js/dialer.js` never sent it — so a
call whose owner the page already knew was filed by re-deriving the contact from
the phone number. That lookup returns nothing for an unknown number and **refuses
an ambiguous one**, which is why calls to Rene's own cell (two contacts carry it)
landed untagged. The phone lookup stays as the fallback for an ad-hoc pad call,
which is what it was written for.

**Most untagged calls were correct**, which the raw "1 of 12" framing hides. Of 15
untagged outbound rows: the majority are vendor 800-numbers (`+18005977977`,
`+18887162510`, `+18003389249`, `+18668772023`) — the IVRs the keypad work exists
for, and not leads; one is `blocked_calling_hours`, never placed; two are Rene's
own cell. Two are a genuine defect — see OPEN #1.

### 3. `sweep_stale_recording_requests()` — pg_cron job **53**, every 15 min

`twilio-voice` downgrades `requested → unavailable` when Twilio posts
`RecordingStatus` failed/absent. That fires **on a webhook arriving**; if Twilio
never posts, nothing revisits the row, and *an absence cannot trigger a handler.*
Same shape and same fix as pg_cron job 43 for `transcript_status`.

**The threshold must not downgrade a live call.** A recording URL only exists once
the call ends, so a 40-minute conversation legitimately has none for 40 minutes:

```
terminal status  ->  15 min after created_at + duration
anything else    ->  4 hours after created_at
```

Proven in a rolled-back transaction: 2 real stale rows downgraded, a synthetic
40-minute in-progress call untouched, a call that ended 3 minutes ago untouched.
A flat 15-minute rule would have marked long, successfully recorded calls
`unavailable` mid-conversation.

Ran once for real. `calls_log` now reads **11 recorded / 2 unavailable / 21 from
before the disposition column existed**.

### And the DTMF keypad it all started from

`admin/js/dtmf-pad.js`, mounted on the dialer modal (lead-detail) and the power
dialer. Both hosts pass a **getter**, so the connection is read at press time and
a pad left open across a hangup cannot send into a dead call.

**`tools/dtmf-probe.mjs` — re-runnable, and the real proof.**

```
node tools/dtmf-probe.mjs        # default 142#

  pressed      : 142#
  Twilio heard : 142#
```

It mints a voice token for the automation account, opens headless Chromium with a
**fake microphone**, and connects a real Twilio call to the sentinel
**`To=dtmf-probe`**, which `twilio-voice` answers with **`<Gather>` instead of
`<Dial>`**. So there is **no PSTN leg, no ringing handset, no `calls_log` row and
no contact association** — it can run unattended, repeatedly. It drives the
*shipped* component, not a copy, and reads back what Twilio reports hearing from
`dtmf_probe_log`.

**Broken on purpose:** neutering `sendDigits` to a no-op left the pad rendering
all twelve keys and still logging `result:'sent'` for every press, and the probe
reported `(nothing arrived)`. That is exactly the failure mode this was asked to
rule out — it looks identical to one that works from every signal in the browser.

Two things went wrong building it, both worth knowing: the first run died with
`ConnectionError 31005 HANGUP`, which reads like a network or credential fault and
was **a raw `&` in the action URL making the TwiML invalid XML**; and the
`<Gather>` could never complete because the probe hung up the instant the last key
landed. The function log had already printed `DTMF PROBE leg`, which is what
showed the branch was running and only the response was bad.

The drift guard also refused a deploy, correctly — the probe branch was deployed
before it was committed, so production briefly held source with no committed
revision. Captured, committed, then the fix landed as a visible diff.

---

## Open, in the order I would take them

### 1. Two completed calls to `+28`

`calls_log`, 2026-08-10, **two `completed` outbound rows with `to_phone = '+28'`**
— a two-digit destination that still placed a call. Both untagged, neither
recorded.

It cannot come from `formatPhone()`: that returns early on a leading `+`, so the
**browser sent `To="+28"` verbatim**. The origin is upstream of the edge function
— `pdDialCheck` / `dial_precheck` / the pad input. **Not traced.** Start at what
produced `chk.e164`.

### 2. `click-to-call` writes to `call_log`, not `calls_log`

Both tables exist: **`call_log` has 5 rows, `calls_log` has 34, and none of the 5
appear in `calls_log`.** Two are `Click-to-call placed` from **2026-08-06 and
08-07, still stuck at `status='initiated'`** — the status callback never finalised
them.

Those calls are invisible to the lead timeline, the recording checks and every
sweep. This is the same two-systems shape as the signature work; `calls_log` is
the one everything else reads.

### 3. `click-to-call` hardcodes `RENE_CELL` — it cannot serve Aubrey

`const RENE_CELL = Deno.env.get('RENE_CELL') || '+17144728508'`, and the call
always rings that number. The power dialer prompted for a per-user agent phone, so
the VA could bridge to *her* handset; `click-to-call` cannot. **This is why the
fallback was deleted rather than repointed at it** — swapping it in would have
rung Rene when Aubrey clicked Call.

If the VA ever needs bridged calling, this is the blocker, and the fix is a
per-user phone rather than an env var.

### 4. Design note: the dialer should not have needed a phone lookup

Item 2 above is fixed, but the underlying shape is worth recording.
`openCallModal(name, phone, contactId)` has always received the contact id and
threw it away, leaving the server to re-derive the association from a phone
number — a lookup that is ambiguous by nature (two contacts share Rene's cell) and
empty for any number not on file. **When the caller knows the identity, send the
identity.** The lookup is a fallback for the ad-hoc pad, not a primary path.

---

## Not attempted

The 21 `calls_log` rows with a null `recording_disposition` are from before that
column existed and are left alone. Backfilling them would manufacture a
disposition nobody recorded — the same reasoning as the un-backfilled
`recording_consent_at`.
