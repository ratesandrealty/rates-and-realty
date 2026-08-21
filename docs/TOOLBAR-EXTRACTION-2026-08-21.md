# The toolbar extraction — what shipped, 2026-08-21

Scope C as handed over: four rich-text surfaces, HOI held. The eight divergence
winners in `docs/TOOLBAR-CONSOLIDATION-DIVERGENCE-2026-08-20.md` were followed as
recorded, not re-decided.

**Not deployed.** Everything below is verified against the working tree. `bash
tools/deploy.sh` is the next step and is deliberately left to a human, for the
reason in §5.

---

## 1. The component

`admin/js/rich-toolbar.js`, 399 lines, `window.RichToolbar.mount(opts)`.

It replaced four implementations: `tbCmd` in `admin/lead-detail.html`,
`inbox.js`'s internal handler, `settings.html`'s `data-c` delegate, and
drip-builder's `fmtText`.

| decision | shipped as |
|---|---|
| 1 link URL validation | `/^(https?:\|mailto:\|tel:)/i`, refusal through the host's `notify` |
| 2 prompt default | `prompt('Link URL:', 'https://')` |
| 3 `execCommand` errors | every call in `try/catch` |
| 4 focus | `target.focus()` before **and** after, plus an explicit Range save/restore around `prompt()` and the colour picker |
| 5 font list | six named faces, each VALUE a full stack (`Arial, Helvetica, sans-serif`) |
| 6 size scale | `Small 2 / Normal 3 / Large 5 / Huge 6` |
| 7 controls | formatting core is the union; inserts are host-passed `slots` |
| 8 dispatcher | `exec(target, cmd, value)` — explicit element, always a value slot |
| `styleWithCSS` | on for `foreColor`/`hiliteColor`/`backColor` only, then **restored to its prior value** |

Two things beyond the recorded winners, both small and both stated here so they
are not mistaken for decisions someone made and forgot to write down:

- **Ctrl/Cmd+K binds to the link button.** All four surfaces advertised it in a
  tooltip; only `inbox.js` bound it.
- **Button state reflects the caret** (`queryCommandState` → `.on`). `inbox.js`
  already did this for the font and size selects; the class is `.on` rather than
  `.active` because `settings.html` and `drip-builder.html` both already style
  `.active` for unrelated things.

### The row wraps, and that is the visible change

The handoff called for alignment, indent/outdent, quote and clear formatting to
be **surfaced rather than buried** behind `inbox.js`'s `⋯` overflow. Fifteen
formatting controls plus a host's slots do not fit one row on a narrow composer,
so the row wraps, with `row-gap` and a full-width host.

That is a real trade against the note in `inbox.js` that motivated the overflow —
"a wrapped row was putting a lone ✕ on a second line and stealing height from the
body". The lone ✕ is what looked broken; a deliberate second line of controls
does not. **The overflow menu is gone**, and `.gm-tools`'s mobile
`overflow-x:auto` went with it: scrolling a toolbar sideways hides exactly the
controls this change exists to reveal.

---

## 2. THE FINDING: the drip step editor was a `<textarea>`

The divergence doc analysed drip-builder's `fmtText(cmd)` as a rich-text
dispatcher with a missing value argument. It is worse than that.

```html
<textarea class="field-textarea rte-area" id="emailBody_${idx}" …>
```

```js
function fmtText(cmd) {
  if (cmd==='link') { const url=prompt('URL:','https://'); if(url) document.execCommand('createLink',false,url); }
  else document.execCommand(cmd);
}
```

**`document.execCommand` cannot touch a `<textarea>`.** Bold, Italic and Link on
that toolbar had never done anything, on any campaign, ever. They looked
identical to working buttons and returned no error.

So drip was not a port. Converting it meant:

- `<textarea>` → `contenteditable` div,
- `steps[].body` changing from plain text to HTML,
- `insertVar` moving from `selectionStart`/`value` splicing to `insertHTML`,
- the char count moving to `textContent` — markup must not make one bolded word
  cost twenty characters,
- and the signature snippet's `\n\n---\n` becoming `<br><br>---<br>`.

### Why converting was safe to do rather than hold

`steps[].body` **has no consumer anywhere.** Checked, all four places it could
be:

```
repo             grep for drip_campaigns / drip_enrollments -> contact-intelligence only,
                 and that reads drip_enrollments for a timeline, never a body
pg_cron          no job whose command or name matches 'drip'
n8n              search_workflows('drip') -> 0
data             drip_campaigns: 1 row, 0 active
```

Nothing sends these. The stored shape could therefore change without a send path
to break, and the three dead buttons are fixed rather than carried forward. **HOI
was held for the opposite reason** — `lpHoiOpenComposer` assembles a live body
that really is sent as text, so converting it is a rewrite of the send, not of
the editor.

