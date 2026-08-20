# HOI conversation view — A, B, C. Report before building.

**No code changed.**

One premise needs correcting up front, because it changes all three answers:
**there is no single shared renderer.** There are three distinct things —

| surface | what renders it |
|---|---|
| HOI card "Email activity" | `_lpHoiActivityHtml` (`lead-detail:14336`) — a **text summary**: direction, subject, 160-char preview. No HTML body, no images. |
| lead-detail email reader | its own `srcdoc` iframe (`lead-detail:~15894`) |
| Communications inbox | `inbox.js` — a separate reader with its own sanitiser and inline-image resolution |

`lead-detail.html` does load `inbox.js`, but only to mount a thread list. The two
readers do not share body-rendering code.

---

## A. LAYOUT — where the width comes from

**Not the card, and not the panel. Both are unconstrained:**

```
#lpHoiQuotes          margin-top:8px            no width
.lp-card              padding:16px 18px         no width  (lead-detail:2783)
.ld-tab-panel         padding:28px 28px 60px    no width  (lead-detail:599)
```

So the **activity list is already full width**. It *reads* as a narrow column
because it is a compact summary — `font-size:10.5px`, subject and preview only —
not because anything constrains it. Widening the container will not change how it
looks; it is the content that is small.

**The composer is different: it has a fixed value.** `lpHoiEnsureModal`
(`lead-detail:~13866`) builds its own overlay with

```
width:100%;  max-width:680px
```

That 680px is the narrow column in the composer.

### Does widening affect the VOE reader or Email Threads?

**No.** The modal is HOI-specific — its own element `#lpHoiOverlay`, built by
`lpHoiEnsureModal`, used by nothing else. VOE has a separate composer, and Email
Threads is `inbox.js`. Changing 680px touches HOI only.

**So the honest framing:** widening the composer is a one-value change with no
blast radius. Widening the *reader* is not a width problem at all — if the goal is
to see message bodies inline on the HOI card, that means giving the card a real
reader, which is section C.

---

## B. SIGNATURE — the prefix is in the DATA, and one path doubles it

### Where it is composed

Two functions, both in `lead-detail.html`, both prepending:

```js
:13844  _lpHoiSignatureHtml()   nd.push('NMLS #'+lpEsc(String(s.nmls)));  nd.push('DRE #'+…)
:13858  _lpHoiSignatureText()   nd.push('NMLS #'+s.nmls);                 nd.push('DRE #'+s.dre)
```

### What the stored value actually is

`hoi_quote_meta()` reads `public.email_settings` (one row, updated 2026-07-09):

```
signature_nmls = "NMLS #1795044"
signature_dre  = "DRE #02035220"
```

**The prefix is already in the data.** Prepending produces
`NMLS #NMLS #1795044 · DRE #DRE #02035220`.

How it got there is visible in the same file: the settings form labels the input
**"NMLS #"** (`lead-detail:39703`), so the value typed into a field already
labelled `NMLS #` was `NMLS #1795044`.

### How many outbound paths carry it — ONE

| site | prepends? | outbound? |
|---|---|---|
| `_lpHoiSignatureHtml` :13844 | **yes** | **YES — the HOI quote-request send at :14018** |
| `_lpHoiSignatureText` :13858 | yes | no — preview only (`lpHoiUpdatePreview`, :13862) |
| `_lpVoeSigText` :15309 | yes | **no — DEAD CODE, called nowhere** |
| `_lpVoeDefaultBody` :15324 | **no** | yes (VOE to HR) — correct |
| `lead-detail` :39290, :39757 | no | settings preview — correct |
| `email-service` :459 | no | passes the stored value through — correct |
| `inbox.js`, `settings.html` | no | — correct |

**Correction to the brief: HR contacts are NOT affected.** VOE mail is composed by
`_lpVoeDefaultBody`, which carries this comment:

```js
// broker.nmls already carries the "NMLS #..." prefix — do NOT prepend "NMLS " again.
```

