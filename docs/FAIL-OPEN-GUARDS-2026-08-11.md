# The `auth.role() = 'authenticated'` fail-open — 72 functions

Closed 2026-08-11. Started as "fix the SECURITY DEFINER seven"; the seven turned
out to be six, and to be instances of a pattern that opened **46 functions to
unauthenticated callers**, including three deletes and a staff roster.

## The bug, in one line

```sql
if auth.role() = 'authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
```

An **anon** caller's `auth.role()` is `'anon'`, not `'authenticated'`. The
condition is false, the guard never runs, and execution falls through to the
body. So the guard refused signed-in non-admins and waved through anyone with no
session at all — and **the anon key is a project-signed JWT printed in every
page's source**, exactly as `docs/PINNED-NOT-GUARDED.md` says of `verify_jwt`.

It reads like a guard. It is the inverse of one for the caller who has least
right to be there.

## Demonstrated, not argued

Before, over real HTTP, against `/rest/v1/rpc`, with the public anon key:

| RPC | anon result before |
|---|---|
| `vendor_directory_delete` | **HTTP 200** — delete any vendor row by id |
| `loe_delete` | **HTTP 204** — delete any letter of explanation |
| `loe_void` | **HTTP 204** — void any LOE |
| `va_task_delete` | **HTTP 200** — delete any VA task |
| `vendor_directory_list` | **HTTP 200** — the whole vendor directory |
| `team_roster` | **HTTP 200** — staff user_ids, handles, roles, **emails** |
| `dashboard_snapshot`, `production_report` | **HTTP 200** |

Each returned `false`/empty only because the probe used ids that matched
nothing. The permission check is what was missing, not the effect.

After, same probes, same key: `admin only` / `not authorized` / `staff only`
(P0001) or `permission denied for function` (42501). Every one.

## The fix

One mechanical rewrite across all 72 functions carrying the idiom:

```sql
if auth.role() = 'authenticated' and not (…)     -- before
if coalesce(auth.role(),'') is distinct from 'service_role' and not (…)   -- after
```

**Behaviour-identical for every legitimate caller**, which is why it could be
applied wholesale rather than one at a time:

| caller | before | after |
|---|---|---|
| `authenticated` | guard applies | guard applies |
| `service_role` (edge functions) | guard skipped | guard skipped |
| `anon` / anything else | **guard skipped** | guard applies → raises |

No function's role set was touched. `loe_delete` still says `admin only`;
`vendor_directory_list` still allows `va, loa, agent, lender, staff`.

## The six that had no guard at all

Reported in `OPEN-ITEMS-2026-08-11b.md` §3 as seven. `voe_prefill` had been
guarded since — correctly, and with a non-fail-open shape — so six remained.

**Guarded** (browser-called, so they need a check rather than a revoke), via a
new shared `require_staff_rpc()` that asks the positive question:

- `get_lead_people` — the widest. Returns email, phone, secondary_phone,
  **date_of_birth AND ssn_last4** for a named contact and everyone connected to
  them, from a bare contact id. Worse than the report recorded, which said DOB.
  Changed `LANGUAGE sql` → `plpgsql` solely so a guard can run before the query;
  the query is unchanged.
- `hoi_quote_prefill` — DOB, email, phone. Same treatment.

**Revoked** (no browser calls any of them; verified by grepping the whole
frontend). Two are trigger functions — triggers run as the table owner and need
no EXECUTE grant, so revoking cannot stop them firing — and two are helpers
called by edge functions with the service key, which keeps its grant:

- `is_phone_suppressed` — returns a boolean, so it looks harmless. It is an
  **oracle**: it confirms whether a given number belongs to a given contact,
  which is precisely the fact `mask_phone` exists to withhold.
- `app_notify_mentions`, `sync_application_to_contact`,
  `tg_loan_contacts_sync_directory`

## No regressions

Verified by calling as each role with the JWT claims set:

- **va** — `vendor_directory_list`, `team_roster`, `va_task_list`,
  `loe_list_for_lead`, `get_lead_people`, `hoi_quote_prefill`: all ok
- **admin** — `dashboard_snapshot`, `order_tracker`, `loe_void`: all ok
- **service_role** — `vendor_directory_list`, `is_phone_suppressed`,
  `hoi_quote_prefill`, `loan_order_set`: all reached the body

**render-check cannot verify any of this** and was not used for it: the harness
stubs the Supabase client, so no RLS, grant or in-function check is exercised —
the boundary it prints on every run. The evidence here is role-simulated direct
calls plus live HTTP probes with the real anon key.

## Two things this does not fix

**`vendor_directory` still has no audit trail.** Separate finding — see below.

**The pattern will come back** unless something watches for it. The idiom is
gone from all 72, but nothing stops the seventy-third being written the same
way by copying a neighbour. A cheap check: fail a lint if any
`SECURITY DEFINER` function in `public` contains
`auth.role()` compared with `'authenticated'`.

---

# vendor_directory has no audit trail (read-only finding)

Asked and answered, not built.

**Who can call `vendor_directory_delete`?** Admin-only *by intent* — and, until
today, **anyone**, per the fail-open above. Now genuinely admin-only, plus
`anon` revoked.

**Does anything log it?** No. `audit_log` has **zero** `vendor_directory` rows
ever, and the table has **no triggers at all**.

**How many rows have been deleted historically?** *There is no way to tell.* No
audit rows, no soft-delete column, no sequence to gap-check (ids are uuids). The
only historical copy in existence is
`public.vendor_directory_fragments_20260811` — the snapshot taken during the
fragment work, 48 rows. Everything before that is unknowable.

Two rows disappeared between that snapshot and the fragment delete an hour
later — `41361ced` (Charly Daoud) and `330bfcca` (Laura Ramos, created 19:00
the same day). No record of who or why. They were almost certainly Rene tidying
up after reading the fragment report, but *almost certainly* is the whole
problem.

## The minimum recorder

`contacts` already has the shape to copy: `fn_contacts_delete_recorder`, a
`BEFORE DELETE` trigger that writes one `audit_log` row and — the part that
matters — **cannot block the delete**:

```sql
create or replace function public.fn_vendor_directory_delete_recorder()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  begin
    insert into public.audit_log (table_name, row_id, operation, old_data, new_data, changed_by)
    values ('vendor_directory', OLD.id::text, 'DELETE_OBSERVED', to_jsonb(OLD),
      jsonb_build_object(
        'recorded_by','fn_vendor_directory_delete_recorder',
        'auth_uid',    auth.uid(),
        'db_user',     current_user,
        'route_hint',  case
                         when auth.uid() is not null then 'session via PostgREST'
                         when current_user = 'service_role' then 'service role (edge function)'
                         else 'DIRECT DB — not through the app'
                       end),
      auth.uid());
  exception when others then
    raise warning 'vendor_directory delete recorder failed for % (%)', OLD.id, sqlerrm;
  end;
  return OLD;
end $$;

create trigger trg_vendor_directory_delete_recorder
  before delete on public.vendor_directory
  for each row execute function fn_vendor_directory_delete_recorder();
```

Three properties worth keeping from the contacts version:

1. **A RECORDER, NOT A GATE.** It never raises. A logbook that can refuse a
   delete is a new failure mode on a working path — the same principle as
   `recordRun()` in `gdrive-health-monitor`.
2. **`route_hint`** distinguishes "through the app" from "someone at a psql
   prompt", which is the question you actually ask when a row vanishes.
3. **`to_jsonb(OLD)`** stores the whole row, so a delete is reversible by hand.

**Cost:** one row in `audit_log` per vendor delete. `vendor_directory` is 31
rows and deletes are rare, so this is effectively free.

**Not built — Rene wanted the shape first.**
