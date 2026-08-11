# Escrow-number thread suggestion — recommendation, 2026-08-10

**Read-only. Nothing built, no schema changed, no function deployed.**

Follows `AUTO-TAGGING-2026-08-10.md` and its CORRECTION. The brief: suggest a
thread's lead from an escrow number, never auto-file. Three questions were asked
first — what `loan_orders.reference` being empty means for testing, where the
match should run, and what the minimum length is.

Two of the three have answers that change the design rather than just filling it
in.

---

## 1. A sweep is not an expensive option. It is an impossible one.

This is the finding that settles the "ingest / render / sweep" question, and it
is not visible from the schema.

`gmail-inbox::index.ts:600`:

```ts
const m = await matchContact(svc, participants)
let persisted = null
if (m.contact_id) persisted = await persistMessages(svc, rows, m.contact_id)
```

**Mail that matches nothing is never written to `email_log`.** There is no
ingest step that stores it and files it later — matching *is* the ingest gate.
So the population an escrow matcher exists to serve — inbound mail that address
matching missed — **has no row in the database to sweep**.

Measured:

| `email_log` | rows |
|---|---|
| total | 577 |
| filed (`contact_id` not null) | 399 |
| unfiled (`contact_id` null) | 178 |
| **of those 178: outbound, no `gmail_thread_id`** | **171** |
| inbound with a thread id | 6 |
| outbound with a thread id | 1 |

The 171 are campaign/marketing sends from the email-marketing path, which never
had a thread. A pg_cron job over `email_log where contact_id is null` would scan
178 rows of outbound marketing and find **essentially nothing to suggest**.

To sweep the real population you would have to sweep **Gmail**, not Postgres —
`threads.list` + `threads.get` per thread, on every run, forever, for mail that
in most cases nobody will ever open. That is the expensive design the brief
wanted to avoid, and it is the *only* form a sweep can take here.

**Recommendation: no sweep.** Not "not yet" — the shape is wrong.

## 2. This is not a search problem. The candidate set is eleven rows.

`loan_orders.reference` is 0-populated, which the earlier report already noted.
What it did not note is the denominator:

| | |
|---|---|
| `loan_orders` rows, all types, all time | **11** |
| of those, `order_type = 'escrow'` | **1** |
| with a non-empty `reference` | **0** |

So the matcher never queries "does any order match this text". It loads **every
non-empty reference in the table** — today 0 strings, realistically 1–10 once
Rene starts entering them — into memory, once, and scans thread text against
that list.

That reframes the cost question in the brief. There is no per-email lookup to
price. There is one query returning a handful of rows, cacheable for an entire
inbox session, and a regex over text that is already in memory.

## 3. `reference` is not unique across contacts, and nothing makes it so

`ux_loan_orders_contact_type_single` is unique on `(contact_id, order_type)`
where type ≠ voe — so a contact has at most one escrow row. **Nothing constrains
the same escrow number appearing on two contacts.** A typo, or a genuine
re-use, produces two candidates.

The CORRECTION document already caught one tie-break that resolved to the wrong
answer silently (rule 2 sorting `ordered_at desc`, Postgres putting NULLS first,
so the winner was an order that was never placed). Same trap, same table.

**Rule: reference → more than one contact ⇒ suggest nothing, and say so.** Not
"pick the most recent". An ambiguous exact match is a data-entry error worth
telling Rene about, and picking a winner hides it.

## 4. Where it runs: the thread view, on data already fetched

Given §1, "on ingest" and "on thread render" are **the same moment** in this
codebase — `get_thread` is where mail enters `email_log`. So the real choice is
between the thread view and the inbox list.

**Thread view (`get_thread`) — yes.** It already fetches full message bodies
(`messageToRow` → `body_text`/`body_html`) and already runs `matchContact`. The
scan is a regex over text that is in memory in that same request. Marginal cost:
one query for the reference list. This is where it should live.

