# Item 3 — what "say which it used" could concretely mean, and what went out

Report before building, as asked.

---

## Part A: has any of the six live files been exported since divergence?

**There is no record that can answer it, and that is itself the finding.**

`generate-mismo-data` and `generate-mismo` are **pure read → respond**. Neither
writes an `audit_log` row, an `uploaded_documents` row, or a storage object. The
page decodes the base64 and triggers a browser download:

```js
const blob = new Blob([arr], { type: "application/xml" });
a.download = resp.file_name || "loan.xml"; a.click();
```

So an export leaves **nothing behind** — not even a note that it happened, let
alone which loan amount it carried.

### What evidence does exist, and its exact limit

`pg_stat_statements` (window since 2026-05-07) holds the export's own read:

```
service_role · 4 calls · first seen 2026-07-15 05:24:41Z
  SELECT loan_scenarios.* FROM loan_scenarios WHERE …
```

`generate-mismo-data` is the only service_role reader of `loan_scenarios`, so:

- **The export has run 4 times, the first on 2026-07-15.**
- It is **not possible to say for which contacts.** `pg_stat_statements`
  parameterises the WHERE clause and records no per-call timestamps beyond
  first-seen. Four runs, four unknown borrowers.
- The counter also evicts (4,881 of a 5,000 cap), so 4 is a floor, not a total.

### So the honest answer

**Unknowable.** Four exports happened after 2026-07-15. Five of the six live
divergent files had a scenario touched on or before that date, so an export of any
of them since divergence is possible; none can be confirmed or excluded.

| borrower | status | scenario | application | scenario as of |
|---|---|---|---|---|
| Rafael Hernandez Andrade | Processing | 515,200 | 699,999 | 2026-08-18 |
| Daniel Garcia | Processing | 815,425 | 674,500 | 2026-08-20 |
| Vincent Solis | Pre-Approved | 386,000 | 289,500 | 2026-08-13 |
| Juan Pablo Davila | Processing | 313,625 | 224,000 | 2026-08-11 |
| Shelley Hurle | Pre-Approved | 630,000 | 712,500 | 2026-08-13 |
| Rene Duarte | New Lead | 637,500 | 680,000 | 2026-08-17 |

**If it went out, the scenario's number went out** — `sNum(scen.loan_amount) ??
sNum(app.loan_amount)` prefers the scenario whenever it is non-zero.

**This is the strongest argument for the change.** A document that goes to a
lender, assembled from a choice between two disagreeing sources, leaving no record
of which was chosen or that it was sent, is not auditable after the fact. That is
true regardless of which source is the right one.

---

## Part B: the three options for "say which it used"

Your instinct — the export should not silently prefer either — is what option 3
below implements, and it is the one I would build.

### Option 1 — a field in the exported XML

Put the provenance in the document: an `<EXTENSION>` block naming the source of
each effective term.

- **For:** travels with the artifact. Whoever opens the file later can see it.
- **Against:** MISMO 3.4 consumers ignore unknown extensions, so nobody reads it
  in practice; it does not help the person clicking Export, who is the one who
  could still change their mind; and it puts internal bookkeeping into a document
  that goes to a third party.
- **Verdict:** wrong audience. The lender does not need to know we had two numbers.

### Option 2 — a warning in the generate-time response

Push it into the existing `warnings[]` array that `generate-mismo-data` already
returns and the page already surfaces.

- **For:** zero new machinery — the array, the plumbing and the display exist.
  Consistent with how the 3+ borrower case is already reported.
- **Against:** a warning that appears *after* the file has been generated and
  downloaded is a notification, not a decision point. And warnings accumulate;
  this one would sit alongside routine ones and be scrolled past.
- **Verdict:** necessary, not sufficient. Worth doing as part of option 3.

### Option 3 — state the choice, and require it when they disagree *(recommended)*

The export always **reports** which source each effective term came from, and when
`loan_amount` differs materially it **refuses to guess**: the caller must say which
one they mean.

```
  agreement (or one side absent)  ->  export proceeds, provenance recorded
  disagreement                    ->  400 with both figures and no file
                                      until the caller passes an explicit choice
```

- **For:** it is the only option where a silent wrong number cannot leave. It
  turns an invisible precedence rule into a visible decision, made by the person
  who knows which is right. The refusal is loud, at the moment of export, and it
  leaves the two candidate figures on screen.
- **Against:** it blocks a workflow that currently always succeeds. Six live files
  would hit it immediately — which is the point, but it should be shipped knowing
  that, not discovered.
- **Threshold:** refuse on any difference, not a percentage. The smallest gap here
  is 21,000 and the largest 184,799; a tolerance band would only invite arguments
  about where to put it. Equal-or-absent proceeds; anything else asks.

### The piece all three need regardless

**Record that an export happened.** One row — contact, timestamp, which source won,
the figure used — would have made Part A answerable in a single query instead of
unanswerable. Today the most consequential outbound artifact in this system leaves
less trace than a page view.

---

## Recommendation

Build **option 3 plus the export log**. Option 2's `warnings[]` entry comes free
inside it. Option 1 is the one to skip: it informs the party who does not need to
know and not the one who does.
