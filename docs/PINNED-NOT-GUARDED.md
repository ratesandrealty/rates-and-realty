# 19 functions that a `verify_jwt = true` pin does not protect

**Status: re-derived against production 2026-08-06. 2 of 19 now guarded
(`sms-service`, `google-drive-upload`). 17 still have no in-function auth.**

## What the 2026-08-06 re-derivation corrected

The 2026-08-04 version of this file was wrong in four ways that changed the plan.
Re-derive rather than trust a table; `tools/audit-function-guards.mjs` prints
pin-vs-guard for any slug and `tools/audit-stage-lists.mjs` is the same idea for
stage vocabularies.

1. **"Every one has `verify_jwt = true`" — 17 of the 19 were not pinned at all.**
   They were *live* at true because the CLI defaults unpinned functions to true,
   which is the same latent bug pointing the other way. Nothing held them there,
   and `tools/deploy-function.sh` refuses an unpinned slug, so none of them could
   be shipped through the wrapper. All 19 are now pinned at their live value.

2. **Tier 4 "no browser caller" was wrong for 3 of 5.** `address-autocomplete`
   (`tools/fee-sheet.html`), `loe-generate` (`admin/lead-detail.html` ×2) and
   `parse-signature` (`admin/lead-detail.html`) all have browser callers.

3. **`market-rate` is not uncalled — pg_cron job 24 `refresh-market-rate` runs it
   weekdays at 22:00 and sends the ANON key.** A staff-or-service guard breaks
   that cron silently: the exact shape of the `send-scheduled-sms` outage. The
   cron must move to the service key first. Being listed "lowest priority, no
   browser caller" hid a live dependency.

4. **The file recorded *that* callers existed but never *what they send*, which
   is the only fact that decides whether a guard is safe.** Several functions
   listed as anon-key callers were already sending the user's JWT —
   `textract-ocr` from all three `lead-detail.html` sites, `guideline-ai.html`,
   `lenders.html` and `admin-dashboard.js`, and `ocr-apply-1003`. Beware the
   inverse trap when auditing: `apikey: ANON_KEY` alongside
   `Authorization: Bearer ${jwt}` is CORRECT — apikey is the project identifier
   the gateway routes on, Authorization is the identity. A first pass that
   grepped for `ANON_KEY` anywhere near the call site mis-flagged all of these.

## Frontend half done 2026-08-06

The reason this class persisted is that there was no single place to fix a
caller: `admin/lead-detail.html` alone had **87 hand-rolled `/functions/v1/`
fetches**, each pasting its own headers. `admin/js/fn-call.js` is now that place —
`fnFetch(slug, init)` sends the signed-in user's token and **never** the anon key,
failing with a named error when there is no session.

Migrated to it: `generate-1003-pdf` (×2), `generate-cma` (×2), `pull-comps`,
`generate-deal-analysis`, `generate-mismo`, `generate-mismo-data`,
`mismo-import` (×2).

Also removed the `|| anon` fallback from `_rnrAuthHeaders()`, the shared helper
behind 19 further call sites including `property-lookup` and every
`email-service` call. It read `'Bearer ' + (jwt || anon)`, so any caller with no
session silently became anonymous. It now throws a named error; all 19 sites were
checked to be inside a `try` first, and `loadReferralPartners()` — the one that
was not — had one added.

**No guard has been added to any of the 17.** That is the next step and it needs
a human to confirm the pages still work first.

## `verify_jwt = true` IS NOT A CONTROL. Read this before pinning anything as a fix.

The Supabase gateway checks only that the bearer is **a JWT signed by this
project**. It does not check *which* key, or what role it carries.

**The anon key is a project-signed JWT, and it is public.** It is printed in
`dashboard/admin.html`, `admin/*.html`, `public/*.html` — every page that talks to
Supabase ships it in the source. So:

```
POST /functions/v1/sms-service   Authorization: Bearer <public anon key>
  → 400 {"error":"to_phone required"}     ← reached the function's logic
```

That is `sms-service`, pinned `verify_jwt = true` on 2026-08-03 **specifically to
close it**, with a `config.toml` comment stating that the pin was the protection.
It never was. With a valid `to_phone` that request sends an SMS from the business
line.

This has now been re-derived three times in one session — on
`communications-admin`, on `calendar-data`, and on `sms-service`. Hence this file.

**The only control is an in-function check.** Either:

- a **session guard** — `getUser()` on the caller's token, then a role lookup in
  `auth_user_roles`. See `communications-admin` (`requireAdmin`), `calendar-data`
  (`requireStaff`, roles `admin|agent|loa`), `esign` (`requireAdmin`).
- a **token-based guard** for surfaces with no session at all — a credential held
  in a row and validated in-function. See `lender-portal` / `lender-upload`
  validating `lenders.form_token`.

