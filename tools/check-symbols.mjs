#!/usr/bin/env node
/* check-symbols — find calls to functions that do not exist.
 *
 * WHY THIS EXISTS
 * `check-js.mjs` proves a file PARSES. A missing symbol parses perfectly:
 *
 *     Uncaught ReferenceError: renderCart is not defined
 *       at toggleCart (search-homes.html:2162)
 *
 * The cart button was valid JavaScript from the first character to the last. It
 * threw the moment a borrower clicked it. The same shape had already cost
 * `_tcCloseVideo` and `loadPage`, and each was found the same way: a human
 * clicked the thing and read the console.
 *
 * WHY public/ IS INCLUDED
 * The borrower-facing pages were excluded from every gate we had, for the same
 * reason they were invisible to verify-deploy — nobody added them. They are the
 * pages we watch least and the ones real customers use most.
 *
 * WHAT IT CHECKS
 * Two call sites, chosen because they are unambiguous without a full parser:
 *   1. inline HTML handlers   onclick="foo()"  — exactly how both bugs surfaced
 *   2. bare call expressions  foo(...)  inside inline <script> and local .js
 * A name resolves if it is declared anywhere the page loads — its own inline
 * scripts, any local <script src>, or the browser. Anything left is reported.
 *
 * Deliberately NOT a scope analysis. A function declared inside another
 * function counts as declared. That direction of imprecision is the safe one
 * for a gate: it under-reports rather than crying wolf, and a gate that cries
 * wolf gets switched off.
 *
 *   node tools/check-symbols.mjs                 every page
 *   node tools/check-symbols.mjs public/search-homes.html
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude', '.wrangler', 'dist', 'build', 'snapshots', '.db-observe', 'supabase', 'tools', 'docs']);

/* Names the browser provides. Not exhaustive by design — anything missing shows
 * up as one noisy line, gets added here, and never returns. */
const BROWSER = new Set(`
window document console navigator location history screen localStorage sessionStorage
alert confirm prompt fetch setTimeout setInterval clearTimeout clearInterval
requestAnimationFrame cancelAnimationFrame queueMicrotask structuredClone
Array Object String Number Boolean Date Math JSON RegExp Error TypeError RangeError
Promise Map Set WeakMap WeakSet Symbol Proxy Reflect BigInt Intl
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI
escape unescape btoa atob eval Function
URL URLSearchParams FormData Headers Request Response AbortController Blob File FileReader
Image Audio Video Option XMLHttpRequest WebSocket EventSource Notification
Event CustomEvent MouseEvent KeyboardEvent MutationObserver IntersectionObserver ResizeObserver
Element HTMLElement Node NodeList DOMParser XMLSerializer TextEncoder TextDecoder
IntersectionObserverEntry CSS getComputedStyle matchMedia scrollTo scrollBy open close print
Uint8Array Uint16Array Uint32Array Int8Array Int16Array Int32Array Float32Array Float64Array ArrayBuffer DataView
crypto performance caches indexedDB
supabase turnstile google grecaptcha Stripe gtag dataLayer Chart L flatpickr pdfjsLib DOMPurify html2canvas jspdf
Cal Calendly Intercom fbq
require module exports process globalThis self top parent frames
calc rgb rgba hsl hsla url translate translateX translateY translate3d scale scaleX scaleY
rotate skew matrix blur brightness grayscale opacity cubic-bezier steps clamp minmax repeat
linear-gradient radial-gradient conic-gradient attr counter env
`.trim().split(/\s+/));

/* ── extraction ─────────────────────────────────────────────────────────── */

/* Both scrubs below are LENGTH-PRESERVING: newlines survive, everything else
 * becomes a space. Reported line numbers are only trustworthy if an offset into
 * the scrubbed text is still the same offset in the original — the first draft
 * collapsed each comment to a single space, and every line number after the
 * first comment in the file was wrong. */
const blank = (s) => s.replace(/[^\n]/g, ' ');
const stripComments = (js) => js
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));

/* Scrub a chunk LINE BY LINE: comments stripped, then string literals blanked
 * within each line independently, so a misread quote cannot leak past the
 * newline and scan the rest of the file inside-out. */
const scrub = (js) => stripComments(js).split('\n').map(blankStrings).join('\n');

/* Blank out string and template literals so their contents are never mistaken
 * for code. Character-wise, because a regex cannot tell a quote from an
 * apostrophe inside another quote. */