Legacy plain-text bodies still read correctly: `bodyToHtml()` escapes and
converts newlines **once** for anything with no tags in it, and sanitizes
anything that does. `previewStep()` already interpolated the body unescaped, so
the preview needed no change.

### A textarea is inert; an innerHTML sink is not

`admin/drip-builder.html` had no sanitizer, because it never needed one. It now
loads the vendored DOMPurify and `inbox.js`, and `bodyToHtml()` goes through
`GmailInbox.sanitize` — the same allowlist the composer and the signature editor
use, per the note in `settings.html`. **One allowlist for outbound HTML, not a
second one written here.** If it fails to load the body renders escaped, loudly.

---

## 3. A second, unrelated defect found on the way

`loadContacts()` in drip-builder did:

```js
_contacts = await r.json();
_filtered = [..._contacts];
```

PostgREST answers a failure with an **object**, not an array, so `[...that]`
throws `TypeError: _contacts is not iterable` and takes the rest of the function
with it. A 401 read as an uncaught TypeError and the contact list stayed empty
with no explanation. It reproduces on production.

Now checks `r.ok` and `Array.isArray`, says so in the console and in
`#contactFilterInfo`. Found because the new render-check spec builds a campaign on
a page with no session — which is the only reason to point a harness at a page in
a state nobody uses by hand.

---

## 4. Proof

Four specs, one per surface, in `tools/render-check.mjs`. Each asserts the shared
contract (`RRT_CORE` — the exact formatting set, sorted and joined, so an added
or duplicated control fails too) plus that surface's own slots.

```
RC_BASE=http://127.0.0.1:8799 node tools/render-check.mjs "rich toolbar"
  4/4 pass                         the working tree

node tools/render-check.mjs "rich toolbar"
  0/4 pass                         production, i.e. the code this replaced
```

**The 0/4 is the break test and it came free** — the specs were written before
anything was served locally, and every one of them fails against the four
implementations they replace. Full suite: `79/79` local for the pages a static
server can route (the 8 that fail locally are Worker-routed slug URLs and the
maps injection, and all 8 were green in the production run). `tools/check-js.mjs`,
`tools/check-symbols.mjs` and `tools/test-composer.mjs` (44 assertions) all pass.

### Presence is not behaviour, so four assertions drive the commands

The `#shell` break-test in `CLAUDE.md` is the reason: that element was present
and empty. On the signature editor — the surface with no send path and no
fixture, and the component is identical on all four:

| assertion | pins |
|---|---|
| bold emits `<b>` and **no** `font-weight` | `styleWithCSS` is not global |
| `hiliteColor` emits `background-color:` | highlight ships as inline style, per the three-client test |
| `foreColor` emits `color:` and no `<font>` | one representation, not two |
| `javascript:` → refused, `https:` → linked | the validation, driven through the real button |

The link assertion checks **both directions in one eval**: a validator that
rejects everything also passes a reject-only check.

### And those were broken on purpose

Two edits to `rich-toolbar.js`, run, reverted:

```
var isColour = true;          (styleWithCSS globally)  -> bold assertion FAILED
if (false) { …LINK_OK… }      (accept any URL)         -> link assertion FAILED  ("linked,linked")
```

Exactly the two targeted assertions went red and nothing else did. The file is
restored; `node tools/stamp-assets.mjs --check` says all pins current.

---

## 5. What is NOT proven, and it is the part that matters

**No human has sent an email through any of these four toolbars.**

render-check runs with a stubbed Supabase client. It proves the toolbar mounts,
that the commands emit the markup the client test settled on, and that the link
validation refuses. It proves **nothing** about:

- an email composed with the new controls actually arriving, in any client;
- the wrapped row looking right at the widths Rene actually uses — the layout
  trade in §1 is the one judgement here that a harness cannot settle;
- the drip step editor's HTML body surviving a save/reload round trip against
  the real `drip_campaigns` row, because the page's raw `fetch` to PostgREST is
  not something the stub intercepts.

That last one is the same gap `CLAUDE.md` records for `admin-api-v2.js` pages, in
a different file: **the stub owns `window.supabase`, and a page that does not use
`window.supabase` is not stubbed at all.**

So: open a composer, use the new controls, send one, and open a drip campaign and
save it — before trusting any of this in front of a borrower.

---

## 6. Still open

- **`#lpEmailBody` has no toolbar.** Five template emails including the HOI agent
  and realtor ones. It is now a mount call: `RichToolbar.mount({ target:
  'lpEmailBody', mount: hostEl })`, no slots.
- **`lpHoiOpenComposer` is plain text** and stays held — see §2.
- **`.rte-divider` in drip-builder is now dead CSS.** Left in place; the SMS step
  still uses `.rte-btn` beside it.
