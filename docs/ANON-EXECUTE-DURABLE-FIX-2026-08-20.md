# The durable fix for anon EXECUTE — measured, and it is not the one we planned

**Nothing was changed by this investigation.** Every probe ran inside a
transaction that was rolled back; `pg_default_acl` and all 506 functions in
`public` stand exactly as they were found. Verified after the fact:
`probe_fns_left = 0`, default ACL still
`{postgres=X,anon=X,authenticated=X,service_role=X}`.

---

## Headline

`docs/STOPPED-HERE-anon-execute-2026-08-19.md` proposed the durable fix as
"a default-privilege change plus an explicit revoke in the function-creation
template". **The default-privilege half does not work.** It is accepted, it
reports success, and it leaves new functions anon-executable.

Worse: the natural way to write it — revoke `anon` from the default — produces a
function whose ACL no longer mentions `anon` and which `anon` can still execute.
That is a catalogue audit's blind spot, deliberately created.

---

## 1. `ALTER DEFAULT PRIVILEGES … REVOKE … FROM PUBLIC` is a no-op

Both candidate statements, then a `CREATE`, inside one rolled-back transaction:

```sql
create function public.zz_probe_before() returns int language sql as $BODY$ select 1 $BODY$;

alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from public;

create function public.zz_probe_after()  returns int language sql as $BODY$ select 1 $BODY$;
```

| function | proacl | anon can execute |
|---|---|---|
| `zz_probe_before` | `{=X/postgres,postgres=X,anon=X,authenticated=X,service_role=X}` | **true** |
| `zz_probe_after` | `{=X/postgres,postgres=X,authenticated=X,service_role=X}` | **true** |

The `anon=X` line is gone. `=X` — the grant to `PUBLIC` — is not, and `anon`
inherits it. **Nothing was closed.**

And the `FROM PUBLIC` statement changed nothing at all. Run alone, the stored
row is byte-identical afterwards:

```
after REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC:
  {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
```

### Why

`pg_default_acl` does not store the ACL a new object gets. It stores a **delta
merged on top of the hard-wired default**, and for functions that hard-wired
default is `{=X/owner, owner=X/owner}` — PUBLIC always has EXECUTE. The delta can
only ADD grants. There is no way to record "PUBLIC must not get EXECUTE", which
is why the revoke has nothing to write and the row does not move.

So the grant lines all over `supabase/migrations/` are no-ops (already known),
**and so is the revoke anyone would write to cancel them** (new).

### This is the `verify_jwt = true` shape, one level down

A statement that looks like an access control, succeeds, and is not one. The
specific damage is that it defeats the check: after `REVOKE … FROM anon`, a sweep
looking for `anon=X` in `proacl` reports the function clean while `anon` still
executes it. **Do not ship the `anon`-only revoke.** It is worse than leaving the
default alone, because leaving it alone at least looks as open as it is.

---

## 2. What does work — a `ddl_command_end` event trigger

We are `postgres`: not superuser, but Supabase permits event triggers. Verified.

```sql
create function public.rr_revoke_new_function_grants() returns event_trigger
language plpgsql security definer as $BODY$
declare r record;
begin
  -- Functions in public are born anon-executable and there is no way to stop it
  -- at the default-privilege level: pg_default_acl is a delta merged ON TOP OF
  -- the hard-wired {=X/owner} that always grants EXECUTE to PUBLIC, and a delta
  -- can only add. So the grant is removed after the fact, here.
  -- Recovery if this function ever breaks DDL:
  --   alter event trigger rr_revoke_new_function_grants disable;
  for r in select * from pg_event_trigger_ddl_commands() loop
    if r.classid = 'pg_proc'::regclass and not r.in_extension
       and r.schema_name = 'public' then
      begin
        execute format('revoke execute on function %s from public, anon', r.object_identity);
      exception when others then
        raise warning 'rr_revoke_new_function_grants: %', sqlerrm;
      end;
    end if;
  end loop;
end $BODY$;

create event trigger rr_revoke_new_function_grants on ddl_command_end
  when tag in ('CREATE FUNCTION') execute function public.rr_revoke_new_function_grants();
```

Measured, same rolled-back-transaction method:

| function | proacl | anon | authenticated | service_role |
|---|---|---|---|---|
| created under the trigger | `{postgres=X,authenticated=X,service_role=X}` | **false** | true | true |
| created, then `grant … to anon` | `{postgres=X,authenticated=X,service_role=X,anon=X}` | **true** | true | true |

The first row is the **same final ACL shape as the hand-revoked
`quote_reply_match`**. `authenticated` and `service_role` survive because those
come from the `pg_default_acl` delta, which is a real grant; only the hard-wired
PUBLIC and the anon line are stripped.

The second row is the point: **intentional anon access becomes an explicit,
greppable line in the migration** instead of an invisible birthright.

---

## 3. Its hazard, measured — `CREATE OR REPLACE` silently strips anon

The event tag for `CREATE OR REPLACE FUNCTION` is still `CREATE FUNCTION`, so the
trigger fires on ordinary maintenance edits. Replacing a function preserves its
ACL; the trigger then removes it.

Three observations, one transaction, with the trigger-disabled run as the control
that proves it is the trigger and not `CREATE OR REPLACE` itself:

```
1. before replace (control)      anon_can = true
2. after CREATE OR REPLACE       anon_can = false     <- silently stripped
3. replace w/ trigger DISABLED   anon_can = true
```

**Blast radius today is exactly three functions.** The entire direct-anon RPC
surface in the tree:

| function | caller |
|---|---|
| `get_cma_snapshot` | `public/cma.html:484` |
| `get_fee_sheet_snapshot` | `public/fee.html:1236` |
| `video_get_public` | `watch.html:117` |

All three are `SECURITY DEFINER` and slug-gated. Nothing else outside `admin/`,
`dashboard/` and the tooling calls `.rpc()` at all; every other anonymous surface
(lender portal, borrower portal, tours, e-sign, newsletter) goes through an edge
function on the service role and is unaffected. `current_app_role` is called
post-login and already has PUBLIC revoked.

**So the trigger needs an allowlist**, not a note asking people to remember. Three
names in an array inside the trigger function, skipped or re-granted, turns the
hazard into a declared list that a reader can see and that a recapture will
preserve — it lives inside the function body, per the recapture rule.

## 4. Its other hazard — a broken event trigger blocks ALL `CREATE FUNCTION`

If this function raises, every `CREATE FUNCTION` in the database fails, including
the one that would fix it. The inner `exception when others` covers a per-function
revoke failure; a failure outside the loop is not covered.

Recovery, and it must be written where someone panicking will find it:

```sql
alter event trigger rr_revoke_new_function_grants disable;
```

`postgres` owns the trigger, so this is always available to us. Verified: step 3
of the proof above used exactly this.

---

## 5. Scope, corrected — the old numbers were inflated by pgvector

The 502/434/252 figures counted the `vector` extension.

| | count |
|---|---|
| functions in `public` | 506 |
| …members of the `vector` extension | **118** |
| **application functions** | **388** |
| …anon-executable | **319** |
| …of those, `SECURITY DEFINER` | 251 |
| …already closed | 69 |

All 118 extension functions are owned by `supabase_admin`, are pgvector's own
type and operator functions, carry no disclosure surface, and **are not ours to
change**: we are `postgres` and not a member of `supabase_admin`, so its
`pg_default_acl` row is out of reach. Verified
(`pg_has_role(current_user,'supabase_admin','USAGE') = false`).

---

## 6. The framing correction, which matters more than any of the above

The stopping note reads as though the default change would substitute for the
one-off revokes — "worth more than 61 individual revokes".

**It is not a substitute, and neither is the event trigger. Both apply at CREATE
time only. They close zero of the 319.** They stop number 320 onward. The two
tracks are orthogonal:

- **Inflow** — event trigger. Stops new functions being born open.
- **Backlog** — revokes. The only thing that closes what already exists.

There is a consequence for how the inflow fix gets verified. Because it changes
nothing about today's system, **"the site still works" is not evidence it
landed.** The only proof is to create a function and read its ACL — which is what
section 2 does, and what a spec should keep doing.

### The backlog can be one statement, but not a blind one

```sql
revoke execute on all functions in schema public from public, anon;
grant  execute on function public.get_cma_snapshot(…)       to anon;
grant  execute on function public.get_fee_sheet_snapshot(…) to anon;
grant  execute on function public.video_get_public(…)       to anon;
```