function blankStrings(js) {
  let out = '', i = 0;
  while (i < js.length) {
    const c = js[i];
    /* NO regex-literal handling here, deliberately. Blanking regex literals
     * removes one real false positive — `/(^|[^a-z])va([^a-z]|\d|$)/` reads as
     * a call to va() — but telling a regex from a division without a parser
     * needs context this scanner does not have, and every version I tried
     * swallowed real code instead: declarations vanished and the calls to them
     * were reported as undefined. A handful of regex-shaped false positives is
     * the cheaper error. `va` is in KNOWN_NOISE below. */
    if (c === '"' || c === "'" || c === '`') {
      const q = c; let j = i + 1;
      while (j < js.length && js[j] !== q) { if (js[j] === '\\') j++; j++; }
      out += blank(js.slice(i, Math.min(j, js.length) + 1)); i = j + 1;
    } else { out += c; i++; }
  }
  return out;
}

function inlineScripts(html) {
  const out = [];
  const rx = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    if (/type\s*=\s*["'](?!text\/javascript|module|application\/javascript)/i.test(m[1])) continue;
    out.push({ code: m[2], offset: m.index });
  }
  return out;
}

function localScriptSrcs(html, fromFile) {
  const out = [];
  const rx = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const raw = m[1].split('?')[0];
    if (/^https?:|^\/\//.test(raw)) continue;
    const p = raw.startsWith('/') ? join(ROOT, raw.slice(1)) : join(dirname(fromFile), raw);
    if (existsSync(p) && statSync(p).isFile()) out.push(p);
  }
  return out;
}

/* Every name this code makes available to a later call.
 *
 * Scrubbed per line, for the same reason calledIn is. Scanning declarations
 * with one linear pass cost more than scanning calls did: a desync blanks REAL
 * code, the declaration vanishes, and every call to it is reported as
 * undefined. The first run of this tool announced that `fetchListings`,
 * `renderListings`, `applyClientFilters`, `goTo` and `statusBadgeFor` did not
 * exist. All five are declared in the same file, within 150 lines of each
 * other. Over-declaring is the safe direction here — it can only hide a
 * finding, never invent one. */
function declaredIn(js) {
  const src = scrub(js);
  const names = new Set();
  const add = (rx, g = 1) => { let m; rx.lastIndex = 0; while ((m = rx.exec(src)) !== null) names.add(m[g]); };
  add(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g);
  add(/\bclass\s+([A-Za-z_$][\w$]*)/g);
  /* Every declarator, not just the first. `var INTAKE_URL, INTAKE_HEADERS;`
   * declares two names; capturing only INTAKE_URL made INTAKE_HEADERS look
   * undefined at three call sites that work perfectly. */
  { let d; const dl = /\b(?:var|let|const)\s+([^;\n=]{0,200})/g;
    while ((d = dl.exec(src)) !== null)
      for (const part of d[1].split(',')) {
        const n = part.trim().split(/[\s=:(]/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
      }
  }
  add(/\bwindow\s*\.\s*([A-Za-z_$][\w$]*)\s*=/g);
  add(/\bwindow\s*\[\s*['"]([A-Za-z_$][\w$]*)['"]\s*\]\s*=/g);
  // destructuring: const { a, b } = ... and const [a, b] = ...
  let m; const de = /\b(?:var|let|const)\s*[{[]([^}\]]{0,300})[}\]]\s*=/g;
  while ((m = de.exec(src)) !== null)
    for (const part of m[1].split(',')) {
      const n = part.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  // function parameters — a param shadows nothing we care about but IS callable
  /* The name is optional: `new Promise(function (resolve, reject) {...})` is an
   * anonymous function whose params are absolutely callable, and requiring a
   * name reported `resolve` and `reject` as undefined on four pages. */
  const fp = /\bfunction\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*\(([^)]{0,400})\)/g;
  while ((m = fp.exec(src)) !== null)
    for (const part of m[1].split(',')) {
      const n = part.split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  // arrow params: (a, b) => and x =>
  const ap = /(?:\(([^)]{0,300})\)|([A-Za-z_$][\w$]*))\s*=>/g;
  while ((m = ap.exec(src)) !== null) {
    const g = m[1] !== undefined ? m[1] : m[2];
    for (const part of String(g).split(',')) {
      const n = part.split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  // catch (e)  and  for (const x of ...)
  add(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g);
  add(/\bfor\s*\(\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g);
  // labels for object-literal methods: foo: function / foo(){} inside objects
  add(/([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?function/g);
  /* ES-module imports. `<script type="module">import { createLeadCapture } from
   * "/api/public-api.js"` brings a name into scope without declaring it here,
   * and index.html's only finding was exactly that. */
  /* No quote in the pattern: scrub() has already blanked the module path along
   * with its quotes, so anchoring on `from "` matched nothing and index.html's
   * only finding survived the fix meant to remove it. */
  { let im; const ix = /\bimport\s+([^;'"]*?)\s+from\b/g;
    while ((im = ix.exec(src)) !== null)
      for (const part of im[1].replace(/[{}]/g, ',').split(','))
        { const n = part.trim().split(/\s+as\s+/).pop().trim();
          if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n); }
  }
  add(/\bimport\s*\(\s*['"]/g, 0);   // dynamic import — nothing to name
  return names;
}

const KEYWORD = new Set(`if else for while switch case return function var let const new typeof instanceof
delete void in of do try catch finally throw class extends super this null true false undefined
await async yield break continue default export import from as get set static`.trim().split(/\s+/));

/* Bare `name(` — not `.name(`, not a declaration.
 *
 * Strings are blanked LINE BY LINE rather than across the whole file. A single
 * linear pass desynchronises permanently on the first quote it misreads (a
 * regex literal, an apostrophe in an odd place), and everything after it is
 * scanned as if inside-out. That is how `Media` was reported as an undefined
 * function when it is really part of the string
 *   '&$expand=Media($top=10;$select=MediaURL,Order)'
 * Per-line blanking resynchronises at every newline, so one bad line costs one
 * bad line. The tradeoff is a template literal spanning lines, whose contents
 * are then read as code — that over-reports, which a gate can survive; silently
 * scanning half a file inside-out, it cannot.
 *
 * `lineOf` maps a position in this chunk back to a line in the whole FILE, so
 * the number printed is the one you can jump to. */
function calledIn(js, lineOf) {
  const hits = new Map();
  const lines = stripComments(js).split('\n');
  let pos = 0;
  lines.forEach((raw, idx) => {
    const src = blankStrings(raw);
    /* No \s* before the paren, and no hyphen before the name. `foo (x)` with a
       space is prose inside a template literal far more often than a call —
       "Cooldown between replies (seconds)" reported `replies` as undefined —
       and `linear-gradient(` is one CSS function, not a call to gradient(). */
    const rx = /(^|[^\w$.?-])([A-Za-z_$][\w$]*)\(/g;
    let m;
    while ((m = rx.exec(src)) !== null) {
      const name = m[2];
      if (KEYWORD.has(name)) continue;
      const pre = src.slice(Math.max(0, m.index - 12), m.index + m[1].length);
      if (/\b(?:function|class|new)\s*$/.test(pre)) continue;
      /* A method call whose chain wrapped: the `.` sits at the end of the
       * PREVIOUS line, so per-line scanning sees a bare `addEventListener(`. */
      if (m[1] === '' && idx > 0 && /\.\s*$/.test(lines[idx - 1])) continue;
      if (!hits.has(name)) hits.set(name, lineOf(pos + m.index));
    }
    pos += raw.length + 1;
  });
  return hits;
}

/* onclick="foo()" and friends — the call site both known bugs came through. */
function handlersIn(html) {
  const hits = new Map();
  const rx = /\son[a-z]+\s*=\s*(["'])([\s\S]*?)\1/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const line = html.slice(0, m.index).split('\n').length;
    /* A handler's own strings are data: onmouseover="...'rgba(1,2,3)'" is CSS,
       not a call to rgba(). */
    for (const [, , name] of blankStrings(m[2]).matchAll(/(^|[^\w$.?])([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (KEYWORD.has(name)) continue;
      if (!hits.has(name)) hits.set(name, line);
    }
  }
  return hits;
}

/* ── the check ──────────────────────────────────────────────────────────── */

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (SKIP_DIRS.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.html')) out.push(p);
  }
  return out;
}

function checkPage(file) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const html = readFileSync(file, 'utf8');
  const declared = new Set();
  const scripts = inlineScripts(html);
  for (const p of localScriptSrcs(html, file)) {
    for (const n of declaredIn(readFileSync(p, 'utf8'))) declared.add(n);
  }
  for (const s of scripts) for (const n of declaredIn(s.code)) declared.add(n);

  /* `if (typeof foo === 'function') foo();` is the codebase's deliberate idiom
   * for a symbol that may legitimately be absent — an optional collaborator, a
   * script that might not have loaded. Reporting those is reporting the author's
   * own defensive check back at them, and it buries the ones that do throw. */
  const guarded = new Set(
    [...html.matchAll(/typeof\s+([A-Za-z_$][\w$]*)\s*[!=]==?\s*['"](?:function|undefined)['"]/g)].map((m) => m[1])
  );

  /* Names that read as calls but are not, and that the scanner cannot tell apart
   * without a parser. Each is verified by hand and named with its cause, so this
   * list stays short and honest rather than becoming a place to hide findings. */
  const KNOWN_NOISE = new Set([
    'va',   // public/fee.html:471 — inside the regex /(^|[^a-z])va([^a-z]|\d|$)/
  ]);

  const missing = new Map();
  const consider = (name, line, how) => {
    if (declared.has(name) || BROWSER.has(name) || guarded.has(name) || KNOWN_NOISE.has(name)) return;
    if (!missing.has(name)) missing.set(name, { line, how });
  };
  for (const [n, l] of handlersIn(html)) consider(n, l, 'onclick=');
  /* Each script is scanned in place so a hit's line number is its line in the
     FILE, not its line within some concatenation of every script block. */
  for (const s of scripts) {
    const base = html.slice(0, s.offset).split('\n').length;  // 1-indexed
    const bodyStart = html.indexOf('>', s.offset) + 1;
    const preLines = html.slice(s.offset, bodyStart).split('\n').length - 1;
    const lineOf = (off) => base + preLines + s.code.slice(0, off).split('\n').length - 1;
    for (const [n, l] of calledIn(s.code, lineOf)) consider(n, l, 'called');
  }
  return { rel, missing };
}

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith('-')).length
  ? argv.filter((a) => !a.startsWith('-')).map((a) => join(ROOT, a))
  : walk(ROOT);

let total = 0;
const rows = [];
for (const f of files) {
  if (!existsSync(f)) { console.log(`  ?  ${f} — not found`); continue; }
  const { rel, missing } = checkPage(f);
  if (!missing.size) continue;
  rows.push({ rel, missing });
  total += missing.size;
}

/* GATED vs OBSERVED.
 *
 * On public/ and the root marketing pages this has a verified zero false-
 * positive rate: every name it reported was checked by hand, the two real ones
 * (renderCart, addToCart) were fixed, and a deliberately renamed function is
 * still caught. Those pages BLOCK.
 *
 * The big admin pages are reported but do not block, because the rate there is
 * NOT zero and I know it: `closeTextComposer` is reported as undefined in
 * admin/lead-detail.html and is plainly declared at line 34732 of the same file.
 * The cause is somewhere in scanning a 2.3 MB file with twelve inline script
 * blocks and I have not found it. Blocking a deploy on a check I know to be
 * wrong teaches everyone to pass --no-verify, which costs more than the bug.
 *
 * Move a page into GATED once its output has been verified clean by hand. That
 * direction is one-way and deliberate. */
const GATED = (rel) => rel.startsWith('public/') || !rel.includes('/');

const gatedRows = rows.filter((r) => GATED(r.rel));
const observedRows = rows.filter((r) => !GATED(r.rel));
const gatedTotal = gatedRows.reduce((n, r) => n + r.missing.size, 0);

const print = (list) => {
  for (const { rel, missing } of list) {
    console.log(`  ${rel}`);
    for (const [name, { line, how }] of [...missing].sort((a, b) => a[1].line - b[1].line))
      console.log(`    L${String(line).padEnd(6)} ${how.padEnd(9)} ${name}`);
  }
};

if (gatedTotal) {
  console.log(`check-symbols: ${gatedTotal} unresolved reference(s) on GATED pages\n`);
  print(gatedRows);
  console.log('\nEach of these throws a ReferenceError the moment that path runs.');
} else {
  console.log(`check-symbols: OK — every called name resolves on ${files.filter((f) => GATED(relative(ROOT, f).split(sep).join('/'))).length} gated page(s).`);
}

if (observedRows.length) {
  console.log(`\n── observed only, NOT blocking ──────────────────────────`);
  console.log(`These pages are not yet verified; some entries below are known to be`);
  console.log(`wrong (closeTextComposer IS declared in lead-detail.html:34732).\n`);
  print(observedRows);
}

process.exit(gatedTotal ? 1 : 0);
