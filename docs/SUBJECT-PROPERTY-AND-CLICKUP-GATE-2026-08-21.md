# The subject property, the UUID, and 39 false submissions — 2026-08-21

Started as "the Loan Snapshot shows a UUID as a unit number". Ended in four
separate defects, three of which had been silently producing borrower-facing
output for months.

---

## 1. What was actually wrong

Daniel Garcia's Loan Snapshot read **"TBD, Unit 599b4b4a-26e…"** — his own
`contact_id`, rendered as a unit number. Rene had typed "15535 Crossdale Ave"
into the Subject Property popup and saved.

Two independent faults, which is why it looked incoherent:

**a. The UUID.** `save1003()` had written the contact's own id into
`property_address_unit` AND `property_address_city` in a single UPDATE. Twice
ever, both times both columns:

| audit | when | contact |
|---|---|---|
| 661 | 2026-07-10 20:06:19Z | Daniel Garcia |
| 1796 | 2026-08-14 05:24:32Z | Marlon Vasquez Ramos |

Both under rene@'s own session. Both payloads carry `borrower_id: BR-2026-…`,
generated only in `save1003`. **It reached the generated URLA 1003**, which
renders `unit: app.property_address_unit`.

**b. The typed address had saved — somewhere nothing displays.** The popup wrote
`contacts.property_address`; the snapshot, `generate-1003-pdf` and the MISMO
export all read `mortgage_applications`. His application row still said street
"TBD", ZIP **92704 (Santa Ana)** and county **Orange** while the contact said
Norwalk **90650**. Not stale — wrong.

---

## 2. The mechanism behind the UUID is STILL UNKNOWN, and that is on purpose

Every static writer of `#f_prop_unit` and `#f_prop_city` was traced: the markup
(both ids unique), `sv()` in `load1003` (reads the row back, so it re-persists
but cannot originate), the Places `sync()` and `RRPlaces.attachSplit` (parsed
components only), `_lpPrefill1003People` / `_lpFillPersonInfo` (name, email,
phone, DOB, SSN only), and both OCR maps — which route `unit` and `city` to the
**current-address** fields, never the property ones. No dynamically-built id can
collide. `save1003`'s `data` literal has no duplicate keys and uses `cid` once,
as `contact_id`.

None of them can produce a contact id. Reproducing it needs a live session
watched through scan → apply → save.

**So no fix was attempted for the cause.** What shipped is a guard at the write:

```js
// save1003(), before the insert/update
_ADDR_KEY_RE = /(address|street|unit|city|state|zip|county)/i
_UUID_RE     = /[0-9a-f]{8}-[0-9a-f]{4}-…/i        // NO /g — .test() is stateful with it
```

It refuses the **whole** save and **names the field**. A partial write would leave
the row in a state nobody chose, and being told is the entire point.

Both directions are asserted, because a guard that refuses everything would block
every 1003 save in the CRM — worse than the bug. `SPC 184`, `Norwalk`,
`15535 Crossdale Ave` and `Apt 2B` must all pass, and do.

---

## 3. Option C — the application row is authoritative for the subject property

### Why that direction

- It is **structured**. The URLA renders street/unit/city/state/ZIP as separate
  cells; MISMO emits `<AddressLineText>/<CityName>/<PostalCode>`;
  `property-lookup` and `pull-comps` rebuild a query from the parts. One text
  line cannot serve those without re-parsing.
- It is what the **legally significant outputs already read**.
- **Precedent**: `sync_application_to_contact` already treats the application as
  source and the contact as a fill-only copy that never overwrites.
- **`mortgage_applications_one_per_contact`** — a partial unique index on
  `contact_id WHERE contact_id IS NOT NULL` — so the mapping is 1:1 and
  unambiguous. (`save1003`'s comment that "a contact can legitimately have
  multiple applications" is **wrong**; the check-then-update it justifies is
  harmless but rests on a false premise.)

### What changed in the popup

**Every save now reaches the application row**, not only a Google Places pick.
Two rules, both load-bearing:

1. **The row is NEVER created here.** `clickup_app_submitted` is AFTER INSERT —
   creating a row because somebody typed an address would announce an application
   that does not exist. A contact with no application keeps the address on
   `contacts`, which is the correct lead-stage home. 12 of 25 property addresses
   are on contacts with no application at all.

2. **Without parsed components, the structured columns are CLEARED.** A
   free-typed line updates `property_address`, but the old street/unit/city/
   state/ZIP/county describe a *different* property — and the snapshot prefers
   the structured split over the combined line. Leaving them behind reproduces
   the exact mismatch above, with the stale parts silently winning.

   *A 1003 with a street and no city is visibly incomplete and gets fixed. A 1003
   with the wrong ZIP is invisible and does not.* The user is told in a toast;
   silently clearing six fields on a borrower's file should never be a surprise.

