# Email composers and their toolbars — report before building

**Nothing changed.**

---

## 1. How many composers, and which share code

**`_buildEmailComposerHTML` has ONE caller, not seven.** The seven-ish number is
real but it counts *entry points into one composer*: `openEmailComposer()` is
called from **8 places** in `admin/lead-detail.html` (:1992, :6022, :14282,
:14792, :15400, :16940, :38695, :40544), and all eight open the same
`#emailEditor`.

The composers themselves are **six surfaces, five of them rich text, and they
share no editor code at all**:

| # | surface | element | opened by | toolbar |
|---|---|---|---|---|
| 1 | **Main composer** | `#emailEditor` | `openEmailComposer()` × 8 entry points | font, size, B/I/U, bullet, number, link, clear format, + Canva/Loom insert |
| 2 | **Template preview composer** | `#lpEmailBody` | `lpEmailPreview()` × 5 call sites (transaction-contact templates, HOI agent, realtor, borrower) | **NONE — no toolbar at all** |
| 3 | **Inbox composer** | `inbox.js` | Reply / Reply-all / Compose | font, size, B/I/U, lists, indent/outdent, quote, **alignment**, removeFormat |
| 4 | **Signature editor** | `#sigEditor` | `admin/settings.html` | its own: link + a generic `cmd` dispatcher |
| 5 | **Drip campaign editor** | `admin/drip-builder.html` | campaign steps | its own: link + a generic `cmd` dispatcher |
| 6 | **HOI quote request** | `lpHoiEnsureModal` | `lpHoiOpenComposer()` | **plain text — not a rich-text editor** |

Ruled out, checked individually: `guideline-ai.html`, `lenders.html`,
`partner-detail.html`, `power-dialer.html`, `assets/js/tour-builder.js` each
contain exactly one `execCommand` and it is `execCommand('copy')` — clipboard, not
editing. `email-marketing.html` has no contenteditable body; its only textarea is
`#smsBody`. Neither is a composer.

### The two that will surprise

- **`#lpEmailBody` has no toolbar.** It is a contenteditable div with a Body label
  and nothing else — five template-driven emails, including the HOI agent and the
  realtor, are composed with no formatting controls whatsoever. Adding colour to
  "every composer" means giving this one a toolbar for the first time, not
  extending one.
- **The HOI quote request is plain text.** `lpHoiUpdatePreview` does
  `p.textContent = _lpHoiBody(…)` and the body is assembled as a string with
  `\n`. There is nothing to add a colour button to; making it rich text is a
  different and larger change, and its signature/body assembly would have to move
  to HTML.

## 2. Is the toolbar one component or duplicated?

**Duplicated. Four separate implementations**, none sharing markup or a dispatcher:

```
#emailEditor      tbCmd(cmd, val)            lead-detail.html:39597
inbox composer    its own toolbar + overflow  inbox.js:1208
#sigEditor        its own cmd dispatcher      settings.html:1150
drip-builder      its own cmd dispatcher      drip-builder.html:988
```

They have already drifted: **`inbox.js` has alignment and the main composer does
not.** Adding colour/highlight/alignment "everywhere" today means writing it four
times and creating a fifth for `#lpEmailBody` — five places to keep in step,
which is the same divergence that produced the doubled NMLS prefix.

**Worth deciding first:** extract one toolbar component, or accept the copies.
Extracting is more work now and is the only version where the next control is
added once.

## 3. What survives the send — and the answer changes what to build

### Nothing is in `styleWithCSS` mode

`grep -rn "styleWithCSS"` → **no matches anywhere.** So every editor is in the
browser's **legacy mode**, where `execCommand` emits presentational HTML rather
than CSS. That is already visible in the main composer's size control:

```html
<select onchange="tbCmd('fontSize', this.value)">
  <option value="4">14</option> <option value="3">12</option> …
```

Those are the legacy 1–7 `<font size>` values, so the composer is already
emitting `<font size="4">`.

### Which means the two controls behave differently

| control | legacy mode emits | `styleWithCSS` emits |
|---|---|---|
| text colour (`foreColor`) | `<font color="#c00">` | `<span style="color:#c00">` |
| **highlight** (`hiliteColor` / `backColor`) | **no `<font>` equivalent exists** | `<span style="background-color:#ff0">` |