**Inbox list — not in the first build.** `list_threads` returns only `subject`
and Gmail's `snippet` (~200 chars), not bodies. An escrow number in the subject
would be caught; the same number three paragraphs into the mail would not. A
badge that appears on some rows and not others for a reason Rene cannot see
teaches him the feature has less coverage than it has — or more. Add it later,
if at all, and only after the thread-view version has established what the hit
rate actually is.

**Sweep — no.** §1.

## 5. The floor, and where it is enforced

The earlier report established the case: one of the two `contacts.loan_number`
values is three characters, all digits, and `LIKE '%<that>%'` matches a dollar
amount, a street number, a date, a phone fragment, an order id.

Escrow numbers are usually safer in shape — `24-118432-KM`, `ESC-2026-0847`,
`0812345-KM` — but nothing guarantees it, because the field is free text.

**Proposed floor:**

- **≥ 6 characters, and at least one digit.**
- **All-digit references raise the floor to 7 digits**, because a 6-digit
  all-numeric token is a zip+1, a price, or a date in the wrong format. A
  reference containing a letter or a separator (`-`, `/`) is materially safer
  and clears at 6.
- Match on **word boundaries**, and never when the token is immediately preceded
  by `$`.

**Below the floor, the behaviour is silence, not a lower-confidence
suggestion.** A suggestion with a caveat attached is still a thing Rene has to
read and dismiss.

**Enforce it at entry, not only at match time.** The escrow editor already
exists (`lead-detail.html:17417`, `lpSnapEdit('escrow_ref')` → `loan_order_set`).
A number below the floor should still **save** — it is the real escrow number and
the field is for recording it — but the editor should say, once, plainly:

> Saved. This number is too short to search mail for, so threads won't be
> suggested from it.

That puts the feedback in front of the one person who can tell whether the
number was mistyped, at the moment they typed it. A floor enforced only inside
the matcher is invisible: the feature just quietly never fires and looks broken.

## 6. What the prompt says, and where

**Where:** the thread header, directly under the existing `🏷 Filed` /
`🏷 Not filed` chip in `renderThread` (`admin/js/inbox.js:2900`). Not a modal, not
a toast — it must survive being ignored, and it must be re-readable.

**What it says** — it names the token AND the contact AND what the current
filing rests on, because that is what makes a real match distinguishable from a
coincidence without opening anything:

Not currently filed:

> 🔎 Escrow **24-118432-KM** appears in this thread.
> That is the escrow number on **Tania Monje Flores**' file.
> &nbsp;&nbsp;[ File on Tania Monje Flores ]&nbsp;&nbsp;[ Dismiss ]

Already filed, and the escrow number **agrees**:

> ✓ Escrow **24-118432-KM** in this thread confirms the current filing.

— a one-line confirmation, no buttons, no action. Confirmation is worth showing
because it is the cheap signal that the matcher is working at all, but it must
never ask for a click.

Already filed, and the escrow number **disagrees** — see §7.

Ambiguous (§3):

> ⚠️ Escrow **24-118432-KM** is recorded on **two** files (Tania Monje Flores,
> Marcus Hurle). Not suggesting a lead — one of those is probably a typo.

**One click to file** reuses the existing `tag` action, unchanged: it persists
every message and writes `email_thread_tags` via `email_thread_tag` as the user,
so an accepted suggestion lands as a **human tag with `tagged_by` set** —
correctly, because a human made the decision. That is the whole point of
suggesting rather than filing, and it means the accept path needs no new
write path at all.

## 7. Contradiction is the highest-value output, and it splits in two

The brief asks whether an escrow match confirms or contradicts an existing
`contact_id`, and calls contradiction the interesting case. It is stronger than
that: **contradiction is the case that would have caught the one misfile we
know about.**

Thread `19f964d623e8a4c0`, "Update Insurance 947 N Alamo St", filed on
**Alexander Duarte** — the CC'd agent — because his address was the only one on
the thread that resolved to a contact. The mail is about **Tania Monje Flores**.
Her escrow order exists. Once it carries a reference and that reference appears
in the escrow correspondence, the matcher says Tania, the filing says Alexander,
and the disagreement is exactly the alarm.

