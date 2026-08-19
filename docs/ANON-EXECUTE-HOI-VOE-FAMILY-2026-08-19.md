# `hoi_quote_list` anon EXECUTE — audit, before touching anything

**Nothing was changed by this audit.** Frontend-first, and no guard this pass.
The grants stand exactly as they were found.

---

## The immediate question: every caller, and what identity each sends

`hoi_quote_list` has **exactly one caller in the entire tree.**

| caller | identity sent | notes |
|---|---|---|
| `admin/lead-detail.html:14097` — `lpHoiLoadList()` | **session JWT** via `_authClient()` | the only one |

`_authClient()` (`admin/lead-detail.html:5751`) returns `window._supabaseClient`,
the session-aware client `auth-guard.js` mounts. supabase-js sends
`apikey: <anon>` plus `Authorization: Bearer <session access token>`. The page is
gated by `auth-guard`, so anyone reaching `lpHoiLoadList` is signed in.

Every other match in the tree is prose, a comment, or a `.db-observe` capture:

```
.db-observe/capture-2026-08-{16,17,18,19}.json   observer snapshots
admin/lead-detail.html:13693,13697,14088,14443   comments / a variable name
tools/render-check.mjs:1428                       a comment
```

**No edge function calls it.** No cron calls it. No Worker route calls it.

### Does anything legitimately anonymous read it?

**No.** There is no borrower-facing or public surface for HOI quotes at all —
`grep -rl "hoi_quote\|hoi-quote"` across `*.html`/`*.js` returns nothing outside
`admin/lead-detail.html` and the tooling. `public/` contains no reference to
`voe_`, `hoi_quote`, `loan_order_set` or `quote_reply_match`.

So the anon grant serves **no caller**. It is not load-bearing.

---

## What an anonymous caller actually gets — measured, not reasoned

Read-only probe, anon key only, no session, against a real contact:

```
POST /rest/v1/rpc/hoi_quote_list   {"p_contact_id":"599b4b4a-…"}
apikey + Authorization: <anon key, the one printed in every page>

RETURNED 4 quote request(s) to an ANONYMOUS caller
  company=Farmers        agent=John Le             email=johnle.agency@gmail.com        phone=7147475184
  company=AAA Insurance  agent=Michelle Rodriguez  email=Rodriguez.Michelle1@ace.aaa.com phone=7145932295
  company=EZ Insurance   agent=Jesus Tetatzin      email=jesus@ezinsurance123.com        phone=7147549030
  company=tester Insurance agent=Benjamin Duarte   email=rduarte89@yahoo.com
  activity events on row 1: 1
    from=processing@ratesandrealty.com
    subj=Homeowners Insurance Quote Request — Daniel Garcia
```

**It is not only vendor contact details.** The `activity` array carries the email
subject, and the subject carries **the borrower's name**. Same shape as the
`borrower-drive` finding: an endpoint that reads as "internal reference data"
disclosing a borrower's identity to an anonymous caller.

Blast radius today: **11 quote requests across 4 contacts**, all 11 carrying an
agent email, 5 carrying thread activity.

The gate is knowing a `contact_id` uuid. Not guessable — but uuids are not
secrets either: they sit in `lead-detail.html?id=<uuid>` URLs, and therefore in
browser history, referrer headers and anything pasted into a message.

---

## This is not one function. It is the whole family.

Checked with `has_function_privilege('anon', oid, 'EXECUTE')` across the
HOI/VOE/quote/order surface — **24 of 25 are anon-executable**, and almost all
are `SECURITY DEFINER`, which means they run as the definer regardless of RLS:

**Reads**
`hoi_quote_list`, `hoi_quote_meta`, `loan_orders_for_contact`, `voe_activity`,
`voe_borrower_auth_request`, `voe_email_get`, `voe_employer_options`,
`voe_form_get`, `voe_prefill`, `voe_orders_awaiting_reply`,
`order_document_status`

**WRITES — the sharper half**
`hoi_quote_log` (both overloads), `hoi_quote_select`, `hoi_quote_set_thread`,
`loan_order_set`, `voe_form_set`, `voe_request_log`, `voe_request_sent`,
`voe_set_thread`, `voe_log_inbound`, `voe_log_unauthorized_send`,
`quote_reply_match`, `voe_match_reply`

`loan_order_set` creates and updates loan orders. `voe_form_set` replaces the VOE
form template URL. `hoi_quote_select` picks the winning quote and writes
`loan_contacts`.

**I did not probe any of the writes.** The grant is authoritative that `anon`
may execute them; confirming it would mean performing an anonymous write against
production, and there is no rollback through PostgREST. That is a deliberate gap
in this report, not an oversight.

### The one that is already closed — and it is the evidence that matters

`hoi_quote_prefill` is the **single** member of the family with
`anon_can_execute = false`. Probed:

```
POST /rest/v1/rpc/hoi_quote_prefill  (anon)
  {"code":"42501","message":"permission denied for function hoi_quote_prefill"}
```

It is called from **the same page, in the same modal, through the same
`_authClient()`** — `admin/lead-detail.html:13980`, twenty lines from the
`hoi_quote_list` call — and the HOI quote modal works.

**So the frontend-first question for `hoi_quote_list` is already answered by a
working control in production.** A session-only grant is sufficient for this
caller, demonstrated, not predicted. It also shows the anon grant was never a
decision: one function got restricted and its neighbours did not.

---

## What a fix would look like (NOT done)

The narrow change is one line, and it is safe by the control above:

```sql
revoke execute on function public.hoi_quote_list(uuid, boolean) from anon;
-- and from PUBLIC, which is the grant that actually makes it reachable:
revoke execute on function public.hoi_quote_list(uuid, boolean) from public;
```

**Note the second line.** `proacl` showed `=X/postgres` — an EXECUTE grant to
`PUBLIC`. Revoking `anon` alone would change nothing, because `anon` inherits the
`PUBLIC` grant. That is exactly the "the pin is not an access control" shape from
CLAUDE.md: a change that looks like it closes the hole and does not. Whatever is
done here must be **re-probed anonymously afterwards**, not inferred from the
`revoke` succeeding.

Doing it one function at a time would also be a false sense of closure while 23
siblings stay open. The honest sequence:

1. Confirm no caller anywhere sends only the anon key (done for
   `hoi_quote_list`; **not** done for the other 23).
2. Revoke from `PUBLIC` **and** `anon` together, per function.
3. Re-probe each anonymously and require `42501`.
4. Exercise the page paths that call them, with a real session.

Order matters most for the write functions, because a caller that turns out to
have been relying on the anon path fails **silently** on a write — several of
these are called in `try{}catch{ console.warn }` blocks in `lead-detail.html`.

---

## Recommendation

Treat this as its own pass, not a tail on the vendor work. The reads are a
disclosure; the writes are the part that can change borrower records, and
`loan_order_set` and `voe_form_set` are the two to look at first.
