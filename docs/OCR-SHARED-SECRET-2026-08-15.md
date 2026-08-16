# `ocr-mms-upload`'s shared secret — RETIRED 2026-08-15

**DONE. The secret is accepted nowhere and was not replaced by another one.**
The record below is kept because the value remains in git history on every
branch, so anyone who finds it there needs to know it is dead.

**Found while removing the `?secret=` query parameter, 2026-08-15.**

## What is exposed

```
rr-cron-2026-x7k3m9pq2r5tw8z4y6h8b3n1
```

| where | line |
|---|---|
| `supabase/functions/ocr-mms-upload/index.ts` | 11, `const SHARED_SECRET = '…'` |
| `supabase/functions/sms-assistant/index.ts` | 51, `const OCR_CRON_SECRET = "…"` |
| `supabase/sql/db-functions/trigger_ocr_on_uploaded_document.sql` | 33, inside `jsonb_build_object` |

All three are **committed**, so the value is in git history on every branch and in
every checkout, and no amount of editing the working tree removes it. There is no
`OCR_CRON_SECRET` in the Supabase secret store — checked, it is not among the 45
secrets set on this project.

## Why it matters more than the query parameter did

The query parameter leaked the credential into logs. This publishes it in the
source. And the endpoint it guards is not a trivial one: `ocr-mms-upload` runs
with the service role, reads from the `borrower-documents` bucket, writes
`uploaded_documents` and `contact_notes` rows, and **sends an SMS**. Anyone
holding this string can invoke all of that.

Note also `verify_jwt = false` on this function — correct, since its callers hold
no session — which means the shared secret is the *only* control. There is no
second gate behind it.

## What was actually done — retired, not rotated

The plan below said "rotate to a new value". **That was wrong, and following it
would have re-created the defect with a different string**: the DB trigger
cannot read an edge-function env var, so a new secret would have had to be
written into `trigger_ocr_on_uploaded_document` as a literal and committed
again.

Instead the bespoke secret was removed entirely. It was never needed:

| caller | now authenticates with |
|---|---|
| `trigger_ocr_on_uploaded_document` | `internal_call_headers()` — the secret is read from the **vault** at call time and confirmed by `verify_cron_secret()`, which returns only a boolean. The credential never exists outside the database. |
| `sms-assistant` | the **service key it already held**. `requireStaff` accepts it in either header. |

That also collapses one of this project's competing cron-secret conventions —
`x-cron-secret`, `x-cron-key`, `x-internal-secret` — which is how the CRON_KEY
rotation missed three workflows.

### The three steps, and why there had to be three

A function deploy and a DB trigger change cannot land atomically. Guarding first
refuses the trigger until the trigger changes; changing the trigger first refuses
it until the function deploys. A dual-accept deploy removed the window.

| step | change | proof |
|---|---|---|
| 1 | `ocr-mms-upload` accepts legacy **or** `requireStaff` | legacy 400, `x-internal-secret` 400, no credential 403, wrong values 403 |
| 2 | trigger → `internal_call_headers()`; `sms-assistant` → service key | `net._http_response` 400 `uploaded_document_id required`; deployed `pg_proc` source contains no literal |
| 3 | legacy branch deleted | legacy secret **403**, `?secret=` **403**, trigger path still **400** |

### A FOURTH file, found by grepping for the string afterwards

`drive-folder-migrator` guarded itself with the same literal — and also accepted
it as a `?secret=` query parameter. Retiring the value in the function that
surfaced the problem would have left it opening this one, so the credential
would not have been retired at all, only relocated out of sight.

It matters more than its "v1 (one-off)" header suggests: it walks every
`contacts.gdrive_folder_id` and MOVES the folder, so the string in git history
could re-parent every borrower's Drive folder. No caller exists — repo,
`pg_proc`, `cron.job` and n8n all checked — so no dual-accept window was needed.
It is now `requireStaff(allowInternal)` and pinned in `config.toml`, which it
had never been.

**The lesson is the grep.** Three files was what the first search found because
it searched for callers of one function. The credential's blast radius is
defined by the STRING, not by the function you happened to be looking at.

Final state, measured on the live functions:

| | retired secret (header) | `?secret=` | anon key | vault `x-internal-secret` |
|---|---|---|---|---|
| `ocr-mms-upload` | 403 | 403 | 403 | 400 (accepted) |
| `drive-folder-migrator` | 403 | 403 | 403 | 200 (accepted, dry run) |

Live references to the string in `*.ts` / `*.sql`: **0**.

Still worth considering: `drive-folder-migrator` is a completed one-off with no
callers. Deleting it outright would be better than guarding it — but that is a
deployment decision, not a security fix, so it was not done unilaterally.

Step 3's probe is the one that matters: the retired value is now refused by the
live function, and the real caller's path still works — read out of
`net._http_response`, not inferred from a queued request id.

### The original plan, kept for the reasoning about ordering


Editing the literal in place breaks the callers, because a function deploy and a
DB trigger change cannot happen atomically — the same constraint
`proactive-followups` documented when it migrated off `x-cron-secret`. Steps:

1. `npx supabase secrets set OCR_CRON_SECRET=<new value>`
2. Deploy `ocr-mms-upload` accepting **either** the env value or the old literal
   (dual-accept). Behaviour-neutral; no caller is refused at any point.
3. Deploy `sms-assistant` reading `OCR_CRON_SECRET` from env.
4. `CREATE OR REPLACE` `trigger_ocr_on_uploaded_document` sending the new value.
   Prove it with a real upload through the fixture contact, and read the result
   from `net._http_response` — `cron.job_run_details` and pg_net's returned id
   both say only that the request was queued.
5. Deploy `ocr-mms-upload` again, env only, literal deleted.

**Do not skip step 2.** Guarding first refuses the DB trigger until step 4 lands;
changing the trigger first refuses it until step 5 does. The dual-accept deploy is
what removes the window.

**The old value stays compromised regardless of what the working tree says.**
Rotation is what retires it; deleting the literal is only bookkeeping.

## Proving a change here

The guard returns 403 when it refuses and 400 when it accepts and then fails on
the missing `uploaded_document_id`. That difference is what makes a probe
meaningful:

```
POST …/ocr-mms-upload            no credential      -> 403
POST …/ocr-mms-upload            x-cron-secret: …   -> 400   (accepted)
POST …/ocr-mms-upload?secret=…   no header          -> 403   (since 2026-08-15)
```

Run the probe against the LIVE build before deploying a change, so you know it
distinguishes the two paths at all. That is how the query-parameter removal was
verified: `?secret=` returned 400 beforehand, 403 after.

Do not prove this by inserting a real `uploaded_documents` row. On success the
function sends an SMS, and a fabricated document row on a real contact is the
exact failure "probes never touch a borrower's things" exists to prevent.
