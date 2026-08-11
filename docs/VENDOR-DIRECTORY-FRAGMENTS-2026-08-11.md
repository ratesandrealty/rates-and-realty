# vendor_directory fragments — 16 rows, 8 people

Read-only diagnosis, then the fix. **No fragment has been deleted** — Rene
confirms the list first. Snapshot taken before anything was changed:
`public.vendor_directory_fragments_20260811` (48 rows).

## What fired the save, and why it INSERTed

`lpSaveContact()` in `admin/lead-detail.html` was bound to `onchange` on the
loan-contact **phone and email** inputs, so it ran on every blur. As a
best-effort side effect it called:

```js
vendor_directory_upsert({ p_id: null, … p_email: g('email') … })
```

`p_id: null` means "find or insert". The RPC then de-duped like this:

```sql
(v_email is not null and lower(email) = v_email)
or (v_email is null and name+company match)
```

**The de-dupe key was the email — the very field being typed.** Each
keystroke-prefix is a different string, so it is a different identity, so it
inserts. The user's own diagnosis was right: upserting on a key that changes as
you type. Not the wrong overload — **both overloads had the same rule.**

`onchange` fires on blur, not per keystroke, which is why the fragments are
prefixes at plausible pause points rather than one row per character.

## The fragments

`vendor_directory` held 48 rows; **16 are fragments across 8 people.** A row is
a fragment when another shares its `(name, phone)` and its email/company is a
prefix of the other's.

| person | keep | fragments to delete |
|---|---|---|
| **Raul Lirio** (661) 822-2010 | `Raul.Lirio@titlegroup.fntg.com` · Chicago Title · 4 uses | `4f54f06e` raul.Lirio@titlegroup.fntg · `1deec839` raul.Lirio@titlegroup · `1859af26` raul.Lirio@t · `2609fb53` raul.lirio (Chicago) · `75aba275` (no email, Chicago) |
| **Peggy Mcadams** (760) 475-0940 | `peggy@desertroserealty.net` · 6 uses | `4fce218c` peggy@ · `8d4b5e98` (no email) · `c1462eb9` (no email) |
| **Rebeca Zavala** 818 408 2101 | `rebeca@sfrescrow.com` · 3 uses | `d6c94188` rebeca@sfr · `1bd3ac76` (no email) |
| **Norberto Uriarte** 818-395-3816 | `norberto@YourTCHub.com` · 3 uses | `a6cd95d6` norberto@Your · `f0233e1c` (no email) |
| **Charly Daoud** 6614413706 | `charlyestates@gmail.com` · 3 uses | `41361ced` (no email) |
| **Katie Yoo** (571) 544-9998 | `katie.yoo@geofunding.com` · 3 uses | `194c768b` (no email) |
| **Laura Ramos** 818 272 7418 | `OGlaurar@gmail.com` · 2 uses | `7e9a66f1` (no email) |
| **Rebeca Zavala** (no phone) | `San Fernando Realty Inc.` · 2 uses | `3db5b1da` (no email, no company) |

In every case the keeper has the **highest `usage_count`**, which is its own
small confirmation: the complete row is the one people actually pick.

**The VOE vendor picker and the HOI recipient list both read this table**, so
those dropdowns have been offering `raul.Lirio@t` as a choice.

## The fix — both halves, because either alone leaves it broken

**1. The save is now an explicit act.** The `vendor_directory_upsert` call is
gone from `lpSaveContact`. Capturing a vendor is the 💾 button on the row
(`lpVendorSaveRow`). The loan-contact save still happens on blur, because it
writes one row keyed by `(contact_id, role)` and cannot fragment.

**2. The key is stable.** Matching moved into `vendor_directory_match()`, shared
by both overloads so they cannot drift, and it is ORDERED:

1. exact email — the identity, when there is a real one
2. `name+company` on a row whose email is still a **fragment**
3. `name+company` — when the incoming email is itself a fragment

Step 2 is what lets the finished address land on the row the typing built
instead of forking a new one at the last keystroke. It deliberately **never
adopts a row holding a different complete address**: two real people can share
a name and a company, and merging them would be worse than the bug.
`vendor_email_is_complete()` is the shared predicate for "a real address".

An incomplete address also never overwrites a stored complete one.

### Verified by replaying the exact sequence

The five Raul Lirio saves, against a throwaway role, plus a genuinely different
person sharing name and company:

| before | after |
|---|---|
| 5 rows, one per prefix | **1 row**, holding `Raul.Lirio@titlegroup.fntg.com` |
| — | the different person keeps **their own** row, not merged |

Probe rows deleted afterwards; `zz_test_fragment_probe` is empty.

### The limit, stated

`vendor_email_is_complete` cannot tell a real four-letter TLD from a half-typed
one — `raul.Lirio@titlegroup.fntg` passes as complete. With the frontend no
longer saving on every blur, that path needs someone to press 💾 mid-address,
which is a different and much rarer mistake.

## To clear the fragments, once confirmed

```sql
-- Rene confirms the table above first. Snapshot is
-- public.vendor_directory_fragments_20260811.
delete from public.vendor_directory where id in (
  '4f54f06e-7823-45b3-bfed-f2b691ed815b','1deec839-c8aa-4ac4-8f78-9de4248c3144',
  '1859af26-94c0-424a-a2c2-b0086be63aa8','2609fb53-d3d6-40c8-9230-9b5fa9198eb6',
  '75aba275-d47b-47e4-a341-0679549579b6','4fce218c-e023-44dc-a64d-34674fa902f3',
  '8d4b5e98-d325-4765-bd4b-07dd63823caf','c1462eb9-6a6e-455f-8176-39d1d35857f0',
  'd6c94188-b574-41c0-b4fe-61d1161f04cc','1bd3ac76-a8be-42bf-9f8c-304c152d8613',
  'a6cd95d6-80e8-43a2-91fe-a8969432dc69','f0233e1c-25f4-4992-b091-99b787524955',
  '41361ced-b4f0-4eae-b3b7-86024064b096','194c768b-f8f1-445c-8c87-fb8ae3707016',
  '7e9a66f1-7023-4015-9d3d-dbc93ba97c6e','3db5b1da-f28a-4bbf-937f-957d90d13e7b'
);
```

**Checked already, 2026-08-11: none of the 16 is referenced.**
`loan_orders.vendor_id` → 0, `hoi_quote_requests.vendor_id` → 0. So these are
litter rather than history and a plain delete is safe. Had any been referenced
it would need repointing at the keeper instead, because a fragment that was
actually ordered against is a record of something that happened.

Re-run that check at delete time rather than trusting this line — the whole
point of leaving the rows in place is that time passes before somebody confirms.