A pin still matters — it stops a deploy silently flipping the value — but it is a
**stability** control, not an access one.

---

## The 19

Every one has `verify_jwt = true` and **no in-function auth of any kind**:
no `requireAdmin`, no `getUser`, no role lookup, no signature check, no shared
secret, no service-key comparison.

### Tier 1 — borrower documents. Do these first after `sms-service`.

| function | browser callers | exposes | guard |
|---|---|---|---|
| **`google-drive-upload`** | `admin/lead-detail.html`, **`auth/index.html`** | writes files into borrower Drive folders | session |
| **`textract-ocr`** | `admin/guideline-ai.html`, `admin/lead-detail.html`, `admin/lenders.html`, `components/admin-dashboard.js` | reads borrower documents out of storage for OCR | session |

These read and write **borrower documents**. They rank above the
document-*generation* functions below, which mostly assemble a PDF from data the
caller supplies.

### Tier 2 — borrower-facing. These CANNOT take a session guard.

| function | browser callers | why |
|---|---|---|
| **`submit-showing`** | **`public/search-homes.html`**, **`public/unified-portal.html`** | Borrowers have no Supabase session. A session guard 401s every real showing request. Needs the `lender-portal` treatment: a row-held token validated in-function, or a captcha/rate-limited public endpoint with no read surface. |
| **`sms-service`** *(partly)* | **`public/unified-portal.html`** ×2 | Those two calls notify **Rene** of tour changes at a hardcoded number, and send **no auth header at all**, so they have been 401ing since the pin. They should move SERVER-SIDE rather than gain a token — page JS able to reach an SMS endpoint is the wrong shape whatever guards it. |

### Tier 3 — staff surfaces, session guard applies

| function | browser callers | exposes |
|---|---|---|
| **`sms-service`** | `admin/email-marketing.html` ×2, `admin/js/staff-chat.js`, `admin/lead-detail.html` ×5 | **sends SMS from the business line** — the highest-impact of all 19 |
| `mismo-import` | `admin/lead-detail.html`, `admin/people.html`, `dashboard/admin.html` | imports a MISMO file into contacts / loan tables |
| `insights-data` | `admin/insights.html`, `dashboard/utils/insights.js` | BI endpoint — aggregates across the whole CRM |
| `ocr-apply-1003` | `components/admin-dashboard.js` | writes OCR results onto a 1003 |
| `generate-1003-pdf` | `admin/lead-detail.html` | renders a borrower's 1003 |
| `generate-cma` | `admin/lead-detail.html` | CMA from comps |
| `generate-deal-analysis` | `admin/lead-detail.html` | deal analysis PDF |
| `generate-mismo` / `generate-mismo-data` | `admin/lead-detail.html` | MISMO export |
| `property-lookup` | `admin/lead-detail.html` | property data lookup (paid upstream) |
| `pull-comps` | `admin/lead-detail.html` | comps pull (paid upstream) |

### Tier 4 — no browser caller. Lowest priority, still unguarded.

`address-autocomplete` (proxies Google Places — paid upstream, so an open proxy
is a spend risk), `loe-generate`, `market-rate`, `parse-signature`,
`showing-actions`.

---

## Method for each

The order is not optional — it is in `CLAUDE.md` and was learned by breaking
`email-service` with it reversed:

1. **Audit BOTH caller sides first.** Browser AND internal. `esign` calls
   `email-service` with `apikey` and no `Authorization`; an Authorization-only
   check 401s it silently.
2. **Frontend first.** Point every browser caller at the session token, remove any
   `|| ANON_KEY` fallback (it authenticates nobody and turns a clear failure into
   a mystery 401), deploy, and have a human confirm the page still works.
3. **Then the guard**, before `req.json()` so a later action is covered by default.
   Accept the service key from `Authorization` **or** `apikey`.
4. **Then the four proofs**, reported individually: unauthenticated → 401,
   **anon key only → 401** (the case the pin was believed to cover), valid session
   → works, service key → works.

## Related silent breaks from the same pin

Pinning `sms-service` to `true` on 2026-08-03 broke three callers that send no
auth header. All three are **latent, not realised** — checked 2026-08-04:

| caller | what it sends | missed since the pin |
|---|---|---|
| `public/unified-portal.html` tour reschedule | SMS to Rene | **0** — no showing rescheduled since |
| `public/unified-portal.html` tour cancel | SMS to Rene | **0** — no showing cancelled since |
| `listing-alert-actions` `listing_alert_created` | SMS to the borrower | **0** — no listing alert created since (1 exists, from April) |

Nothing was lost. All three still need fixing, because the next occurrence would
be lost and nothing would report it.
