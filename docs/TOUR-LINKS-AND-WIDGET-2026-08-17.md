# Stale tour share links, and the dashboard widget's "View →"

Two logged items awaiting a decision. **Nothing here has been applied** — no
expiry set, no link revoked beyond the four probe tours already deleted, no
widget change made.

## 1. Share links — every remaining tour is stale

15 tours after the probe cleanup. All carry a `share_token`; none is revoked;
none has an `expires_at`.

**Not one has been viewed in the last 30 days.** The most recent view of any
tour is **2026-05-07 — 102 days ago**.

| tour | status | homes | views | last viewed | days |
|---|---|---|---|---|---|
| `90f285b7` Garden Grove Home Tours | sent | 2 | 11 | 2026-05-07 | 102 |
| `39dabd28` (no title) | sent | 3 | 10 | 2026-05-07 | 102 |
| `b6627641` (no title) | canceled | 2 | 18 | 2026-05-06 | 103 |
| `af06f8df` Home tour in Stanton | draft | 3 | 1 | 2026-05-04 | 105 |
| `98269f7a` (no title) | confirmed | 7 | 7 | 2026-05-03 | 106 |
| `4607bb8f` · `088dfa44` · `d1d94c13` · `3495f9bb` · `8ab49c12` | mixed | 6/5/2/3/1 | 0 | never | — |
| `97f5b48b` · `c2942f38` · `ceaf1c6d` · `15d15c42` · `d7cb8398` | draft | 0 | 0 | never | — |

Five have ever been viewed. Ten never have.

### The proposed rule collapses to "expire everything"

The default under discussion — *expire anything not viewed in 30 days, set 90
days out on the rest* — has **no "rest"**. Nothing has been viewed in 102 days,
so every one of the 15 falls in the first bucket. Worth stating before it is
applied, because the rule reads like it preserves active tours and here it
preserves none.

**Nothing in active use breaks**, on the evidence: no view in 3+ months, and the
newest tour was created 2026-05-04. The risk is not a live tour going dark; it is
a borrower returning to an old link they were sent in May.

### What a visitor sees on an expired link

A clear message, not a broken page. `tour-public-view/index.ts:660` returns
**HTTP 404** with:

> **Tour not available**
> This link may have expired or been canceled. Reach out to Rene for an updated one.

Dark, centred, styled — the same page shape as the tour itself. Two properties
worth knowing:

- **The gate runs BEFORE the view counter and the lead scorer** (`:652`), so a
  revoked or expired link stops accruing views and stops feeding lead scoring.
- **It deliberately does not say WHICH** of revoked / expired / never-existed
  applies. Confirming "this was revoked" would confirm the tour exists to an
  arbitrary URL holder.

`status='canceled'` is still not revocation: `b6627641` is canceled, has 18 views
— the most of any tour — and its link serves every address and photo today.

## 2. The widget's "View →" loses the row

`dashboard/admin.html:3897`

```html
<a href="/admin/showings" …>View →</a>
```

Per-row link, hardcoded to the list. Clicking the row for *5781 Westmoreland
Circle* lands on all 41 rows with the identity discarded. (`:1813` is a separate
"View All →" and is correct — that one *should* go to the list.)

**`tour-builder.html?batch_id=` is the right target**, confirmed rather than
assumed — `admin/tour-builder.html:225-227` reads `batch_id` and `contact_id`
from the query string and passes both to `mountTourBuilder`. The row already
carries what is needed: the widget selects `showings` with `select=*`, so
`s.batch_id` and `s.contact_id` are in hand.

Two caveats before anyone writes the one-line fix:

**a. A showing is a home; a batch is the tour.** The deep link lands on the right
tour, not on the clicked home. Much closer than the current behaviour, but not
exact.

**b. SOME batch_ids HAVE NO BATCH ROW, and a `?batch_id=` link to one resolves to
nothing.** Measured: `7a9b8440` carries 4 showings and no `showing_batches` row.
That is not an edge case — it is the tour Rene clicked through on 2026-08-16.

The cause is structural: `submit-showing` inserts `showings` with a generated
`batch_id` and never creates the `showing_batches` row. So the system holds two
different notions of "a tour":

| | rows | who sees it |
|---|---|---|
| `showing_batches` | 15 | staff tours list, tour-builder, public `/tour/<token>` |
| bare `batch_id` groupings in `showings` | 13 distinct, 1 with no batch row | the borrower portal, which reads `showings` directly |

A borrower-submitted tour is therefore invisible to the staff tours list and has
no share link, because the trigger that mints one fires on `showing_batches`
insert and that insert never happens. Worth resolving before the deep link is
added, or the fix will work for staff-created tours and dead-end on
borrower-created ones.
