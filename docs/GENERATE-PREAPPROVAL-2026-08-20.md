# `generate-preapproval` — report before building

**No code changed. No guard landed, per instruction.**

---

## 1. Every caller, and the identity each sends

**There is exactly one caller in the entire tree.**

| caller | identity sent |
|---|---|
| `admin/lead-detail.html:30464` | **the anon key**, hardcoded at the call site |

```js
var anon = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_ANON_KEY) || '';
var res = await fetch(base+'/functions/v1/generate-preapproval', {
  method:'POST',
  headers:{'Content-Type':'application/json','Authorization':'Bearer '+anon,'apikey':anon},
  body: JSON.stringify(payload)
});
```

No edge function calls it. No cron calls it. No Worker route calls it. The only
other mentions in the repo are a comment in `lead-scorer` and the `config.toml`
pin.

## 2. Does anything legitimately anonymous generate a pre-approval?

**No.** `public/apply.html` mentions pre-approval letters four times, all in
marketing copy ("Most clients get a pre-approval letter the same day") — it does
not call the function. There is no borrower-facing or portal path. The sole caller
is a staff page behind `auth-guard`; it simply sends the wrong credential.

**So the anon key is not load-bearing here.** Same shape as `hoi_quote_list`: a
staff-only surface reachable anonymously by accident, not by design.

## 3. Is `requireStaff` a drop-in? — No. It needs the frontend move first.

Dropping `requireStaff(req)` in today would **401 the Generate Pre-Approval button
immediately**, because the only caller sends the anon key and `requireStaff`
rejects it (the anon key is not the service key and carries no user session).

The frontend move is small and the pattern already exists in the same file:
`exportMISMO()` uses `fnFetch`, which sends

```
apikey:        <anon>            // project identifier the gateway routes on
Authorization: Bearer <session>  // the signed-in user
```

and **throws `Not signed in — cannot call <slug>`** when there is no session, so it
fails closed rather than falling back. Converting the call site to
`fnFetch('generate-preapproval', {...})` is the whole of step 1.

**Order, not compressed:**

1. Convert `admin/lead-detail.html:30464` to `fnFetch`.
2. Have the Generate Pre-Approval button exercised on a real lead and the PDF
   confirmed.
3. Then `requireStaff(req)` **before `req.json()`**, and flip `verify_jwt`.

## 4. What the function is today

```ts
Deno.serve(async (req: Request) => {
  if (req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  const body = await req.json();
  const pdfBytes = await buildPDF(body);
```

- **No authentication of any kind** — no `requireStaff`, no `requireAdmin`, no
  `getUser`. Straight from `Deno.serve` to `req.json()`.
- `verify_jwt = false` in `config.toml`.
- **It reads nothing from the database.** Every figure on the letter comes from the
  request body.

That last point decides what kind of finding this is. It is **not a disclosure
surface** — a caller learns nothing they did not already supply. It is a
**document-generation surface**: anyone holding the public anon key can produce a
Rates & Realty pre-approval letter for any borrower name, property and loan
amount, carrying Rene Duarte's name and **NMLS 1795044**, plus the company name and
NMLS 1416824.

**And it has side effects on real records.** Using a caller-supplied `contact_id`
it fires, fire-and-forget:

- `clickup-auto-create` with `trigger_type: 'approval_letter'` — creates a ClickUp
  task against that contact
- a lead-score event worth **10 points** (`preapproval_generated`)

So an anonymous caller can also move a real borrower's lead score and litter a real
ClickUp list, without generating anything anyone sees.

## 5. Does the letter carry a DTI computed from `loan_income`? — Yes

`admin/lead-detail.html` (~:30388):

```js
var totalIncome = _lsNum('ls_total_monthly_income');
var totalDebt   = _lsNum('ls_total_monthly_debt');
var frontDTI = totalIncome ? (pitia/totalIncome*100) : 0;
var backDTI  = totalIncome ? ((pitia+totalDebt)/totalIncome*100) : 0;
…
front_dti:frontDTI, back_dti:backDTI, total_income:totalIncome, total_debt:totalDebt,
```

`ls_total_monthly_income` is filled by `renderBorrowerIncomeDebtCards` from the
**live sum of active `loan_income` rows**. So the letter's DTI is downstream of the
duplication bug.

### What a reader of such a letter would have seen

**Correcting my own earlier wording:** I said "roughly half the true value". That
holds for Garcia and **overstates Santana**, whose inflation factor was 1.48×, not
2×. The precise picture:

| file | inflated window | letter would show (back DTI) | true | understated by |
|---|---|---|---|---|
| **Garcia** | 2026-08-19 → 2026-08-20, **~1 day** | **23.10%** | 45.31% | 22.2 pts |
| **Santana** | 2026-05-21 → 2026-06-04, **14 days** | **42.17%** | 62.21% | 20.0 pts |

Both directions matter:

- **Garcia's exposure window is about one day.** The duplication only existed once
  the second import ran on 2026-08-19; before that he had a single set summing to
  14,224.94. A letter dated before 08-19 was not affected by this bug.
- **Santana's ran 14 days** and her factor was 1.48×, because only Jose Navarro's
  Base was triplicated — not the whole household.