The popup's **read** path was inverted to match — application row first, contact
second — so the editor opens showing what the page displays. It used to be able
to show one address while the snapshot, the PDF and MISMO showed another.

---

## 4. The ClickUp gate: 39 announcements, 22 of them false

`trg_clickup_app_submitted` is AFTER INSERT, and *"a `mortgage_applications` row
was created"* has never meant *"a borrower submitted an application"*. Every
event created a real ClickUp task reading **"Mortgage application submitted.
Package documents, run AUS, send to underwriting"**, high priority, assigned to
Rene.

| | events |
|---|---|
| ZZ-TEST fixture | 2 |
| Orphan — contact deleted (`ON DELETE SET NULL` on the log's FK) and row gone | 7 |
| Same-day duplicate, the extra task | 4 |
| Row exists but entirely empty | 7 |
| Contact still "New Lead" | 2 |
| Row has data and past New Lead | 17 |

Confirmed live: `86e1eq8q2` — *"Submit Aned Mendoza loan to lender"*. Aned Mendoza
is not in the database.

### There is no positive "submitted" condition to key on

```
mortgage_applications.status  →  30 null · 5 'draft' · 0 'submitted'   (all time)
```

Nothing in the codebase writes `'submitted'`. The only discriminator that exists
is the negative one: **`status='draft'` is written by `mismo-import`** — those
rows are LOS file imports.

So the gate is negative, built only from conditions that already exist:

```sql
NEW.status IS DISTINCT FROM 'draft'
AND (NEW.ssn IS NOT NULL OR NEW.date_of_birth IS NOT NULL OR NEW.loan_amount IS NOT NULL)
```

Against today's 35 rows: 5 imports excluded, 7 empty rows blocked, 23 still pass.

**Proven in both directions**, on the ZZ-TEST fixture, inside a transaction that
rolled back — pg_net queues into `net.http_request_queue` transactionally, so
counting that queue observes the fire and the rollback discards both the row and
the queued call:

```
address-only row   ->  0 calls queued   (blocked)
row with substance ->  1 call queued    (fires)
```

Nothing persisted, nothing reached ClickUp. **If a real `submitted` flag is ever
introduced, REPLACE this rather than adding to it** — a positive condition is the
honest test and this is a proxy for one.

---

## 5. `event_signature` — a dedup key that cannot dedup

`buildSignature(triggerType, contactId, sourceId)` joins
`trigger:contact:sourceId`, falling back to today's date when `sourceId` is null.
For `app_submitted` that is **`app_submitted:<contact_id>:<application_id>`**.

**It keys on the source row's identity — the one thing an AFTER INSERT trigger
guarantees is unique.** `NEW.id` is a fresh uuid every time, so the signature can
never collide and the check at line 91 can never match. The code is correct and
unreachable. It fits the trigger it was written for: `cold_lead_3d` sends no
`source_id`, so its signature degrades to `trigger:contact:date`, which genuinely
would collide.

### The measurement that looked like proof and was not

"Zero `skipped_duplicate` rows in the log" is **not** evidence the dedup never
fired. The skip branch did `results.push(...)` and `continue` — **it never
inserted a log row**. Skips were unobservable, so the table could not answer the
question either way. The claim that survives is the structural one above.

**Fixed in the same pass.** The skip branch now writes its row, carrying the task
id it would have duplicated and the log id that suppressed it. Notes:

- `'skipped_duplicate'` was **already in the table's CHECK constraint** — the
  schema anticipated this row and the writer forgot it.
- The dedup lookup filters `status='created'`, so skip rows can never become
  dedup targets themselves and cannot chain.
- Logging the skip is wrapped and never fatal: failing to record a suppression
  must not turn a correct suppression into an error.

A check whose successes are invisible is the same family as everything else in
this file.

---

## 6. `clickup-auto-create` was unpinned, and one deploy from a fifth outage

Not in `config.toml` at all. Its only caller is `fire_clickup_automation()`, which
posts through `net.http_post` with **no Authorization header**, and which swallows
failures in `exception when others -> raise notice`.

An unpinned deploy takes the CLI default of `verify_jwt = true`, which would 401
every automation in the CRM at the gateway with nothing surfacing. That is
`send-scheduled-sms`, `send-scheduled-emails`, `sms-service` and `clickup-bridge`
exactly — the fourth of which is documented in `config.toml` as having run 401'd
for weeks with nothing alerting.

Now pinned at its measured current value (`false`, ACTIVE, v55).

---

## 7. Data changed

All snapshotted to `snapshots/` and to Postgres copies first.

**The three UUIDs, nulled** — scoped to `value = contact_id::text`, so a real
address could not be touched. Full sweep after: **0 remaining**. Both 1003s
regenerated live: **no UUID in either** (`generate-1003-pdf` is pure read — no
storage, no `uploaded_documents`, no Drive — so nothing was left on either
record).

**Daniel corrected**: street `TBD → 15535 Crossdale Ave`, ZIP `92704 → 90650`,
county `Orange → null`. **County nulled, not corrected** — Norwalk 90650 is not
Orange County, but asserting the right one from memory is a guess.

**8-row backfill**: the combined line to `mortgage_applications.property_address`
for 7 (Josue skipped — his legacy column already held the same property), and
city/state/ZIP for the 3 whose contacts carry real parsed components.

**`street` is null on all 8, deliberately.** `contacts` has no street component,
only a combined line, and splitting free text is the guessing the popup exists to
avoid. **Josue Ramos is unchanged**: his contact carries no parsed components at
all, so filling his structured columns would have required exactly that split.
One row unfilled beats an invented street.

---

## 8. Still open

### RESOLVED — `audit_log` shape, retention, and the INSERT capture

Shipped the same day. The framing "13 MB with no trim job" was **wrong**: it was
never primarily a retention problem.

| | |
|---|---|
| `mortgage_applications` share | 1,300 of 1,872 rows · **9,987 kB of 10.7 MB — 93%** |
| Average keys changed per UPDATE | **2.2**, at ~7.9 KB stored |
| Same history, changed keys only | **1,129 kB — 11.3%** |
| Updates where nothing changed at all | 14 |

A 2-field edit cost 7.9 KB because `to_jsonb(OLD)` and `to_jsonb(NEW)` were both
stored whole. So:

- **UPDATE stores only the differing keys**, with `old_data` holding the prior
  value of exactly those keys. Measured on a one-field change: **7,900 bytes →
  66 bytes.**
- **A no-op UPDATE writes no row.**
- **INSERT and DELETE still store the full row** — there is no prior state to
  diff an insert against, and a deleted row's contents are the point of auditing
  the delete.
- The union of both key sets is diffed, not just `NEW`'s, so a column added or
  dropped cannot vanish from the diff; compared with `->` not `->>`, so JSON null
  and the string `"null"` stay distinct.

**The 1,300 existing rows were deliberately NOT rewritten.** A mixed-shape log is
honest; rewriting one destroys the original capture to save 9 MB. Anything
reading it must handle both shapes.

**Trade-off, stated because it is real:** a diff row no longer carries the rest of
the record. `row_id` still identifies it, but an unchanged column must be read
from the table itself — or from the INSERT/DELETE capture.

**Retention lives inside the writer**, per the `monitor_runs` argument: a cron job
can be disabled, paused or fail silently, and the cleanup must not outlive the
thing that maintains it.

```
mortgage_applications   7 years    the borrower record; over-keeping beats a gap in an audit
everything else        90 days     operational noise
```

Bounded to 500 rows per write so a backlog cannot stall the write that triggered
it. Proven in a rolled-back transaction, all four cases: `tasks` @91d trimmed,
@89d kept, `mortgage_applications` @91d **kept** (7-year horizon), @8y trimmed.

**Neither half can throw**, which is the condition that matters — this is an
AFTER trigger inside the caller's transaction, so an exception aborts the write it
was auditing and the audit becomes the outage. Proven by breaking both on
purpose:

```
audit insert broken (CHECK(false) NOT VALID)  -> business write survived, 0 audit rows
retention trim broken (BEFORE DELETE raises)  -> business write survived
```

The cost is that a failure to audit is quiet — a `RAISE WARNING`, nothing more.
The alternative is a failure to audit that also loses the borrower's data.

**INSERT is now captured** on `mortgage_applications` (~23 per 90 days). That is
what makes the next 39 replayable. It could not help with these 39: the rows
predate it.

### The original framing, kept for the record

`trg_audit_mortgage_applications` is **AFTER DELETE OR UPDATE only**, so the one
event that fires ClickUp has no provenance record. That is why the 39 could not
be replayed.

Adding INSERT is cheap: **23 inserts in 90 days**, ~4 KB each, ≈ **400 KB/year**
against a 13 MB table taking ~29 rows/day. No new PII class — DOB is already in
506 rows, and no SSN has ever reached it (`trg_redirect_ssn_to_vault` is BEFORE
INSERT/UPDATE; the single non-null `ssn` in the log is the empty string).

**The blocker is that `audit_log` has no retention at all** — no cron job trims
it, 13 MB in two months, unbounded. Adding INSERT without retention compounds a
problem that already exists. See the retention decision, which needs: what to
keep, for how long, and whether the trim lives *inside* the writer the way
`monitor_runs.recordRun()` does, so it cannot be disabled separately.

### Other

- **The 22 false ClickUp tasks** are untouched. The gate is inflow-only. Task ids
  are in the session record; most could not be read back through the MCP
  ("Resource not found" / "Team not authorized"), and the *Total time in Status*
  ClickApp is disabled, which is what blocked a bulk status sweep.
- **`save1003`'s multiple-applications comment** is wrong — see §3.
- **The UUID mechanism**, §2.