**But the two kinds of disagreement are not alike, and the code already knows
the difference.** `renderThread` computes `filedVia = 'tag'` when
`email_thread_tags` holds a row, and otherwise takes `data.matched.matched_by`
(`'contact'` or `'vendor'`).

| current filing | escrow says otherwise | treatment |
|---|---|---|
| automatic (`matched_by` = `contact` / `vendor`) | | **loud.** Full prompt, both names, the address rule 1 matched on, and a re-file button. |
| human (`email_thread_tags` row, `tagged_by` set) | | **quiet.** One line, no button: "Escrow 24-118432-KM on this thread is recorded on Marcus Hurle's file." |

Contradicting a human's explicit decision with a button that offers to undo it
is how a suggestion becomes nagging, and Rene re-filing something on purpose is
the case where the machine is most likely to be the one that is wrong. Say it
once, quietly, and leave it alone.

The loud version, concretely:

> ⚠️ This thread is filed on **Alexander Duarte** — matched automatically on the
> address `alex@tdgsells.com`.
> Escrow **24-118432-KM** in this thread belongs to **Tania Monje Flores**.
> &nbsp;&nbsp;[ Re-file on Tania Monje Flores ]&nbsp;&nbsp;[ Keep Alexander Duarte ]

Naming `alex@tdgsells.com` is what makes this readable at a glance. It is the
same argument the CORRECTION made for `match_evidence`: nobody who sees *why*
the thread was filed on the agent leaves it there.

## 8. Dismissal must stick, and the key is the pair

No dismissal store exists anywhere in this project. The one table that greps as
one — `processing_items_removed_tpl_dismiss_20260810` — is a snapshot from
unrelated checklist work, not a mechanism.

```sql
create table email_thread_suggestion_dismissals (
  gmail_thread_id      text        not null,
  suggested_contact_id uuid        not null references contacts(id) on delete cascade,
  dismissed_by         uuid        not null,
  dismissed_at         timestamptz not null default now(),
  primary key (gmail_thread_id, suggested_contact_id)
);
```

**Keyed on the pair, never on the thread alone.** Dismissing "file this on
Tania" must not suppress a later, different, correct suggestion on the same
thread. This is the same reasoning as the health-monitor digest key: the key is
the suggestion's **identity**, never its content — and it means a corrected
escrow number, which resolves to a different contact, produces a new key and
prompts again. That is the desired behaviour, not a leak.

Read it in the same round-trip the thread view already spends on
`email_thread_tags` (`inbox.js:2879`).

## 9. Testing: a fixture, and the extractor tested apart from the wiring

`reference` is 0-populated, so **there is nothing to match against today** and
no real thread will exercise this. Two separate things need proving and they
should not be proven together.

**a) The extractor, as a pure function with unit tests.** Precedent:
`_shared/transcript-format.ts` and its 12 tests, written specifically so neither
code path waits on a real phone call. Same argument applies exactly. Cases worth
covering, all offline:

- above / below the 6-char floor; the 7-digit all-numeric rule
- `$24118432` not matching reference `24118432` (the `$` guard)
- the number embedded mid-word, which must not match (word boundaries)
- the number in the subject only; in the body only; in a quoted reply chain
- two contacts holding the same reference → suggests nothing (§3)
- HTML body where the number is split by a tag — decide and pin the behaviour
  rather than discovering it later

**b) The wiring, once, against the fixture.** Per CLAUDE.md, use the existing
**`ZZ-TEST Fixture Borrower`** contact — do not create a new one, since inserting
a contact fires the ClickUp and Drive-foldering triggers and leaves two
artifacts behind.

```
loan_order_set(p_contact_id := <fixture id>, p_order_type := 'escrow',
               p_reference := 'ZZTEST-ESC-000123', p_status := 'not_ordered')
```