A reader — a listing agent, a seller, an underwriter — would have seen a borrower
comfortably inside every programme limit. At 45.31% Garcia is still inside
Conventional; **at 62.21% Santana is outside all three** (Conv ≤50, FHA ≤57,
VA ≤55). So for Santana specifically, a letter issued in that window would have
presented as qualified a file that, on the figures now in the system, is not.

**Whether any letter was actually generated is unknowable.** `generate-preapproval`
persists nothing — no `uploaded_documents` row, no storage object, no audit entry —
exactly the gap the MISMO export had until `mismo_export_log` was added today. The
PDF is returned as base64 and downloaded by the browser.

`pg_stat_statements` cannot help either: the function reads **nothing** from the
database, so it leaves no query behind to count.

## 6. Recommendation

1. **Frontend move first** — one call site to `fnFetch`. Then confirm. Then guard.
2. **Guard with `requireStaff(req)` before `req.json()`**, and pin
   `verify_jwt = true` once the caller sends a session.
3. **Stop trusting the body for `contact_id` side effects.** The ClickUp task and
   the lead-score event should key on a contact the *authenticated user* is
   entitled to touch, resolved server-side — not on whatever the caller typed.
4. **Give it an export log**, the same one row `mismo_export_log` now gets. A
   document carrying an NMLS number that leaves no trace it was ever produced is
   the same unanswerable question, on a more consequential artifact.

Item 4 is the one that would have made section 5 a query rather than an
inference.

---

# SHIPPED — 2026-08-20: frontend move + letter log. Guard still held.

## Step 1 done

`admin/lead-detail.html` no longer sends the anon key. The call is now
`fnFetch('generate-preapproval', …)` — the same helper `exportMISMO` uses twenty
lines away — which sends `apikey:<anon>` as the project identifier plus
`Authorization: Bearer <session>`, and **throws `Not signed in`** when there is no
session rather than falling back.

**`verify_jwt` is still `false` and there is still no `requireStaff`.** The
function accepts anyone exactly as before; what changed is that the legitimate
caller now identifies itself, so the guard can land later without an outage.
Confirm the button, then the guard.

## `preapproval_letter_log` — the row that was missing

One row per letter: who, when, which contact, and **the DTI the letter stated**
with the inputs that produced it (`total_income`, `total_debt`, `total_pitia`), so
a wrong ratio is diagnosable rather than inferred. RLS on, staff read,
service_role insert, anon revoked and asserted.

Attribution is **best-effort, not a guard**: the function resolves the bearer
token to a uid via `/auth/v1/user` and records `null` if it cannot. It never
refuses. The write never blocks the PDF but logs loudly on failure.

Proven end to end against the **ZZ-TEST fixture** (not a real borrower — this path
fires ClickUp and lead-score hooks):

```
success=true  pdf_bytes=242,864
log row: ZZ-TEST Fixture Borrower · generated_by 7ac68068-… (real uid)
         loan 500,000 · front_dti 28.5 · back_dti 36.25
         income 10,000 · debt 775 · pitia 2,850 · Conventional · 740
```

---

# Should the letter RECOMPUTE the DTI, or accept what the caller sends?

Asked rather than assumed. **Neither, wholly — the split is the answer.**

## Why "accept what the caller sends" is wrong

Today every figure comes from the request body, so the PDF states whatever the
page was holding, including a ratio computed from **inflated income** (Garcia,
Santana), a ratio from a **scenario disagreeing with the application** by up to
184,799 on six live files, and — with no guard — **any ratio a caller types**, on
letterhead carrying NMLS 1795044.

A pre-approval letter asserts a fact about a borrower. Sourcing that from an
unverified request body is the wrong shape regardless of who is calling.

## Why "recompute everything" is also wrong

Loan amount, rate, term, taxes, insurance and HOA are **the offer being quoted**,
and quoting a structure that differs from the saved application is legitimate and
routine. Forcing re-derivation would either freeze the letter to the stored
scenario or reintroduce the scenario-vs-application choice the MISMO export just
had to be taught to refuse — and would make a function that currently reads
nothing from the database read five tables.

## The split: the OFFER is the caller's, the BORROWER is the server's

| supplied by the caller | derived server-side |
|---|---|
| loan amount, rate, term | `total_income` — sum of **active** `loan_income` |
| taxes, insurance, HOA, MI | `total_debt` — non-payoff `loan_liabilities` |
| loan type / programme | **`front_dti`, `back_dti`** from that PITIA and that income/debt |
| property, occupancy, purpose | borrower name, credit score from the record |

PITIA stays a function of the caller's structure — that is the quote. **The ratio
stops being a claim the page makes and becomes one the system stands behind.**

Two consequences to accept deliberately:

1. **The letter's DTI may differ from the panel's.** That is the point: the panel
   is a scratchpad, the letter is a document. The letter should win, and say so.
2. **A borrower with no structured income cannot get a letter with a ratio.**
   Omitting the DTI block beats stating a fabricated one.

## Order

Server-side derivation must know **which** contact the caller may act on, and
`contact_id` is currently trusted from the body for the ClickUp and lead-score side
effects too. So:

1. ~~frontend move~~ *(done)*
2. confirm the button
3. `requireStaff(req)` before `req.json()`, and `verify_jwt = true`
4. resolve `contact_id` against the authenticated user
5. **then** move income, debt and the ratio server-side

Steps 3–5 are one coherent change. The log added today is what will show whether
step 5 alters any ratio in practice.
