# Handoff — composer toolbar (scope C), before extraction begins

**Nothing was extracted. No toolbar code changed.** This session ran the
pre-build client test and the divergence analysis; the build is the next
session's work.

---

## 1. The three-client test — sent, verified on the send side, NOT yet read

### What went out

**Three** messages through the **real send path** (`email-service` action `send`, the
same one `sendEmailFromComposer` uses), each carrying five labelled lines:

| # | representation | what it tests |
|---|---|---|
| 1 | `<font color="#C00000">` | text colour, legacy |
| 2 | `<span style="color:#C00000">` | text colour, `styleWithCSS` |
| 3 | `<span style="background-color:#FFFF00">` | **highlight — the only form `<font>` cannot express** |
| 4 | `<td bgcolor="#FFFF00" style="background-color:…">` | the Outlook-safe highlight fallback |
| 5 | no formatting | control |

```
reneduarte.realty1@gmail.com   msg 6a878fcc1a116e08ccccece0   email_log e4c1e4b7
rduarte89@yahoo.com            msg 6a878fce56ed3cdc187e9590   email_log 2a385e9a
rduarte@emortgagecapital.com   msg 6a879cf4ef044f558d7f4881   email_log 4e24c4dc   <- the Outlook result

renewaterrace@outlook.com      msg 6a8790ee4580fe1c00b42cf6   email_log e9e1f933
   ^^ MISDIRECTED. NOT Rene's address. NOT a verified result — discard it.
```

All four carry the **identical body** — same source file.

### ⚠ A test message was sent to a stranger. Do not treat it as a result.

`renewaterrace@outlook.com` was given as Rene's Outlook address and is not his. One
message reached it before the error was known. Recorded here so nobody later reads
that row as the Outlook data point.

**Scope, measured:** exactly **one** message has ever been sent to that address —
`email_log` `e9e1f933`, 2026-08-20 23:42:37, from `rene@ratesandrealty.com`,
subject *"RR toolbar rendering check…"*, 1,533 bytes. No other message, in any
direction, exists for it.

**What it disclosed:** no borrower data — no contact name, no loan, no figure
(checked: no Garcia/Navarro/borrower reference). It did carry a footnote naming
**`rduarte89@yahoo.com`** and stating that address is recorded as an agent address
on an HOI quote request. So a stranger learned one personal email address of
Rene's and that this business tracks HOI quote requests. Low severity, and real.

**Opened:** `opened_at` is NULL, `open_count` 0, `click_count` 0 — the tracking
pixel never fired. **That is weak evidence, not proof:** Outlook.com blocks remote
images by default, so a read would very likely not register. Treat it as "no
evidence it was read".

**Nothing to retract** — the message contains no client data and no credential.
The Yahoo address it names is Rene's own. No further action was taken and none is
proposed beyond this record.

### Verified: all four representations survive the send path unaltered

Read back off `email_log.body_html`, all three messages:

```
<font color="#C00000">                    present
style="color:#C00000"                     present
style="background-color:#FFFF00"          present
bgcolor="#FFFF00"                         present
```

### CORRECTION: the send path DOES modify the body — it appends a tracking pixel

I first wrote "survived byte-intact". The three bodies are the same length but
have **different md5 hashes**, and the difference is at byte 1414:

```
<img src="…/functions/v1/track-event/pixel?e=<email_log_id>" width="1" height="1" …>
```

A per-message tracking pixel is appended, carrying that message's `email_log_id`.

So the accurate statement is narrower and still sufficient: **`email-service`
ADDS a tracking pixel and STRIPS NOTHING.** None of the four colour or highlight
representations is altered, which is what the test was for. But "the body that
arrives is exactly what the composer produced" is false, and anyone diffing
composed-vs-sent will see the pixel and should not treat it as corruption.

`stripMarkdownFences` remains the only thing touching the body's own markup.

### ✅ ANSWERED 2026-08-21 — all three clients rendered correctly

Read in Gmail, Yahoo and Outlook (`rduarte@emortgagecapital.com`):

| line | representation | result |
|---|---|---|
| 1 | `<font color>` | **red in all three** |
| 2 | `<span style="color:">` | **red in all three** |
| 3 | `<span style="background-color:">` | **yellow in all three, Outlook included** |
| 4 | `<td bgcolor>` fallback | yellow — **not needed** |

**Decision: highlight ships as an inline `style` on a span.** The table-cell
fallback is not required, so `hiliteColor`/`backColor` via `execCommand` with
`styleWithCSS` on for the colour commands is sufficient — no custom
selection-wrapping command.

Text colour is safe in either form; it ships as inline style too, for one
representation rather than two.

### (superseded) what each client rendered

**I cannot see those inboxes.** The send side is proven; the render side is the
whole point of the test and it is unread. What is needed is a look at each
message and, per line 1–5, whether it appears as described.

**All three are now sent**, Outlook included (`renewaterrace@outlook.com`,
confirmed not present in `hoi_quote_requests`, `loan_orders` or `contacts`, so it
carries no correlation risk). Outlook is the result that decides the design: it is
the strictest of the three and line 3 (inline `background-color`) is the
representation at risk.