Note `loan_order_set` UPSERTs, so this creates the escrow row if absent — and
the fixture has none today, so it will. Deliberately unmistakable as a real
escrow number, and removable by passing `''` (not null — `loan_order_set` does
`reference = coalesce(p_reference, reference)`, so null leaves the old value in
place; this is already documented at `lead-detail.html:17426`).

**Do not send a test email to make a thread.** That puts a fabricated escrow
number into the real rene@ mailbox permanently, which is the shape of thing the
probes-and-tests rule exists to stop. Point the render-check harness at a
fixture page, or exercise the extractor per (a) and confirm the wiring by
opening one **existing** thread with the fixture reference temporarily set to a
string that thread genuinely contains.

Caveat, stated because it is the kind that gets forgotten: **render-check proves
rendering, not authorization.** It will not prove that a VA can or cannot see
the suggestion. The escrow number is already staff-visible by deliberate choice
(`LP_SNAP_STAFF_KEYS = ['escrow_ref']`, `lead-detail.html:17404`), so the
suggestion inherits that and needs no new gate — but that is an argument from
the existing decision, not something a green harness run establishes.

## 10. Build order

1. **`email_thread_suggestion_dismissals`.** First, because a suggestion that
   cannot be dismissed permanently is worse than no suggestion — it is a thing
   that reappears on every render and trains Rene to stop reading the header.
2. **The extractor + its tests**, as a pure function in `_shared/`. No UI.
3. **Thread-view prompt**, all four states: unfiled, confirms, contradicts-auto
   (loud), contradicts-human (quiet). Reuses the existing `tag` action for
   accept; no new write path.
4. **The entry-time floor notice** in the escrow editor.
5. Nothing else. Inbox-row badges and any sweep stay unbuilt.

## 11. What this does not fix, and should not be read as fixing

- **Rule 1 still misfiles.** This adds a second opinion that can catch it on
  threads carrying an escrow number; it does not narrow rule 1. The CORRECTION's
  recommendation — prefer a participant who is the borrower on an active loan,
  and decline to file when the only match is a contact with no loan — is still
  the fix, and is independent of this.
- **`match_source` / `match_evidence` still do not exist.** The prompt in §7
  names `alex@tdgsells.com` by re-deriving it from `data.matched.email`, which
  `matchContact` already returns to the client but nothing stores. So the
  contradiction alarm works in the thread view and leaves no record. That is
  acceptable for a suggest-only feature and is not a substitute for the columns.
- **Coverage is bounded by data entry.** Zero escrow numbers are recorded today.
  This feature does nothing at all until Rene enters them, and its reach is
  exactly the set of files where he has.

---

# BUILT — 2026-08-10

Approved as recommended, with two additions that changed the design.

## Addition 1 — the contradiction is recorded, not just shown

The brief above left the contradiction alarm as a banner, and noted it left no
record. That was the wrong call: 947 N Alamo sat misfiled for weeks and was found
by somebody reading, not by anything reporting it. A banner only helps whoever
opens that thread next.

**`email_thread_match_contradictions`** now holds one row per disagreeing thread.

**The minimum needed to record a contradiction without `match_source` /
`match_evidence`** — the question asked — turned out to be: nothing on
`email_log` at all. The evidence for both sides already exists in memory at the
moment the contradiction is computed, inside `get_thread`:

| what | where it comes from |
|---|---|
| `filed_via` | `matchContact`'s `matched_by` — `'contact'` or `'vendor'` |
| `filed_evidence` | `matchContact`'s `email` — the address it matched, already returned to the client and never stored until now |
| `escrow_reference` | the token the extractor matched |
| `escrow_contact_id` | the file that number is on |

So the row carries `match_source` and `match_evidence` **for the only case that
currently needs them**, rather than adding two columns to every filing. A
contradiction is fully reviewable from this one table without reopening the mail:

```sql
select thread_subject, filed_via, filed_evidence, escrow_reference, last_seen_at
from email_thread_match_contradictions
where resolved_at is null
order by last_seen_at desc;
```

