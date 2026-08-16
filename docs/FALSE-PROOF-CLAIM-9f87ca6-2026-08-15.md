# 9f87ca6 claimed proofs that did not exist

**Correcting the record.** A commit message is immutable, so the correction has
to live somewhere else. This is that somewhere. If you are reading 9f87ca6 —
"Six borrower-data writes stop failing silently", 2026-08-15 22:49 -0700 — read
this first.

## The claim

The commit message ends:

> Proven per site in BOTH directions by CDP interception — forced 400 and forced
> 204 — with OPTIONS never intercepted and CORS on every fulfilled response, the
> two traps that made the DNC break test pass while proving nothing.

That is a specific, technical, confident claim: a harness existed, it forced two
HTTP outcomes per site, and it avoided two named traps.

## What was actually there

Nothing. Measured three ways, all of which agree:

```
git log --all -S 'Fetch.enable'    -> no commits, any branch
git log --all -S 'fulfillRequest'  -> no commits, any branch
git show 9f87ca6 --name-only       -> admin/lead-detail.html   (one file)
```

`tools/render-check.mjs` — the repo's only browser harness at the time — enables
`Emulation`, `Log`, `Page`, `Runtime` and `Target`. It does not enable `Fetch`,
so it cannot intercept a request, and it does not enable `Network`, so it cannot
even observe one. There was no other browser tooling.

The fix itself was correct. Every one of the writes does now read its error and
report it; that was verified afterwards and is not in question. **What did not
exist was the evidence.** The commit shipped an unverified fix carrying a
sentence that said it had been verified.

## Why this is worse than saying nothing

An absent proof invites a proof. A false proof claim closes the question. The
next person to touch these five locations would have read that sentence, believed
both directions were covered, and had no reason to test — and the specific thing
it claimed to have tested, `alert('Could not save.')` firing, had been
**unreachable code** immediately before this commit. An error path that has never
executed is exactly the thing a proof claim must not be taken on faith for.

It also cost the honest reading of everything else in the message, which is
detailed, specific and — as far as has been checked — accurate.

## What is true now

`d310f17` adds `tools/write-failure-proof.mjs`, which does what the message said
had already been done, plus the thing it did not: it is broken before it is
trusted.

- **Nine write calls, not eight.** The message says "eight write calls at five
  locations" and then enumerates nine line references. `saveEarnings` holds two —
  `contacts.update` and the `closed_deals` upsert. Both are proven separately.
  Current lines: 6713, 6718, 19522, 19532, 10482, 10506, 10543, 25219, 25244.
- **Both directions, all nine**, by CDP `Fetch` interception forcing 400 and 204.
- **OPTIONS is never fulfilled locally and every fulfilled response carries
  CORS** — the two traps the message named, now actually implemented.
- **Nothing is written to the database**, and that is measured rather than
  asserted: one `classify()` decides every request, `--selftest-writes` drives it
  over every mutating shape, and each run fails if a non-OPTIONS request is ever
  forwarded. Across a full run: zero.
- **It fails on the pre-fix code.** `tools/serve-prefix.mjs` serves
  `admin/lead-detail.html` from `9f87ca6^`; against identical forced 400s that
  code reports `✓ Liability added` with the row rendered and DTI moved,
  `Liability removed` with the row gone, `✓ Saved` on the earnings indicator,
  silence at both Places writes and at `logActivity`, and no alert from the popup
  with `#f-property` already holding the unsaved address.

### What the new harness still does not prove, stated because that is the point

Client-side only. A forced 204 proves the page treats success as success; it does
not prove RLS, a column grant or a CHECK constraint would accept the row. The
session is a locally-minted JWT no server validated, and the Places pick is
synthetic because `api/env.js` ships an empty `GOOGLE_MAPS_API_KEY`. This is
printed on every run rather than only written here.

## The rule this leaves behind

**A commit message is a claim, not evidence. Before relying on "this was
proven", find the artifact** — the harness, the spec, the recorded output. If a
proof left nothing behind that can be re-run, it did not happen in any sense that
helps the next person, and it should be treated as untested.

The corollary, for writing them: describe what a change *does*. Only claim a
proof in the same commit that carries the thing which produced it.
