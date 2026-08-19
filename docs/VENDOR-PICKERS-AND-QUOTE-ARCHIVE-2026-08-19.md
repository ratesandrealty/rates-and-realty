# Vendor pickers and quote requests — 2026-08-19

Three items, built in the order they were asked for, because the order was the
point: close the writer before cleaning up what it wrote, or the cleanup is
undone by the next keystroke.

---

## 1. The writer, closed in both halves

### What it did

`lpVendorSaveRow` (the 💾 on a Transaction Contacts row) required **only a name
or a company** and passed whatever was in the fields. So a save with a half-typed
name and no email minted a new row every time.

The mechanism is not "the save ran too often". It is that **a name alone is not
an identity**. `vendor_directory_match` has three tiers, and the only one that
runs when the email is incomplete keys on **exact name AND exact company**. With
no company, `Alex` and `Alex Duarte` are two different vendors — so each typed
prefix matched nothing and inserted.

An earlier fix stopped a half-typed **address** being treated as an identity. It
did not stop a half-typed **name**, which is the same defect one field across.

### The fix — the loan_contacts approach, copied, not reinvented

Both halves, because either alone leaves the pickers full of prefixes:

**RPC** — `vendor_directory_upsert`, **both overloads** (8-arg `p_role` and 9-arg
`p_category`; this function genuinely has two, unlike the accidental overloads
the CLAUDE.md trap describes):

```sql
if not v_email_ok and nullif(trim(coalesce(p_company,'')),'') is null then
  raise exception 'A vendor needs a complete email address or a company name. …';
end if;
```

**Frontend** — the button refuses before calling:

```js
if(!name && !company){ … 'Add a name or company first.' … }
if(!company && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)){ … }
```

A guard is not a licence to keep calling the RPC while somebody types, and a
frontend check is not a control — hence both.

### Proof

Through PostgREST with a real admin session. A raw SQL session was tried first
and was **invalid**: `auth.role()` is null there, so all three cases raised
`not authenticated` and said nothing about the guard.

```
MUST BE REFUSED — name only ....... P0001 "A vendor needs a complete email…"
MUST STILL WORK — company, no email  inserted 763497e9…
                — email, no company  inserted 4cdc883d…
PREFIX CASE     — "ZZ-TEST WithEmail Longer", same email
                                     SAME id 4cdc883d  ← deduped, not a new row
```

The last line is the one that matters: the exact shape that used to mint a second
row now collapses onto the first.

### The fragments — reported, checked, then deleted

**23 rows, not 6.** The six `hoi_agent` ones were the reported set. Sweeping the
same predicate across all roles found **17 more**, the identical defect in the
**loan_contacts** pickers rather than the HOI one.

The 17 are eight exact prefix/full-name pairs, and the timestamps settle any
doubt about whether they were deliberate separate entries:

| pair | seconds apart |
|---|---|
| Rony → Rony Velasquez | 2 |
| Danielle → Danielle Brandenburg | 9 |
| Samantha → Samantha Castro | 2 |
| Kathy → Kathy Otero | 3 |
| Bayani → Bayani Arcangel | 1 |
| Rosie → Rosie Quattrocchi | 2 |
| Cody → Cody Younger | 5 |
| Sonia → Sonia Apodaca | 3 |

One person typing, saved twice. Plus one unpaired `listing_agent_tc` "Samantha".

Every one of the 23 carried **no email, no phone and no company** — a name and
nothing else. So deleting them loses no information that a re-save cannot supply,
and under the new guard a re-save now has to supply it.

**References checked before removing any**, and re-checked *inside the delete
transaction* rather than only beforehand — a separate earlier query is a snapshot,
and a save landing between the two would have orphaned a row:

```
loan_orders.vendor_id .......... 0
hoi_quote_requests.vendor_id ... 0        (loan_orders.vendor_id is the only FK)
refused_because_referenced ..... 0
deleted ........................ 6, then 17
```

Snapshots committed before deletion:
`snapshots/vendor-directory-fragments-20260819.json` and
`snapshots/vendor-directory-fragments-loan-contacts-20260819.json`.

`vendor_directory` went 66 → 43. The real `Alex Duarte` (`alex@tdgsells.com`) was
deliberately **not** in the set — it has a complete email and is matchable.

---

## 2. The HOI picker sort — fixed in one picker, missed in the other

### Why they diverged

Measured from git, not inferred:

- `lpHoiRecipSearch` was written **2026-07-07** (`d4c72f7`), with its three-tier
  `hoi_agent` → `hoi` → all-roles fallback and no sort.
- The Orders picker got exact-role-first on **2026-08-11** (`8277b4e`), a month
  later, in a commit about the appraisal-row incident — the all-roles fallback
  listing a title officer and two realtors under an "Appraisal Company" badge.
- **`8277b4e` never touched `lpHoiRecipSearch`.** `git show … | grep lpHoiRecip`
  returns nothing.

So: fixed in one, missed in the other. Not a deliberate difference.

### The fix

The same stable sort, mirrored:

```js
rows = rows.slice().sort(function(a,b){
  const am = (a && a.role === 'hoi_agent') ? 0 : 1;
  const bm = (b && b.role === 'hoi_agent') ? 0 : 1;
  return am - bm;
});
```

Without it, once the fallback fires the list is every role mixed together in
usage order, so the actual insurance agent can sit fourth behind a title officer.

### Any other caller with the same gap?

**No.** `vendor_directory_search` has exactly **two** call sites in the entire
tree (`admin/`, `dashboard/`, `components/`, `api/`, `supabase/functions/`), and
they are the two pickers above. Both now sort.

### Noted while there: the `hoi` tier is dead

`vendor_directory` holds no row with role `hoi` (measured: `hoi_agent` 7, no
`hoi` at all). That middle tier has never returned a row. Kept as the
legacy-vocabulary net and commented as measured-empty — it costs a round trip
only when `hoi_agent` has already come back empty.

---

## 3. Archive a quote request

### The column

`hoi_quote_requests.archived_at timestamptz`, plus a partial index on
`(contact_id) where archived_at is not null`.

**Not a status value.** "Not pursuing" is something *we* decided; "declined" is
something the *agent* did. A row can be both or neither, and folding the first
into `status` would destroy the second — the same conflation that already cost
twice here (`recording_disposition` stamped at dial time, `transcript_status`
before it had its own vocabulary).

### Filtered at DISPLAY, and nowhere else

`hoi_quote_list(p_contact_id, p_include_archived boolean default false)`.

The filter is in this function on purpose. **`quote_reply_match` does not read
`archived_at` and must not.** A reply that arrives after you have given up is
precisely the one worth surfacing; filtering at MATCH time would silently drop
it, which is the failure mode this whole area keeps rediscovering.

`DROP` then `CREATE`, not `CREATE OR REPLACE` — adding a defaulted parameter
mints a second overload and every existing one-arg call keeps hitting the old
body forever. Grants were captured first and restored explicitly, because the
drop takes them with it:

```
before  hoi_quote_list(uuid)          {=X, postgres, anon, authenticated, service_role}
after   hoi_quote_list(uuid,boolean)  {=X, postgres, anon, authenticated, service_role}
```

Recapture writes **one** file, which is the detection for an accidental overload.

### PROOF — correlation survives archiving, both directions

An archived ZZ-TEST request, then every tier of the ladder in the order the
poller tries them:

```
PROOF — archived row cf2a6518…
  tier 1 in_reply_to ..... matched_by=in_reply_to     row_id_correct=t
  tier 2 thread .......... matched_by=thread          row_id_correct=t
  tier 3 token ........... matched_by=token           row_id_correct=t
  tier 4 address_unique .. matched_by=address_unique  row_id_correct=t
  hoi_quote_list(cid) ......... 0 rows   <- archived EXCLUDED
  hoi_quote_list(cid,true) .... 1 rows   <- archived INCLUDED
```

`0 rows` alone would also be what an **over-broad** filter returns, so the
control matters as much as the proof — two identical rows, one archived:

```
CONTROL — one live row + one archived row
  hoi_quote_list(cid) ....... 1 rows  (the LIVE one only)
  hoi_quote_list(cid,true) .. 2 rows
  default call returned the live row: t
```

Both run-and-rollback. 0 fixtures left behind, 0 archived rows in production.

### The UI

- **Archive / Restore** button on each card. Offered on the winner too — a
  selected quote can still be one you stop chasing, and hiding the control there
  would make un-selecting the agent you went with the only way to tidy the panel.
- Archived cards are **dimmed, not recoloured**, and carry an `ARCHIVED` marker.
  Archived is not a state of the request: the status chip still reports what the
  agent did, the dimming reports that we stopped chasing. Two facts, two
  channels — the same reason `archived_at` is not a status value.
- **`Show archived (N)` / `Hide archived`** beside the heading. The heading count
  counts what is on screen; the toggle says how many are withheld, so the two
  numbers cannot disagree about the same set.
- The count is a separate `head` request, because `hoi_quote_list`'s contract is
  a jsonb **array** and every caller treats it as one.
- Not persisted. "Show me the ones I gave up on" is something you do once to find
  something, not a mode to come back to tomorrow.
- **The empty-list early return was a bug waiting to happen.** `if(!rows.length)
  return` would paint nothing — no toggle — for a contact whose every request is
  archived, making them unreachable from the page that archived them. It now
  bails only when there is genuinely nothing.

---

## Left alone, as instructed

**Payoff and VOE.** Nothing to sort, and whether servicers belong in the
directory is a separate decision.

## Found, not acted on

`hoi_quote_list` is `SECURITY DEFINER` and grants **`anon`** EXECUTE. An
anonymous caller holding a contact uuid could read that contact's quote requests
— agent names, agent emails, thread previews. This predates today's work and the
grants were restored exactly as found rather than tightened, because narrowing
access as a side effect of an unrelated build is how a page breaks with nobody
expecting it. Frontend-first applies if it is closed: audit callers, then land
the change. Worth a deliberate decision.