It is **not** a substitute for the columns. It records disagreements only, so it
says nothing about the other 194 threads rule 1 filed.

**Coverage limit, stated rather than assumed away:** rows are written when a
thread is OPENED, because that is when the bodies exist. Threads nobody has
opened produce no row, and no sweep can close that gap — unmatched mail is never
persisted (§1). This table is *every contradiction anyone has loaded*, which is
strictly more than *every contradiction anyone noticed* and strictly less than
*every contradiction*.

Resolutions: `refiled` (accepted), `kept` (dismissed), `superseded` (filed on a
third contact — its own value, because reading that back as `kept` would credit
the automatic match with an outcome it did not earn). A CHECK refuses
`filed_via = 'tag'`, so contradicting a human tag can never be recorded even by a
future caller.

## Addition 2 — the false-positive half of the suite

`escrow-match.test.ts`, **38 tests**, and more than half are things it must NOT
match, built from real shapes: dollar amounts (`$24118432`, `$ 24118432`), CA MLS
numbers (`OC24118432`), invoice numbers, Amazon-style order ids
(`112-4829301-4820394`), UPS and USPS tracking numbers, hyphenated phone numbers,
ISO dates, zips, and — the one that would file a loan file on the wrong borrower —
a reference sitting inside a longer, different escrow number (`1184321` inside
`24-1184321-KM`).

Two rules do that work: alphanumeric adjacency disqualifies a hit (kills the MLS
case), and `-` / `/` adjacency disqualifies it too (kills the fragment case).

**One limitation is pinned as a passing test rather than hidden:** a reference
shaped exactly like the tail of a space-separated phone number (`555-0142` in
`(714) 555-0142`) DOES match. Nothing here reads context; the defence is the
charset and the length floor. Recorded honestly so nobody later "discovers" it as
a bug and loosens something real to fix it.

**The suite was broken three ways before being trusted**, per the repo rule that a
harness which has only ever passed proves nothing:

| break | tests that caught it |
|---|---|
| drop `-` and `/` from the boundary class | 5 |
| disable the `$` guard | 1 |
| lower the floor to 3 | 6 |

## The floor is mirrored, and the mirror is watched

`admin/lead-detail.html` restates the floor in plain JS — no build step bundles
edge-function TypeScript into the admin pages. Two copies of a rule drift, so
`escrow-match.test.ts` reads the HTML and fails if the constants or the shape
pattern stop matching. Verified by changing `LP_ESC_MIN_LEN` to 5 and watching it
fail. The constants it compares against are **derived from the module's own
behaviour**, not hardcoded, so the test cannot pass by agreeing with a stale copy.

## Shipped

| | |
|---|---|
| `supabase/migrations/20260810_escrow_thread_suggestions.sql` | both tables, RLS staff-read, no write policy |
| `supabase/functions/_shared/escrow-match.ts` | the extractor, pure |
| `supabase/functions/_shared/escrow-match.test.ts` | 38 tests |
| `supabase/functions/gmail-inbox/index.ts` | `get_thread` returns `escrow`; new `dismiss_suggestion`; `tag` closes an open contradiction |
| `admin/js/inbox.js` | the banner, six states, and its two handlers |
| `admin/lead-detail.html` | live entry-time floor hint + save notice |

Verified: 38/38 tests; `check-functions` 0 new type errors; drift in sync before
and after deploy; `verify_jwt` still matches its pin; render-check 14/14;
`deploy.sh` 102 asset references and 100 pages serving their own bytes. The six
CHECK constraints were probed live on the ZZ-TEST fixture — `filed_via='tag'`,
a half-written resolution and an unknown resolution all refused; the three valid
shapes accepted; probe rows deleted, both tables back to 0.

**Not done, deliberately:** rule 1 is untouched. This is a second opinion, not a
narrowing.

**Inert until data exists.** `loan_orders.reference` is still 0-populated, so
every `get_thread` currently costs one extra query that returns nothing and the
feature shows nothing. It begins working on the first escrow number entered.
