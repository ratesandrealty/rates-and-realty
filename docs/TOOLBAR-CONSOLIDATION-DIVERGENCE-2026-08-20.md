# What the four toolbars disagree on — and which side wins

Prepared before extracting a single toolbar, so consolidation is a set of decided
choices rather than "whichever file I opened first".

**Eight real disagreements.** Alignment was the one already known; these are the
other seven.

> **CORRECTION, 2026-08-21 — read this before §1. Drip's body is a `<textarea>`.**
>
> Every section below reads drip-builder as a rich-text surface with a weak
> dispatcher. It is not a rich-text surface at all: `#emailBody_<i>` was a
> `<textarea>`, so `fmtText`'s Bold, Italic and Link called
> `document.execCommand` against a control `execCommand` cannot touch, and **had
> never done anything, on any campaign, ever**.
>
> What each section says about drip's CODE is still accurate. What they get wrong
> is the consequence: mounting the shared toolbar there was a conversion of the
> editor and of the stored body, not a port of a dispatcher. Done — with why it
> was safe to convert rather than hold the way HOI was held — in
> `docs/TOOLBAR-EXTRACTION-2026-08-21.md` §2.
>
> **All eight winners shipped as recorded.** This corrects the survey, not a
> decision.

---

## 1. Link URL validation — a correctness difference, not a preference

| toolbar | behaviour |
|---|---|
| `#emailEditor` (main) | `prompt('Enter URL:')` → **straight to `createLink`, no scheme check** |
| `inbox.js` | rejects anything not `https?:` / `mailto:` / `tel:`, with an alert |
| `#sigEditor` | same validation, with a toast |
| drip-builder | `prompt('URL:','https://')` → **no scheme check** |

**Winner: validate (inbox/settings).**

Two of the four accept `javascript:` and put it straight into an `href`.

**Stated accurately, because it is easy to overstate:** this is not a live
vulnerability. On render, `inbox.js`'s DOMPurify config allows only
`https?:|mailto:|tel:|cid:|data:image/...` in `ALLOWED_URI_REGEXP`, so a
`javascript:` href is stripped before it is ever displayed in the CRM; and mail
clients neutralise such hrefs anyway. But the send path does **not** sanitise
(`email-service` runs only `stripMarkdownFences`), so the address really does go
out carrying it, and two of the four toolbars have a check the other two lack for
no reason anyone recorded. Consolidating on the validating version costs nothing.

## 2. Link prompt default

Main uses `prompt('Enter URL:')` with no default; settings and drip prefill
`'https://'`.

**Winner: prefill `https://`.** It is the cheapest possible nudge toward a scheme
the validator will accept, and it makes the validation in §1 almost never fire.

## 3. `execCommand` error handling

`inbox.js` and `#sigEditor` wrap every call in `try { … } catch (_) {}`. The main
composer and drip-builder call it bare.

**Winner: try/catch.** `execCommand` throws on some selections and inputs, and an
uncaught throw inside a click handler abandons the rest of that handler — so a
failed command can silently take out whatever the handler did next.

## 4. Focus handling

The main composer is the only one that does `editor.focus()` **before and after**
the command. The others rely on ambient focus.

**Winner: the main composer's explicit focus.** Without it, clicking a toolbar
button can move focus to the button, collapse the selection, and apply the command
to nothing — the classic "I clicked Bold and nothing happened". This is the one
difference where the main composer is the better implementation.

## 5. Font list

| main | inbox |
|---|---|
| Sans Serif, Serif, Monospace (3 generic families) | Arial, Georgia, Tahoma, Verdana, Courier New (5 named faces) |

**Winner: named faces (inbox), with a fallback stack.**

`fontName` emits `<font face="…">`. A generic family name in a `face` attribute is
resolved inconsistently by mail clients, whereas named faces are the email
convention and are what Gmail's own composer offers. Emitting
`face="Arial, Helvetica, sans-serif"` rather than a bare `Arial` keeps the generic
fallback the main composer was reaching for.

## 6. Size scale — and an ordering bug in the main composer

Main offers legacy values labelled by point size, **in the wrong order**:

```html
<option value="4">14   <option value="3">12   <option value="5">16   <option value="6">18
```

14 sits above 12. Inbox offers named sizes: Small / Normal / Large / Huge.

**Winner: named sizes mapped to the legacy scale** (Small 2, Normal 3, Large 5,
Huge 6), matching Gmail — and the ordering bug disappears with the list. Point
labels imply a precision the legacy 1–7 scale does not have; `value="4"` is not
14px in any client, it is "one step above normal".

## 7. Controls present in one and not others

| control | main | inbox | sig | drip |
|---|---|---|---|---|
| bold / italic / underline | ✓ | ✓ | ✓ | ✓ |
| bullet / numbered | ✓ | ✓ | ✓ | ✓ |
| link | ✓ | ✓ | ✓ | ✓ |
| clear formatting | ✓ | ✓ | ✓ | – |
| font / size | ✓ | ✓ | – | – |
| **alignment** | – | **✓** | – | – |
| **indent / outdent** | – | **✓** | – | – |
| **quote (blockquote)** | – | **✓** | – | – |
| emoji, inline image | – | ✓ | – | – |
| Canva / Loom insert | ✓ | ✓ (Loom) | – | – |
| variable picker | ✓ | – | – | ✓ |

**Winner: the union for the formatting core** — B/I/U, lists, link, clear, font,
size, alignment, indent/outdent, quote — plus the new colour and highlight.
**Not** the union for the insert controls: Canva, Loom, emoji, image and the
variable picker are surface-specific (a signature has no variables; a drip step
has no Loom recording) and belong as opt-in slots the host passes in, not as
toolbar defaults.

## 8. Dispatcher shape

Four signatures: `tbCmd(cmd, val)`, inbox's internal handler, settings' `data-cmd`
delegate, drip's `fmtText(cmd)` — which takes **no value argument at all**, so it
structurally cannot support font, size, colour or highlight.

**Winner: `(cmd, value)` with an explicit target element.** Drip's shape is the
one that has to go regardless; it cannot express the controls being added.

---

## The `styleWithCSS` decision, which cuts across all four

None of the four sets it, so all are in legacy mode. Highlight has **no `<font>`
representation at all**, so it must emit a `style` attribute whatever the rest of
the toolbar does.

**Winner: enable `styleWithCSS` for the colour commands specifically**, leaving
bold/italic/lists in whatever the browser does natively. Turning it on globally
would silently change what bold and underline emit (`<span style="font-weight:700">`
instead of `<b>`), which is a larger and unrequested change to every email this
CRM sends — and `<b>`/`<u>` are the better-supported forms in mail.

---

## `#lpEmailBody` — does extraction make it a small follow-up?

**Yes, and that is the strongest argument for C over B.**

`#lpEmailBody` is a bare contenteditable with a "Body" label and nothing else. Five
template-driven emails are composed in it — including the **HOI agent** and the
**realtor** ones — with no formatting controls whatsoever. Today, giving it a
toolbar means writing a fifth implementation.

If the toolbar becomes a component that takes a target element and a set of
optional slots, mounting it there is a few lines and no new logic:

```js
mountToolbar({ target: 'lpEmailBody', controls: 'core' })   // no variables, no Canva
```

**Not proposed for this pass**, per instruction. But it is worth knowing that the
follow-up is a mount call rather than a port — and that until it happens, the two
composers that reach outside vendors most often are the least equipped.
