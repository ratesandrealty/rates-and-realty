# try/catch around supabase-js swallows database failures — the size of it

Found while converting `admin/people.html` to `task_upsert` (surface 2). The
`try/catch` around that page's task insert **had never fired**, and the reason
generalises.

## The premise

**supabase-js RESOLVES with `{ data, error }` for a database failure. It does not
throw.**

So `try { await sb.from('x').insert(...) } catch (e) {}` catches network-layer
rejections only. A constraint violation, an RLS refusal, a missing column grant,
a failed RPC — all arrive as a **value nobody reads**, and the code continues
down its success path.

This is not the same as an empty catch being lazy. An empty catch at least
implies someone considered the error. Here the catch is *decorative*: the
failure never reaches it.

## Counts

Scanned every tracked `.js` / `.html` / `.mjs` outside `node_modules`, `vendor/`
and worktrees; brace-matched `try` blocks so nesting does not smear results.

| | |
|---|---|
| files scanned | 190 |
| `try` blocks wrapping a supabase-js call | **465** |
| …that check `.error` or rethrow | 299 — legitimate |
| **…that SWALLOW** | **131** |
| ‣ writes / rpc | **52** |
| ‣ reads | 42 |
| ‣ auth / storage / invoke | 37 |
| catch body completely empty | 62 |
| catch logs only | 69 |

**Writes are the ones that matter.** A silent read failure renders an empty
panel — visible, and usually reported. A silent write failure loses data and
reports success.

### The `.rpc(` over-count, stated rather than smoothed over

`.rpc(` is classified as a write because most RPCs here mutate, but
`current_app_role`, `esign_signer_suggestions`, `presence_day` and
`lead_tags_list` are reads. **52 is high by roughly 4–5; the real write exposure
is about 47.** The distribution below is unaffected.

## Writes, ranked

### `admin/lead-detail.html` — 38 of 52

Three quarters of the write exposure is one file.

**Empty catch, borrower data — the worst shape:**

| line | call |
|---|---|
| `:6675` | `contacts.update(patch)` |
| `:10330` | `contacts.update({ liabilities })` |
| `:10361` | `activity_events.insert(...)` |
| `:19261` | `contacts.update(patch)` — Places pick |
| `:19270` | `mortgage_applications.update(address…)` — Places pick |
| `:24963` | `closed_deals.upsert(dealPatch)` |
| `:15437` | `rpc esign_signer_suggestions` (a read) |

A failure at these is indistinguishable from success at every level: no
exception, no log, no toast — and the field keeps showing what was typed,
because the DOM is never re-read from the row. `:19261`/`:19270` are the pair
the Places consolidation standardised on, so an address that silently does not
persist is live today.

**Logs only (visible in devtools, invisible to the user):** `:7753`, `:9489`,
`:10805`, `:11413`, `:11514`, `:11520`, `:11552`, `:11590`, `:11615`, `:11624`,
`:12085`, `:12798`, `:13813`, `:14828`, `:18722`, `:24414`, `:24806`, `:28465`,
`:28490`, `:28572`, `:28582`, `:28624`, `:28701`, `:28731`, `:28800`, `:28822`,
`:33898`, `:33909`, `:35983`, `:36026`, `:38816`.

Includes the four `loan_liabilities` / `loan_income` / `loan_assets` /
`loan_reo` **delete** paths and their update siblings — the 1003 editor.

### Everywhere else — 14 sites, 11 files

| file:line | call | catch | note |
|---|---|---|---|
| `admin/power-dialer.html:842` | `rpc contact_set_dnc` | empty | **compliance — fixed 2026-08-15, see below** |
| `admin/people.html:2729` | `contact_notes.insert` | empty | the note on a new lead, 3 lines above the task insert that started this |
| `public/down-payment-assistance.html:1629` | `dpa_leads.insert` | logs | public lead capture |
| `public/down-payment-assistance.html:1694` | `newsletter_subscribers.upsert` | logs | |
| `admin/js/notif-bell.js:212` | `rpc notification_mark_read` | empty | |
| `admin/js/presence.js:56,79` | `rpc presence_beat` / `presence_day` | empty | |
| `admin/guideline-ai.html:880` | `storage remove` | empty | |
| `admin/lenders.html:2177` | `storage remove` | empty | |
| `admin/va-help.html:222` | `storage remove` | empty | |
| `admin/js/inbox.js:2425` | `storage remove` | empty | |
| `admin/js/auth-guard.js:255` | `rpc current_app_role` | logs | a read |
| `auth/admin-login.html:256` | `rpc current_app_role` | empty | a read |
| `admin/people.html:3733` | lofty co-borrower resolve | logs | |

## Reads — 42

`admin/lead-detail.html` ×37 · `admin/people.html` ×2 ·
`admin/guideline-ai.html` ×1 · `admin/lenders.html` ×1 ·
`components/admin-dashboard.js` ×1.

Lower priority by construction: these degrade to an empty panel.

## Auth / storage / invoke — 37

`admin/lead-detail.html` ×16, then 20 files with one or two each. Unclassified
because the failure mode varies — a swallowed `auth.getUser()` is very different
from a swallowed `storage.download()`.

## Fixed so far

- **`admin/people.html`** — the task insert, as part of surface 2.
- **`admin/power-dialer.html:842`** — `contact_set_dnc` on a "wrong number"
  disposition. Not a UI defect: the empty catch was followed by
  `showToast('Logged: …')` and `advance(true)`, so a Do-Not-Call request that
  was never recorded looked identical to one that was, and the person stayed
  callable. `markDNC()` at `:618` in the same file already did this correctly —
  that path was the outlier.

## Agreed order for the remaining 130

1. The six empty-catch borrower-data writes in `lead-detail.html`:
   `:6675`, `:10330`, `:19261`, `:19270`, `:24963`, `:10361`
2. `admin/people.html:2729`
3. the rest

## Why the count is not the whole story

`465` blocks and `299` correct ones means the codebase mostly gets this right.
The failures cluster: one file holds 38 of 52 writes. So this is not a habit
that needs retraining everywhere — it is a small number of places, mostly one
page, where a pattern was copied before the `{ error }` semantics were
understood.

The scanner is at `scratchpad/swallow-audit.mjs`. It is heuristic — it decides
"checked" by looking for `.error`, an `{ error }` destructure or a `throw`
anywhere in the enclosing `try`. That can call a block correct when the check
belongs to a *different* call in the same block, so the true number is likely
slightly **higher** than 131, not lower.
