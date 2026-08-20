# `contacts_live` — the revoke, the full view sweep, and what evidence exists

## 1. The revoke holds

Probed anonymously across every shape that could leak something, including the
count-only path that returns data in a header rather than a body:

```
?select=*&limit=1                    HTTP 401  42501
?select=id&limit=1                   HTTP 401  42501
?select=count                        HTTP 401  42501
?select=first_name,email&limit=1     HTTP 401  42501
Prefer: count=exact, Range: 0-0      HTTP 401           (no Content-Range emitted)
```

`borrower_qualifying_snapshot` likewise 42501. The three slug-gated public RPCs
still answer 200.

## 2. The earlier sweep was NOT all views — it was the anon-selectable subset

Stated plainly because it matters: the twelve came from a query filtered on
`has_table_privilege('anon', …, 'SELECT')`. **There are 13 views in `public`.** The
thirteenth was never anon-selectable and so never appeared.

Re-swept across **all** views, joining through `pg_rewrite`/`pg_depend` to find
which base tables each one actually reads and whether those tables carry RLS:

| | count |
|---|---|
| views in `public` | **13** |
| `security_invoker` ON | 6 |
| **DEFINER (bypasses RLS)** | **7** |
| …of those, reading at least one RLS-enabled table | **5** |
| …of those five, still anon-selectable | **3** |

### The five DEFINER views over RLS tables

| view | anon | RLS tables behind it | anon result when probed |
|---|---|---|---|
| `contacts_live` | **revoked** | `contacts` | was **1046 rows** — the finding |
| `borrower_qualifying_snapshot` | **revoked** | `contacts`, `loan_income`, `contact_notes` | was the full book |
| `contacts_secure` | yes | `contacts` | `[]` |
| `contacts_secure_live` | yes | `contacts` | `[]` |
| `mortgage_applications_secure` | yes | `mortgage_applications` | `[]` |

**The three still open return nothing only because of their own predicates**, which
key on `auth.uid()` — null for anon. That is a WHERE clause, not a grant. They are
the same configuration that made `contacts_live` dangerous; `contacts_live`
differed only in having no such predicate. One careless edit to any of them
reproduces the incident.

The other two DEFINER views (`contact_fk_catalogue`, `crm_health`) read no
RLS-bearing table. `crm_health` was revoked anyway as a denial-of-service surface.

The six `security_invoker` views (`leads`, `earnings_summary`, `partner_earnings`,
`portal_user_summary`, `showing_requests_crm`, `v_showing_tours`) are anon-selectable
but RLS applies, so anon gets nothing. That is the correct arrangement.

## 3. Was it ever read? — there IS evidence, and it is better than the logs

Edge/API log retention is 24 hours, so those are useless for a view that may have
been exposed for months. **`pg_stat_statements` is the artifact that survives**, and
it records the role each statement executed as — PostgREST issues its generated SQL
after `SET ROLE`, so an anonymous read appears with `userid = anon`.

```
pg_stat_statements installed, stats_reset = 2026-05-07 19:17:31Z   (3.5 months)
statements mentioning contacts_live: 20
```

| executed as | distinct statements | total calls |
|---|---|---|
| `service_role` | 10 | 22 |
| `postgres` | 8 | 11 |
| **`anon`** | **2** | **3** |
| `authenticated` | 1 | 1 |

**The three anon calls are mine.** Both statements were first seen at
**2026-08-20 08:16:31Z**, half a second apart — my own sweep in this session (the
probe loop issued the plain select twice, then the count variant once):

```
calls 2   stats_since 2026-08-20 08:16:31.114664+00   SELECT contacts_live.* … LIMIT $1 OFFSET $2
calls 1   stats_since 2026-08-20 08:16:31.611088+00   … , pgrst_source_count AS …
```

`borrower_qualifying_snapshot` is the same story: only anon entries first seen
2026-08-20 08:15:06Z. Its legitimate traffic is `authenticated` (7 calls since
2026-06-16 — `admin/qualifying.html`).

### So: no evidence of any anonymous read other than my own. Four caveats.

1. **`pg_stat_statements` evicts.** It holds 4,881 of a 5,000 maximum. A rarely
   executed statement can be aged out, so absence is weak evidence, not proof.
2. **Its window starts 2026-05-07.** Anything before that reset is invisible, and
   the view is older than that (see below).
3. **It counts statements, not clients.** It cannot distinguish two anonymous
   callers running the same shape, and it records no IP or timestamp per call.
4. **It only sees queries that reached the database.** That is the right scope
   here — a successful read had to reach it — but it says nothing about probing
   that was refused earlier.