**Highlight has no legacy representation.** `<font>` has `color`, `face` and
`size` attributes and nothing for background. So a highlight control *must* emit
either a `style` attribute or `bgcolor`, whatever mode the rest of the toolbar is
in. There is no version of this where highlight is a `<font>` tag.

That settles the approach: **inline `style` on a `<span>`**, i.e. turn
`styleWithCSS` on for the colour commands. Mixing — `<font>` for colour, `style`
for highlight — would be the worst option, giving two representations of the same
idea for downstream clients to disagree about.

### What reaches an agent's inbox — stated with its evidence level

I can state from this codebase, measured: nothing here strips either
representation (§4). What happens **inside** Gmail/Outlook/Yahoo I cannot measure
from here, and this project's own history is the reason to say so plainly — the
`voe-form-fill` CORS bug looked fine to every server-side check for eleven days
because the failure only existed in a client nobody had run.

What is well established generally, and should be treated as a starting
hypothesis rather than a finding:

- **Inline `style` on a span** is the most broadly supported way to carry colour
  and background in HTML email, and is what Gmail's own composer produces.
- **`<style>` blocks** are stripped by Gmail and unreliable in Outlook — not
  relevant here, since `execCommand` never emits one.
- **Outlook desktop** renders through Word's engine and is the strictest of the
  three; `background-color` on inline elements is the classic casualty, and
  `<td bgcolor>` is the traditional workaround.
- **`<font color>`** is legacy HTML and very widely honoured — so text colour is
  the safe half either way; **highlight is the half at risk.**

**Recommendation: verify rather than assume.** One test message with a coloured
word and a highlighted word, sent from the real composer through the real send
path to a Gmail, an Outlook and a Yahoo address, and read on each. That is a
twenty-minute check and it converts the paragraph above from plausible to known.
Offering a highlight button that renders as nothing at the far end is exactly the
"control that lies" concern — and it is answerable cheaply.

## 4. Does anything sanitise before send? — No

**Neither send path sanitises.**

- **`email-service`** runs only `stripMarkdownFences()` on the body (`:491, :557,
  :640, :689`), which removes ```html code fences. It is not an HTML sanitiser and
  does not touch attributes.
- **`gmail-inbox` send**: no sanitisation at all — `grep` for
  `sanitiz|DOMPurify|strip.*html` in that function returns nothing on the send
  path.

So **a `style` attribute survives the send intact.** So does `<font color>`,
`bgcolor` and `align`.

### The one place sanitisation runs is paste/render, and it already allows all of it

`inbox.js`'s `PURIFY_CFG` (`:48`) is applied when pasting into the composer and
when rendering received mail. Its allow-lists already contain everything a colour
or highlight control could emit:

```
ALLOWED_TAGS:  … 'span', 'font', 'center', 'small', 'big' …
ALLOWED_ATTR:  'style', 'align', 'bgcolor', 'color', 'face', 'size', 'class' …
```

So neither representation is stripped on the way in either. **No sanitiser change
is needed for any of this** — which also means nothing currently prevents a pasted
`style` from carrying anything a `style` can carry, but that is pre-existing and
separate.

---

## Scope options, cheapest first

**A. Main composer only** — add colour, highlight and alignment to `#emailEditor`,
with `styleWithCSS` enabled for the colour commands. One toolbar, 8 entry points
benefit. Does not touch inbox, signature, drip, or the two that have no toolbar.

**B. A + inbox.js** — the two composers that actually send day-to-day mail. Two
implementations to keep in step; inbox already has alignment so only colour and
highlight are new there.

**C. Extract one toolbar component, then add the controls once** — more work now,
and the only option where the fifth control is added in one place. It also fixes
the existing drift (alignment in one composer and not the other).

**D. Everything, including a first toolbar for `#lpEmailBody` and converting HOI
to rich text** — the largest, and the HOI half is a rewrite of how that body and
signature are assembled, not a toolbar addition.

**My recommendation: C, scoped to the four rich-text toolbars, and hold HOI.**
Adding the same three controls in four places is how the NMLS prefix ended up
fixed in one path and doubled in another. If C is too much for now, **B** is the
honest middle — but it should be taken knowing that a fifth copy is being created,
not avoided.

**And in any option: run the three-client send test before shipping the highlight
button**, because it is the one control whose failure mode is silent at the
recipient's end.
