# borrower-drive and save-document — closed 2026-08-19

Two functions, two different problems, deliberately shipped in three steps
rather than one.

## Step 1 — the disclosure, shipped ahead of everything else

`borrower-drive` had **no caller authentication of any kind**, and
`search_borrower_folder` answered a no-match by returning `all_known_folders`:
every entry of a `KNOWN_BORROWER_FOLDERS` map hardcoded in the source. Nine real
borrowers, several with the loan type in the key — `erika enciso refi`,
`isabel heloc`, `karina beltran buyer` — each with its Drive folder id.

```
POST /borrower-drive {"action":"search_borrower_folder", …}   no credential
before → HTTP 200, nine names + folder ids
after  → HTTP 200, {"found":false}, no list, no name
```

**Why this did not wait for frontend-first.** That order exists so a guard cannot
break a caller mid-flight. A disclosure with nothing in front of it has no such
risk: removing data from a response cannot 401 anybody. Holding it for a two-step
deploy would have kept nine borrowers' names public for no benefit.

### The map was also actively wrong

```js
if (key.includes(last)) return { ...val, name: key };
```

`normalize("")` is `""`, and every key contains `""`. So **a contact with an
empty last name matched the first entry in the map** — and the API default is
`auto_save = true`, which writes that folder id onto the contact. A borrower with
no surname would have been linked to a different borrower's documents.

`lead-detail` passes `auto_save:false`, so the UI never fired it. It was
reachable only by calling the function directly — which anyone could.

### What breaks without it: nine people's convenience

`contacts.gdrive_folder_id` is the real mechanism, is checked **first** in
`findOrCreateBorrowerFolder`, and is untouched — a contact with a linked folder
still resolves exactly as before. The map only ever answered "is there an
existing folder for a contact that has none linked", and only for nine hardcoded
names. Every other contact already took the create-a-folder path; now all of them
do, and `lead-detail` already renders it (`_driveRenderNotFound`).

Neither `search_borrower_folder` nor `get_drive_config` has any repo caller. The
action is kept, returning an honest negative rather than `Unknown action`.

**If folder discovery by name is wanted back**, it belongs in a Drive
`files.list` query against the Borrowers root, or in a table — not in a constant
that ages, cannot be corrected without a deploy, and is served to the public.

## Step 2 — borrower-drive, frontend-first

The write path was the serious half: `link_folder_to_contact` takes a
`contact_id` and a `folder_id` from the body and writes them onto `contacts` with
the service role. Unauthenticated, that is **anyone repointing any borrower's
document folder** at a Drive folder of their own.

Its one caller sent the **anon key**, so the guard could not land first.

1. `callBorrowerDrive` → `fnFetch` (the signed-in user's session token). Deployed
   alone. Because the function was not enforcing yet, a mistake here would have
   surfaced as a page that still works.
2. Confirmed against a **real session** by render-check spec
   *"lead-detail Drive panel calls borrower-drive as the user"* — `tokenOnly`,
   because with the stubbed client `fnFetch` throws "Not signed in" and the spec
   would pass or fail for reasons that say nothing about the guard.
3. `requireStaff(req)` landed, before `req.json()`.

`fnFetch` builds a raw fetch, so no `x-client-info` is sent and no CORS change
was needed.

## Step 3 — save-document, a drop-in

**It was never open.** It already ran `getUser(jwt)` and refused the public anon
key. What it lacked was a **role** check: any valid session passed, whatever role
it held.

That was staff-only *by accident of the user table* — `auth.users` holds three
rows and all three are staff — not by design. **The borrower portal migration is
what breaks the accident.** The moment borrowers hold `auth.users` rows, every
one of them satisfies `getUser()` and this function rotates or crops **any Drive
file by id**, including another borrower's: the id comes from the request body
and nothing checks ownership.

Both callers in `admin/lead-detail.html` already sent the session token, so the
frontend half of frontend-first was already satisfied and the guard was a
one-line change.

## Proof

Run 2026-08-19, after deploy. The **anon-key row is the one that matters**: it is
a project-signed JWT served to the world at `/api/env.js`, so it satisfies the
gateway's `verify_jwt` check. Only the in-function check can tell it from a
session — which is the whole reason a pin is not an access control.

| | no credential | public anon key | admin session |
|---|---|---|---|
| `borrower-drive` | **401** missing authorization | **401** invalid session | **200** |
| `save-document` | **401** missing authorization | **401** invalid session | **502** Drive 404 |

`save-document`'s 502 is a pass, not a failure: the file id was a deliberate
non-existent literal, so reaching Drive's 404 proves the request got **past the
guard** to the Drive lookup. A real rotate was not exercised, because that would
modify a borrower's document — the rule against probes touching a borrower's
things applies to proofs of our own work too.

Additionally, as admin: `search_borrower_folder` for `jose cruz` — a name that
was in the map — returns `found:false` and no name.

The page itself was re-checked **after** the guard was enforcing, not only
before: the `tokenOnly` spec passes with a real session against the guarded
function.

## Not touched

Tier B of `docs/` open-endpoint work — `portal-data`, `tour-public-view`,
`submit-lead`, `newsletter-signup` and the rest — have genuine anonymous
audiences. A guard there is an outage, not a fix.