**The honest conclusion: within 3.5 months of statement history, the only
anonymous reads of either view are the ones I made today. That is meaningful
evidence of non-exploitation, and it is not proof.**

## 4. The structural finding underneath it

**`contacts_live` has no `CREATE VIEW` statement anywhere in this repository.**

```
$ grep -rniE "create (or replace )?view\s+(public\.)?contacts_live" .
  NONE
```

Eight committed db-functions *read* it — `dashboard_command_center`,
`dashboard_snapshot`, `va_dashboard`, `va_processing_board`, `partner_leads`,
`partner_overview`, `pipeline_velocity_report`, `production_report` — but nothing
creates it. Nor is it in `supabase/migrations/`. So it cannot be dated from git,
and the exposure window cannot be bounded from the repo.

More generally: **the repo captures 389 Postgres functions in
`supabase/sql/db-functions/` and ZERO views.** `tools/recapture-db-functions.mjs`
reads `pg_proc`; nothing reads `pg_class` for `relkind in ('v','m')`.

This is the same shape `CLAUDE.md` documents for edge functions — *"production
holds source the repo has never seen"* — which cost 85 days on `email-service`.
The drift check was built because that mattered. **Views were never brought into
it, and the one that leaked the whole contact book is precisely a view the repo
has no record of.**

### Recommendation

1. **Capture views**, the way functions are captured — a `recapture-db-views.mjs`
   writing `pg_get_viewdef` per view into `supabase/sql/db-views/`, including the
   `reloptions` so `security_invoker` is visible in the diff.
2. **Add a grant assertion to the observer**: any view that is DEFINER, reads an
   RLS-enabled table, and is anon-selectable should fail a check. All three
   conditions are queryable; that combination is exactly this incident.
3. Revoke anon on `contacts_secure`, `contacts_secure_live` and
   `mortgage_applications_secure` — they return `[]` today by predicate, and
   nothing reads them as anon.

---

# The three `_secure` views: revoke HELD, and why

**Not revoked. Frontend-first, per `CLAUDE.md`.** These have real browser callers
and two of them send the anon key, so revoking first would be an outage — the
exact failure that gated `email-service` for twelve minutes.

Every browser call site, with the identity it actually sends:

| call site | identity | effect of a revoke |
|---|---|---|
| `admin/drip-builder.html:864` | **anon key** — `const H` at :357, never upgraded, no `getSession` in the file | **hard break** |
| `admin/email-marketing.html:791` | **anon key** — inline at the call site | **hard break** |
| `admin/communications.html:292` | session if resolved, else anon in a `catch` that logs "using anon" | breaks on a race |
| `admin/earnings-dashboard.html:334` | session if resolved, else anon in a `catch` | breaks on a race |
| `admin/lead-detail.html:30543` | `Bearer (_sjwt \|\| anon)` — falls back to anon | breaks on a race |
| `admin/lead-detail.html` (~20 sites) | `_authClient()` — session | fine |
| `admin/pipeline.html:215`, `admin/people.html` | session | fine |

## Step 1 done: the two hard breakers now send a session

- **`drip-builder`** — added `_contactsAuthHeaders()`, an async session-header
  helper with **no anon fallback**: it throws "Not signed in". Used for the
  `contacts_secure` read.
- **`email-marketing`** — the `contacts_secure` export now uses the file's
  existing `_smsAuthHeaders()`, which already throws rather than falling back.

Both pages load `auth-guard.js`, so `window._supabaseClient` is available.

The three race-prone sites were deliberately **left alone**: they already prefer
the session and only reach anon inside a `catch`. After the revoke that fallback
becomes a clean 42501 instead of a silent leak — the right direction — and
widening the diff would make the confirmation pass harder to review. They are
listed here so the confirmation covers them.

## Step 2 pending: a human must confirm the pages still work

Load and exercise, signed in:

- `/admin/drip-builder` — the contact list populates
- `/admin/email-marketing` — the audience/contact export populates
- `/admin/communications` — the call-contact search returns results
- `/admin/earnings-dashboard` — the earnings table populates
- `/admin/lead-detail` — a lead opens and the application panel renders

## Step 3, only then

```sql
revoke all on public.contacts_secure              from anon;
revoke all on public.contacts_secure_live         from anon;
revoke all on public.mortgage_applications_secure from anon;
```

`node tools/check-view-exposure.mjs` returns **exit 1** naming exactly these three
until that lands, and **exit 0** afterwards. That is the gate; it does not need a
person to remember.