That closes all 319 at once. **It is not recommended as a first move.** The risk
runs opposite to the audit's known false-negative problem: not a function that
looks unguarded and is, but a function that legitimately needs `anon` and did not
surface in a `.rpc(` grep — anything reached by a URL, an embed, or a caller
outside this tree. The three above are what the tree shows; the tree is not the
whole world.

If it is taken, it should be taken the way pass 2 was: applied, then **probed
anonymously over HTTPS**, and the three public pages exercised in a browser — not
inferred from the revoke succeeding.

---

## Recommendation

1. **Do not** apply `ALTER DEFAULT PRIVILEGES … REVOKE … FROM anon`. It closes
   nothing and blinds the audit.
2. **Do** ship the event trigger, with the three-name allowlist inside the
   function body and the `DISABLE` recovery line in `CLAUDE.md`. It is the only
   mechanism that makes anon access opt-in, and it is cheap and reversible.
3. **Keep the one-offs going** for the backlog, highest-value first. The event
   trigger does not retire a single one of them.
4. Revisit the bulk revoke once the trigger has been live long enough that new
   functions are provably being born closed.

---

# SHIPPED — 2026-08-20

Migration `event_trigger_revoke_new_function_grants`
(`supabase/migrations/20260820_event_trigger_revoke_new_function_grants.sql`).
Applied to production. `pg_event_trigger.evtenabled = 'O'`.

The allowlist is an **array inside the function body**, not a comment — comments
above a `CREATE` do not survive `tools/recapture-db-functions.mjs`, and this list
is the only thing standing between an ordinary edit and a dead borrower page.

## Both directions, on the real functions

Run inside a transaction that was rolled back, deliberately: direction B strips a
production grant, and `hoi_quote_meta` has not been probed or frontend-checked
yet. Proving the mechanism must not become an unplanned revoke.

| direction | function | before (control) | after `CREATE OR REPLACE` |
|---|---|---|---|
| **A — allowlisted** | `get_cma_snapshot(text)` | true | **true — survives** |
| **B — not allowlisted** | `hoi_quote_meta()` | true | **false — stripped** |

Both used `pg_get_functiondef()` to replay each function's own definition, so the
only variable is the allowlist. Direction A is the whole reason the trigger is
safe to ship; direction B is the reason it is worth shipping.

Verified after rollback: `hoi_quote_meta` anon = true again, all three
allowlisted functions anon = true, no `rr_evt_selftest` left behind.

## What happens when someone adds a fourth public RPC

**Not a failure at the point of change.** A migration that creates the function
and grants `anon` afterwards works: the trigger fires at `ddl_command_end` of the
`CREATE`, and the explicit `GRANT` runs after it. The page works, the migration
looks correct, and it is correct — for now.

The list buys survival of the **next `CREATE OR REPLACE`**, which may be months
later in an unrelated change. At that moment anon is stripped and:

| page | console | what the borrower sees |
|---|---|---|
| `public/cma.html:484` | `console.warn` | "This report is temporarily unavailable." |
| `public/fee.html:1236` | `console.warn` | "This estimate is temporarily unavailable." |
| `watch.html:117` | `console.error` | "Could not load the video." |

Two of the three log `console.warn`, and **render-check fails on `console.error`,
not `warn`** — so the harness would go green on a page that is broken for every
borrower. All three word a *permanent* permission failure as a *transient* one
("temporarily", "try again shortly"), which is the wording least likely to be
escalated.

**What actually catches it** is the `anonymous: true` specs. `/cma/<slug>` ×2 and
`/fee/<slug>` ×2 run genuinely signed-out and unstubbed against production and
assert on the RPC's real return value (`{"status":"ok",…}`), so a stripped grant
fails them outright. That is real coverage and it is why the exposure is bounded.

**`video_get_public` has no render-check spec at all.** It is the one member of
the allowlist whose breakage nothing would report. That gap should be closed with
a spec that calls the RPC, not left to the allowlist alone — the allowlist is the
thing that would have to have failed for it to matter.

## Confirmed: the backlog is untouched

```
application functions anon-executable, immediately after the trigger landed: 319
```

Unchanged. The trigger closed nothing that already exists, exactly as section 6
says it would not. `hoi_quote_list` is next.
