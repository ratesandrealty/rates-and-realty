# Two views were anonymously readable — the largest exposure found in this sweep

Found while verifying the `borrower_qualifying_snapshot` attribution fix. **Both
pre-existing.** Both closed the same day.

## Why this class is worse than the RPC oracles

The three function oracles closed earlier (`quote_reply_match`, `hoi_quote_list`,
`voe_match_reply`) each needed an **input to pivot on** and returned **one record
at a time**. These returned **the whole book with no input at all**.

**A view is not subject to the underlying table's RLS unless it is declared
`security_invoker`.** Neither of these was. So the tables' own protection was
intact and irrelevant — measured contrast, same key, same request shape:

```
GET /rest/v1/loan_income      ->  []          RLS holds, control works
GET /rest/v1/contacts_live    ->  1046 rows   the view walked straight past it
```

## 1. `contacts_live` — the entire contact book

```
GET /rest/v1/contacts_live?select=*        apikey = the public anon key
HTTP 200   Content-Range: 0-0/1046
[{"id":"…","first_name":"…","last_name":"…","email":"…","phone":…,
  "ssn_last4":…,"date_of_birth":…,"address":…, …}]
```

**1,046 contacts** — names, emails, phones, addresses, dates of birth, `ssn_last4`.
No uuid, no secret, no session.

**No browser caller**, so there was no frontend-first step to take:

| reader | identity |
|---|---|
| `insights-data/index.ts` | `createClient(URL, SERVICE_ROLE_KEY)` |
| `dashboard_command_center()` | `SECURITY DEFINER`, runs as postgres |
| `admin/va-people.html` | a **comment** only — it reaches contacts via an RPC |

`revoke all on public.contacts_live from anon;` → **42501**.

## 2. `borrower_qualifying_snapshot` — every borrower's income and affordability

```
GET /rest/v1/borrower_qualifying_snapshot?total_documented_monthly=gt.0&order=…
HTTP 200
[{"name":"…","total_documented_monthly":36336.71,
  "max_back_end_piti_at_50_dti":18168.36,"pipeline_status":"Closed"}, …]
```

Name, documented monthly income, affordability at 43% and 50% DTI, pipeline
status — for every contact.

Callers keep working: `admin/qualifying.html` reads through
`_waitForAuthClient()` (session JWT) and `sms-assistant` uses the service role.
Neither uses anon. The anon fallback inside `_waitForAuthClient()` now fails
closed, which is the right direction for a page of borrower income.

`revoke all on public.borrower_qualifying_snapshot from anon;` → **42501**.

## The sweep that found it, and what it left standing

Twelve views in `public` are anon-selectable. Six are **not** `security_invoker`
— the RLS-bypassing shape. Every one probed anonymously rather than reasoned
about:

| view | security_invoker | anon result |
|---|---|---|
| **`contacts_live`** | no | **1046 rows — CLOSED** |
| **`borrower_qualifying_snapshot`** | no | **full book — CLOSED** |
| `contacts_secure` | no | `[]` |
| `contacts_secure_live` | no | `[]` |
| `mortgage_applications_secure` | no | `[]` |
| `contact_fk_catalogue` | no | `[]` |
| `crm_health` | no | HTTP 500, statement timeout |
| `earnings_summary`, `leads`, `partner_earnings`, `portal_user_summary`, `showing_requests_crm`, `v_showing_tours` | **yes** | RLS applies |

The `_secure` views return nothing to anon because their own predicates key on
`auth.uid()`, which is null — they are named for what they do. `contacts_live`
has no such predicate; it is a plain "not soft-deleted" filter over `contacts`,
which is exactly why it leaked.

**`crm_health` is not cleared.** It returned a statement timeout, which is not the
same as returning nothing: an anonymous caller can make the database run an
expensive query. Low severity next to the two above, but it should be revoked or
made `security_invoker` rather than left because it happened to be slow.

## The generalisation worth keeping

**`verify_jwt`, RLS and column grants are all defeated by a view that anon can
select and that is not `security_invoker`.** This project already has three
written-down instances of "a control that looks like one and is not"; this is a
fourth, and it is the one that bypasses the others.

Any new view over borrower data should be created `WITH (security_invoker = on)`,
and `anon` should be granted `SELECT` only where a genuinely public page reads it.
Today no page does — the entire public surface goes through three slug-gated RPCs
(`get_cma_snapshot`, `get_fee_sheet_snapshot`, `video_get_public`), all verified
still answering 200 after both revokes.