### How to read the result

- **Lines 1 and 2 both red everywhere** → text colour is safe in either form; pick
  inline style for consistency with highlight.
- **Line 3 yellow in all three** → ship the highlight button as inline style, done.
- **Line 3 blank in Outlook but line 4 yellow** → highlight needs the table-cell
  form, which `execCommand` cannot produce. That means a custom command that wraps
  the selection itself, not `hiliteColor` — a materially larger control, and worth
  knowing before it is promised.
- **Lines 3 and 4 both blank in Outlook** → do not ship a highlight button for
  that audience. A control that renders as nothing is the thing this test exists
  to prevent.

## 2. Correlation risk — checked, and the worry was aimed at the wrong row

The concern was that a send to `rduarte89@yahoo.com` could attach to VOE order
`f012081f`. Measured:

| row | can `address_unique` fire? |
|---|---|
| VOE order `f012081f` | **No.** `gmail_message_id` and `rfc_message_id` are both NULL, and that tier requires one of them. Structurally unreachable. |
| HOI quote request `19e31518` | **Yes** — `agent_email = rduarte89@yahoo.com`, and it has both ids. |

So the reachable row is the **HOI request**, not the VOE order. And the subject is
not the lever: the `address_unique` tier keys on the **sender address of an
inbound reply**, not on subject text. Subject only protects the `in_reply_to` and
thread tiers.

**Confirmed nothing attached.** After the sends:

```
quote_reply_log rows in the last 30 min ....... 1
  → karlton.dennis@taxalchemy.com, "Real estate training is live now",
    matched_by 'unmatched' — a marketing email, not mine, attached to nothing
rows attached to HOI request 19e31518 ......... 1
  → from 2026-08-17, matched_by 'in_reply_to', pre-existing, three days old
loan_orders f012081f updated in last 30 min ... 0  (last touched 2026-08-12)
```

**Outbound sends are never examined by `quote-reply-poll`** — it reads inbound
mail — so the send itself could not correlate, and did not.

**The live risk is a REPLY from the Yahoo address.** That would be inbound from a
known agent address and could attach to HOI request `19e31518` via
`address_unique`, regardless of subject. The message body says so and asks for any
reply to come from the Gmail address instead. To re-check after any reply:

```sql
select id, matched_by, from_email, subject, created_at
from quote_reply_log
where row_id = '19e31518-c19c-461e-ba0b-529cab89c721'
order by created_at desc;
```

Anything dated after 2026-08-20 attached to that row is the test leaking, and the
fix is to delete that `quote_reply_log` row — it is a correlation record, not
borrower data.

## 3. Divergence analysis — done

Full detail in `docs/TOOLBAR-CONSOLIDATION-DIVERGENCE-2026-08-20.md`. Eight
disagreements, each with a winner picked and the reason. In short:

1. **link URL validation** → validate (inbox/settings win; main and drip have no
   scheme check)
2. **link prompt default** → prefill `https://`
3. **`execCommand` error handling** → try/catch
4. **focus handling** → the main composer's before-and-after focus (the one place
   main is better)
5. **font list** → named faces with a fallback stack
6. **size scale** → named sizes on the legacy scale; also fixes a real ordering
   bug in main (value 4 "14" listed above value 3 "12")
7. **controls present** → union for the formatting core, **not** for the insert
   controls (Canva/Loom/emoji/variables become host-passed slots)
8. **dispatcher shape** → `(cmd, value)` with an explicit target; drip's
   `fmtText(cmd)` takes no value argument and structurally cannot support any of
   the new controls

Cross-cutting: enable `styleWithCSS` **for the colour commands only**. Globally
would change what bold and underline emit across every email this CRM sends.

## 4. What the next session should do

1. **Read the three inboxes first.** The design of the highlight control depends
   on it, and everything else is unblocked either way.
2. Extract one toolbar component: `(cmd, value)` dispatcher, explicit target
   element, core controls always, insert controls as opt-in slots.
3. Mount it on the four rich-text surfaces: `#emailEditor`, `inbox.js`,
   `#sigEditor`, drip-builder. **HOI is held** — it is plain text and converting
   it is a different change.
4. `#lpEmailBody` becomes a **mount call** rather than a port once the component
   exists — five template emails including the HOI agent and realtor ones
   currently have no controls at all. Not this pass, but it is a few lines
   afterwards.

## 5. Also open, unrelated to this work

- `docs/OPEN-external-uptime-ping-2026-08-20.md` — the end of the monitoring
  chain. Needs a service, a secret and a paging channel decided.
- `docs/GENERATE-PREAPPROVAL-2026-08-20.md` — the frontend move shipped; the
  `requireStaff` guard is still held pending a button confirmation, and the
  server-side DTI derivation follows it.
- `docs/LOAN-SCENARIOS-DECISION-2026-08-20.md` items 2 and 4 (income/debt dual
  meaning; scenario-vs-application drift on the page) are still held.
