# Address capture and county provenance — 2026-08-13

## Measured against the real Google API, 2026-08-13

Run from a page on the live `admin.ratesandrealty.com` origin (the Maps key is
referrer-restricted), reading the key the way the app does. These correct or
qualify things asserted earlier in the same session.

**`administrative_area_level_2` IS returned** for all three addresses tried —
`Los Angeles County` for Lancaster, **`Kern County` for California City**,
`Los Angeles County` for the Santa Clarita city-level pick. The whole capture
design rests on this and it holds. Place Details calls per selection, counted
from the network panel rather than an instrumented stub: exactly **1**.

### The provenance split reported earlier is NOT reliable

The live prediction description for Shelley's address is

```
43636 Devyn Ln, Lancaster, California, USA      <- state SPELLED OUT
```

not `…, Lancaster, CA, USA`. So the earlier classification of stored addresses
into "shape A — prediction description (`CA`)" and "shape D — assembled
somewhere else (`California`)" is **inference from string shape and does not
hold**. `2661 Doidge Avenue, Pinole, California, 94564` may well be a prediction
description too, not a different producer. Treat the A/D boundary as unproven.

What IS confirmed exactly is the pair the bug turns on:

```
description        43636 Devyn Ln, Lancaster, California, USA     no ZIP
formatted_address  43636 Devyn Ln, Lancaster, CA 93535, USA       has one
```

### "A description implies no ZIP" is a tendency, not a law

California City's description DID carry a ZIP — `8560 Eucalyptus Ave, California
City, CA 93505, USA` — because the query string typed into the box contained one.
Description content depends on what was typed. Do not build a check that treats
"has a ZIP" as proof a value came from `formatted_address`.

### Lancaster's real ZIP is 93535

Not 93534 and not 93536. Same 935 prefix, so nothing downstream moved, but the
number written down earlier in this session was wrong.

## ZIP EXTRACTION IS TESTED AGAINST A FIVE-DIGIT STREET NUMBER. ALWAYS.

Five harness faults have now produced false results in this project: a toast
captured before the page defined it, an autosave stub landing after load,
`#loanAmount` being readonly so every break test passed, and **two separate
`\d{5}` regexes matching a house number** — one in the shipped
`autoFillCountyFromAddress`, one in the audit script written to measure it, which
filed `43636 Devyn Ln` under "has a ZIP" while auditing that exact bug.

So: any ZIP extraction — in the app, in a test, in a one-off query — is run
against an address with a five-digit street number and no ZIP before its output
is believed. `18302 Saddle Crest` and `43636 Devyn Ln, Lancaster, CA` are the
canonical cases.

## Logged, NOT fixed

### `mortgage_applications.property_address_city` holds a contact UUID

One row: `contact_id = 599b4b4a-26ec-4376-a118-bff0397540a4`.

```
property_address        TBD, CA, 92704
property_address_street TBD
property_address_city   599b4b4a-26ec-4376-a118-bff0397540a4   <-- the contact id
property_address_state  CA
property_address_zip    92704
property_address_county Orange
```

Left alone deliberately: nothing here established which write put it there, and
guessing at a repair is how a second wrong value replaces a first. The county and
ZIP on the same row are correct, so nothing downstream is currently mispriced by
it. Find the writer before correcting the value.

### Two more copies of the Places component parse

`admin/lead-detail.html:29184` and `:29231` — the co-borrower current-address
blocks. They carry the same `if (!place.address_components) return;` early return
that cost the ZIP on the property field, and their own component loop.

Not consolidated in this pass because they are borrower *current* addresses: no
county is read from them and no loan limit depends on them. They are the next
two callers to move onto `RRPlaces.attachSplit`.

## The three split-prefix rows

`ZIP_TO_COUNTY` is a 3-digit table and ZIP3 areas straddle county lines, so it
resolves three stored addresses to the wrong county:

| address | prefix says | truth | limit consequence |
|---|---|---|---|
| `8560 Eucalyptus Ave, California City, CA 93505` | 935 → Los Angeles | **Kern** | **$1,249,125 asserted vs $832,750 true** |
| `2661 Doidge Ave, Pinole, CA 94564` (2 rows) | 945 → Alameda | **Contra Costa** | none — both counties are at $1,249,125 |
| `TBD, Lindsay, CA 93247` | 932 → Kern | **Tulare** | none — both at the $832,750 baseline |

**Nothing was backfilled.** Writing a county we reasoned our way to would land in
`contacts.county`, which is defined as the CAPTURED value — Google's
`administrative_area_level_2` for that exact address. Putting an inference there
would make the column lie about its own provenance, which is the failure the
column exists to prevent. Same reasoning as `recording_consent_at`.

Verified instead that the exposure is prospective, not live: no fee-sheet draft
and no share-link snapshot currently carries a county for any of these three
contacts. The California City draft exists but has an empty county and empty
address.

What closes it properly: open each lead, re-pick the address from the Places
suggestion list. That captures the true county, writes `contacts.county`, and the
fee sheet then shows a full verdict instead of COUNTY UNCONFIRMED. Lindsay's true
county (Tulare) is *already* captured on `mortgage_applications` — it is the fee
sheet that was never told.

## The rule that replaced patching the table

`ZIP_TO_COUNTY` is **closed**. Adding 935 for Lancaster is what created the
California City error; every further entry is another chance to capture a split
prefix. Legacy rows still get a fallback county from it, but that value is marked
`countySource: 'inferred'` and **an inferred county renders no
CONFORMING/HIGH BALANCE/JUMBO verdict** — only the county, the limit, a
COUNTY UNCONFIRMED chip and a line saying where it came from.

Provenance, stored on the draft/snapshot as `common.countySource`:

| value | source | verdict shown? |
|---|---|---|
| `captured` | Google `administrative_area_level_2` at address selection | yes |
| `manual` | typed or picked in the fee-sheet sidebar by a human | yes |
| `inferred` | guessed from the 3-digit ZIP prefix | **no** |
| absent | legacy blob — treated as `inferred` | **no** |