**This exact bug was already found and fixed in the VOE path, and the HOI path was
not updated.** That is the whole defect.

### Blast radius — measured, not estimated

```sql
outbound HOI quote requests                              16
  …since the signature was stored with prefixes (07-09)  15
  …whose body contains "NMLS #NMLS #"                    12
  …whose body contains "DRE #DRE #"                      12
first send 2026-06-17 · last send 2026-08-19
```

**12 real emails to insurance agents carry the doubled prefix.** They are sent; the
`email_log` bodies are the record.

### Which half to fix — the TEMPLATE, not the data

Tempting to strip the prefix from `email_settings`. **That would break four
renderers that are currently correct**, because they display the stored value
verbatim: `lead-detail:39290`, `:39757`, `email-service:459` and the settings
preview would render `1795044 | 02035220` with no label at all.

So: **delete the `'NMLS #'` and `'DRE #'` prepends from the two HOI functions.**
Two lines. The data stays as it is, which is also what the VOE path already
assumes.

Worth doing at the same time: the settings form label should stop saying `NMLS #`
if the value is expected to contain it, or the field should be normalised on save.
Right now the label invites exactly the value that is stored.

---

## C. IMAGES — they do NOT render in this reader

### `cid:` resolution exists in exactly one place, and it is not this one

`inbox.js` has a full implementation — `resolveInlineImages`, `hasCidRefs`,
`CID_SRC_RE` — which fetches inline parts through `get_attachment` and rewrites
`src="cid:…"` to **blob: URLs** before setting `srcdoc`. It is called from one
site, `inbox.js:3171`.

**`lead-detail.html` has none of it.** Its reader sets

```js
if (f) f.srcdoc = wrap(split.main || html);
```

with no rewrite. Every `cid:` hit in `lead-detail.html` is a variable named `cid`
holding a **contact id** — unrelated.

**So an inline image in a message opened from the lead page renders as a broken
image with its alt text** ("image0.jpeg"), while the same message in the
Communications inbox renders correctly. Signatures — mostly a table of `cid:`
logos — appear to vanish there, which is the exact symptom `inbox.js` documents
having fixed on its own side.

The HOI card is further back still: `_lpHoiActivityHtml` renders a 160-character
text preview and no HTML at all, so no image can appear regardless.

### Past the 3MB cap — broken, not silently dropped

```js
var INLINE_MAX = 3 * 1024 * 1024;   // per image; a signature logo is ~10-80KB
…
if (p.size && p.size > INLINE_MAX) continue;
```

A part over the cap is skipped, so its `cid:` src is **left untouched** and the
browser shows a broken image. `inbox.js` says so deliberately: *"the rewrite leaves
its cid: alone and it degrades to the broken-image it was — one logo failing must
not take out the message body."*

**Nothing is silently dropped.** The failure is visible, which is the right
direction.

**One real gap:** the guard is `if (p.size && …)`. **A part that reports no `size`
bypasses the cap entirely** and is fetched whatever its true size. Gmail normally
supplies `size`, so this is latent rather than active — but the cap is not the
bound it appears to be.

Sanitisation is not implicated: `inbox.js:70` explicitly allows `cid:` and
`data:image/(png|gif|jpe?g|webp);base64,` in `ALLOWED_URI_REGEXP`.

---

## What each of these is, if built

| | change | risk |
|---|---|---|
| **B** | delete two prepends | trivial, and it stops a licence number being printed twice on outbound mail |
| **A** | raise `max-width:680px` on the HOI composer | trivial, HOI-only |
| **C** | give the lead-detail reader the `cid:` resolution `inbox.js` already has | real work — it needs the `get_attachment` path, the blob cache and the pre-`srcdoc` rewrite; the honest version is to extract `inbox.js`'s implementation rather than write a second one |

**B first.** It is two lines, it is already wrong on 12 sent emails, and it is the
only one of the three that affects what a third party receives.
