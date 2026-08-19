# Pass 1 — `loan_order_set`, and a correction to the audit that ordered it

## The correction, first, because it changes the priority

**I recommended `loan_order_set` and `voe_form_set` first on the grounds that
they can change borrower records. Both are already closed in-function.** They
were the two safest members of the family, not the two sharpest.

Measured before touching anything:

```
loan_order_set   ANON -> P0001 "staff only"
voe_form_set     ANON -> P0001 "staff only"
```

The previous audit established the *grant* correctly — `anon` may EXECUTE — and
I said explicitly that I had not probed the writes. Probing them shows the grant
is not the whole story: an in-function role check runs after it, and it holds.

Swept across the whole family, and then confirmed by anonymous probe rather than
by reading the regex's answer:

| | count | verdict |
|---|---|---|
| **writes** | **11 of 11** | **every one GUARDED** — `staff only` |
| reads with a guard | 6 | refuse |
| reads genuinely open | **6** | return data to anon |

`voe_employer_options` was classified "no guard" by pattern-matching the source
and in fact refuses with `not authorized` — a false negative in my own
classification, caught only because every entry was probed. That is the reason
the probe step is not optional.

## The finding that should reorder the pass

The open set is entirely on the READ side, and two of them chain. Both calls
below are anonymous, read-only, and use nothing but the public anon key:

```
STEP 1  quote_reply_match  {"p_from_email":"johnle.agency@gmail.com"}
        -> {"kind":"hoi","row_id":"d4c75b44-…",
            "contact_id":"599b4b4a-…","matched_by":"address_unique"}

STEP 2  hoi_quote_list     {"p_contact_id":"599b4b4a-…"}
        -> 4 quote requests
           subject: "Homeowners Insurance Quote Request — Daniel Garcia"
```

**The input is an insurance agent's email address** — public business
information, printed on the agent's own website. Not a uuid, not a secret.

This removes the one mitigation the earlier audit leaned on. I wrote that a
`contact_id` is "not guessable"; that is true and no longer relevant, because
`quote_reply_match` hands one out to anybody who knows an address it has seen.
It is an oracle that maps agent/HR email → borrower contact_id, and
`hoi_quote_list` turns that into the borrower's name plus every agent's contact
details on the file.

The genuinely open six: `hoi_quote_list`, `quote_reply_match`, `voe_match_reply`,
`hoi_quote_meta`, `voe_form_get`, `order_document_status`.

## What was done to `loan_order_set`

### Callers, and what each sends

**Seven call sites, all in `admin/lead-detail.html`, all via `_authClient()`**,
which returns the session-aware client `auth-guard.js` mounts — so the request
carries `Authorization: Bearer <session JWT>`. **No edge function, cron or
Worker route calls it**; `gmail-inbox` mentions it only in a comment.

### How each caller reports failure

The earlier audit warned these sit in `try{}catch{ console.warn }` blocks.
**For `loan_order_set` that is wrong — none of them do.** Six of seven surface
the message:

| line | function | on failure |
|---|---|---|
| 14982 | `lpVoeToggleDontNeed` | toast **with the message** |
| 14998 | `lpPayoffToggleDontNeed` | toast **with the message** |
| 16004 | `lpVoeSave` | **`⚠` only — the message is DISCARDED** |
| 16220 | `_lpPdResolveTarget` | rethrows; caller paints `⚠ <message>` inline |
| 17023 | `lpOrderSave` | `⚠` + `console.error` + toast with the message |
| 17045 | `lpOrderPatchFields` | `⚠` + `console.error` + toast with the message |
| 21436 | escrow snapshot `commit` | `alert('Could not save.' + message)` |

The one to know about is **`lpVoeSave` (16004)**: `catch(e){ _lpVoeSaved(k,'⚠'); }`.
It is not silent — a `⚠` appears where `Saved ✓` would — but it throws the reason
away, so a permission denial looks identical to a network blip. Not fixed here;
it is a caller change, not a grant change, and this pass was frontend-first in
the other direction.

### The revoke, and why it took two lines

```sql
revoke execute on function public.loan_order_set(…) from public;
revoke execute on function public.loan_order_set(…) from anon;
```

`proacl` carried `=X/postgres` — an EXECUTE grant to **PUBLIC**, which `anon`
inherits. **Revoking `anon` alone would have changed nothing while returning
success.** `authenticated` holds its own explicit grant and is untouched.

### Proof, both directions, re-probed and not inferred

```
BEFORE   ANON    P0001 "staff only"                         (in-function guard)
         SESSION "dc010e75-3f4a-4f33-9942-6ea8d5d9face"      works

AFTER    ANON    42501 "permission denied for function loan_order_set"
         SESSION "dc010e75-3f4a-4f33-9942-6ea8d5d9face"      same id, still works
```

Final `proacl`: `{postgres=X, authenticated=X, service_role=X}` — PUBLIC and
anon both gone.

The write probes ran against the **ZZ-TEST fixture contact** only
(`aa74cc5e-…`), never a real borrower. The `loan_orders` row they created was
deleted afterwards; fixture order count back to **0**.

Page re-check after the revoke: `render-check --token --token-only` **8/8**.
Worth stating precisely — those specs render lead-detail with a real session but
do not click Save, so the evidence that the *caller path* still works is the
SESSION probe above, not the render pass. The render pass says nothing regressed.

## Recommendation for the rest of the pass

`voe_form_set` is the same picture as `loan_order_set` — guarded in-function,
grant broad — so revoking it is the same low-value, low-risk defence in depth.
Worth doing, but it is not where the exposure is.

**The six open reads are.** `quote_reply_match` and `hoi_quote_list` together are
the whole chain above and neither has any in-function check, so for those the
revoke is not defence in depth — it is the fix.

Order I would suggest: `quote_reply_match` + `voe_match_reply` (the oracles),
then `hoi_quote_list`, then the three low-sensitivity reads, with `voe_form_set`
folded in whenever convenient.

Note that `quote_reply_match` and `voe_match_reply` have **service-role callers**
(`quote-reply-poll`, `voe-inbound-poll`, both via `svcHeaders()`), so those two
need the service_role grant confirmed intact after the revoke — a detail
`loan_order_set` did not have.
