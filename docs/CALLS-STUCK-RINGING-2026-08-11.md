# Calls stuck at `ringing` — 7 of 17 in 30 days

> **RESOLVED 2026-08-11, except the live break test.** The outbound `<Dial>` now
> carries `action=` and a per-leg `statusCallback=`; `leg_status` resolves
> `ParentCallSid` before `CallSid`. All 8 non-terminal rows (the 7 plus one
> `initiated`) were backfilled from Twilio's own call records — 7 → `completed`,
> 1 → `no-answer` — and `calls_log` now holds **zero** rows at `ringing` in 30
> days. §3, the masked-number dial, was fixed separately at the source.
>
> **STILL OUTSTANDING: the deliberate break.** Placing a call that rings
> unanswered needs a browser holding a Twilio Device, which this session has no
> way to drive; `make_call` sits behind the blanket staff guard and opening it
> to an internal caller would put a call-placing action behind a database
> secret, which is exactly the widening that guard exists to prevent. So the
> callbacks are deployed and unproven-in-anger. What to do, and what to expect:
>
> 1. Dial **+1 714 555 0142** from the lead-detail dialer or the FAB pad. That
>    exchange is NANPA-reserved for fictional use in every area code, and 714
>    maps to `America/Los_Angeles` so the calling-hours guard behaves normally
>    rather than taking the unknown-area-code branch.
> 2. Let it ring out. Do not answer.
> 3. `select status, duration from calls_log order by created_at desc limit 1;`
>
> **Pass:** a terminal status — `no-answer`, `busy`, `failed` or `completed`.
> **Fail:** still `ringing`, which would mean the callback is not arriving and
> the row is once again waiting for something that never comes.


Read-only investigation, 2026-08-11. Nothing here is fixed. Two separate
defects, plus a third found on the way that is worse than either.

`ringing` is written at dial time and something else is supposed to move it.
For 7 of the last 17 calls, nothing did.

| row | dir | to | client_ref | recording | why it is stuck |
|---|---|---|---|---|---|
| `e4f03760` | out | +17144728508 | yes | no | no status callback exists |
| `df1a7358` | out | **+28** | yes | no | no status callback exists |
| `7469a802` | out | **+28** | yes | no | no status callback exists |
| `420436f6` | out | +17149254342 | yes | no | no status callback exists |
| `e2b63395` | out | +17149254342 | yes | no | no status callback exists |
| `b8c5285b` | in | +18668919394 | — | no | parent/child SID mismatch |
| `2f9e67a8` | in | +18668919394 | — | **yes** | parent/child SID mismatch |

## 1. The browser leg gets NO status callback at all

Asked directly: **no.** Compare the two TwiML branches in `twilio-voice`.

Inbound has both closers:

```xml
<Dial timeout="18" … action="{statusCb}?phase=inbound_done" method="POST">
  <Number … statusCallback="{statusCb}?phase=leg_status"
           statusCallbackEvent="completed" statusCallbackMethod="POST">
```

Outbound has neither:

```xml
<Dial callerId="…" timeout="30" answerOnBridge="true" ringTone="us"
      record="record-from-answer-dual" recordingStatusCallback="{recordingCb}">
  <Number url="…">{dialTo}</Number>
</Dial>
```

`recordingStatusCallback` is a RECORDING callback and says nothing about call
status. There is no `action=` and no per-leg `statusCallback=`, so `leg_status`
and `inbound_done` are never reached from the browser dialer. The row is
INSERTed `ringing` and no code path can ever update it.

**So the SID mismatch is REFUTED for these five.** There is no callback to
mis-match — the phase handlers are simply unreachable. Five of the seven are
explained by absence, not by a lookup bug.

## 2. The SID mismatch — CONFIRMED, for the two inbound rows

Inbound rows are INSERTed with `twilio_call_sid = <PARENT CallSid>` — the
inbound call from the borrower.

- **`inbound_done`** is the `<Dial action>`. It fires on the PARENT, so its
  `CallSid` matches the row. This is what closes a normal inbound call.
- **`leg_status`** comes from `<Number statusCallback>`, which is a **child-leg**
  callback. Its `CallSid` is the SID of the leg dialled out to `forwardTo` —
  a different SID. The handler does:

  ```ts
  .select('id, status').eq('twilio_call_sid', callSid).maybeSingle()
  ```

  which matches **nothing**. `ParentCallSid` is in that callback payload and is
  not read.

The comment above `leg_status` states its purpose exactly:

> A caller who hangs up WHILE RINGING never triggers the Dial action URL —
> Twilio stops processing TwiML when the calling party is gone. Without this the
> row would sit at 'ringing' forever

That is precisely what happened. `inbound_done` could not fire (caller gone),
and the backstop that exists for that case cannot match the row it is meant to
close. **The documented safety net has never worked.**

### `2f9e67a8` is the proof, and it is unusually clean

That row has a RECORDING and is still `ringing` with `duration` null. Both
callbacks are attached to the same `<Dial>`, so the recording arriving while the
status did not is not a delivery problem — it is a lookup problem:

- the **recording** callback is Dial-level and fires on the **parent**, so
  `.eq('twilio_call_sid', callSid)` matched and `recording_url` was written;
- the **status** callback is `<Number>`-level and fires on the **child**, so the
  same lookup found no row.

One row, two callbacks, one matched. That is the mismatch isolated by
observation rather than argued from the docs.

### The fix, not applied

`leg_status` should resolve `ParentCallSid || CallSid`. The outbound branch needs
an `action=` and/or a `<Number statusCallback>` before any of its rows can ever
close. There is also a number-level StatusCallback configurable in the Twilio
console, referenced in the deploy checklist — worth checking whether it is set,
because it would be a third closer and evidently is not firing either.

## 3. `+28` — the dialer is dialling a MASKED phone number

This is the one to act on first. It is not a truncation.

`mask_phone()` keeps the last two digits:

```
mask_phone('7149254342') → '(•••) •••-••42'
```

`dialer.js` then does:

```js
function toE164(p) {
  var d = (p || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return '+' + d;                      // ← everything else, unchecked
}
```

`'(•••) •••-••28'` → digits `28` → `'+28'`. Six live contacts currently mask to
`(•••) •••-••28`, so the number is a masked one, not a mistyped one.

`contacts_secure` hands a **va** `mask_phone(phone)`. So a VA pressing Call
dials the mask. The call cannot connect, nothing tells her why, and — because of
§1 — the row sits at `ringing` for ever with no error anywhere. The masking is
working exactly as designed; the dialer is treating a redaction as a phone
number.

Two rows 25 ms apart with **different** `client_ref` values means `startCall()`
ran twice, not that one call produced two rows: each invocation mints a fresh
ref. Consistent with a second click after the first appeared to do nothing.

`contact_id` is null on both because `resolveContactByPhone('+28')` takes the
`last10.length !== 10` early return — so these calls are not even attributable to
the lead they were aimed at.

### What it needs

`toE164` must refuse rather than guess: anything that is not 10, or 11 starting
with 1, is not a number to dial. And the mask is detectable at the source — a
value containing `•` is never dialable. The dialer should say "this number is
masked for your role" instead of placing a call to `+28`.

Worth checking the same treatment in `power-dialer.html`, which passes
`lead.phone` to `connect()` **raw**, with no `toE164` at all.
