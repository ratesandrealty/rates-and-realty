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
 * WHERE THE BUGS IN THIS TOOL LIVE — read before changing scrub()
 * Every false positive it has produced came from the scrubber, never from the
 * matching. Blanking comments and strings in the wrong order deletes real code,
 * and the symptom is a confident report that a function nobody touched has
 * ceased to exist. It once announced eighteen of those. `--self-test` pins the
 * exact constructs that broke earlier versions; run it before believing any
 * change here.
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
addEventListener removeEventListener dispatchEvent postMessage getSelection focus blur
scroll scrollX scrollY innerWidth innerHeight outerWidth outerHeight devicePixelRatio
requestIdleCallback cancelIdleCallback reportError isSecureContext origin name status
supabase turnstile google grecaptcha Stripe gtag dataLayer Chart L flatpickr pdfjsLib DOMPurify html2canvas jspdf
Cal Calendly Intercom fbq
require module exports process globalThis self top parent frames
`.trim().split(/\s+/));

/* ── extraction ─────────────────────────────────────────────────────────── */

/* Both scrubs below are LENGTH-PRESERVING: newlines survive, everything else
 * becomes a space. Reported line numbers are only trustworthy if an offset into
 * the scrubbed text is still the same offset in the original — the first draft
 * collapsed each comment to a single space, and every line number after the
 * first comment in the file was wrong. */
const blank = (s) => s.replace(/[^\n]/g, ' ');

/* ONE pass, one state machine, because the ordering problem has no answer.
 *
 * Stripping comments first breaks on a string that contains `/*`:
 *     +'<input type="file" accept="image/*" onchange="…">'
 * That `image/*` opened a phantom block comment which ran to the next real
 * `* /` — blanking 10,192 characters of live code in lead-detail.html, taking
 * `function closeTextComposer` and eight other declarations with it. Every call
 * to them was then reported as undefined.
 *
 * Blanking strings first breaks the other way, on an apostrophe in a comment
 * (`// don't do this`), which opens a string that swallows the rest of the file.
 *
 * So neither can go first, and scanning per line only bounds the damage instead
 * of fixing it. A single walk that knows which construct it is inside at every
 * character has no ordering to get wrong. Output is the same length as the
 * input with newlines preserved, so offsets still map to real line numbers.
 *
 * Template `${…}` holes are returned to code, not blanked: they hold real calls.
 * The literal TEXT around them stays blanked, which is what keeps prose like
 * "Cooldown between replies (seconds)" from reading as a call to replies(). */
function scrub(js) {
  let out = '', i = 0, mode = 'code', lastSig = '', inClass = false;
  const tpl = [];                       // brace depth per open ${ } hole
  const sp = (c) => (c === '\n' ? '\n' : ' ');
  while (i < js.length) {
    const c = js[i], d = js[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      /* A `/` is a regex only where a value can start. After an identifier, a
       * number or a `)` it is division. lastSig is reliable here precisely
       * because this walk never confuses a string for code. */
      if (c === '/' && (lastSig === '' || '([{,;:=!&|?+-*%~^<>'.includes(lastSig))) {
        mode = 'regex'; inClass = false; out += ' '; i++; continue;
      }
      if (c === '"' || c === "'") { mode = c; out += ' '; i++; continue; }
      if (c === '`') { mode = '`'; out += ' '; i++; continue; }
      if (tpl.length) {
        if (c === '{') { tpl[tpl.length - 1]++; }
        else if (c === '}') {
          if (tpl[tpl.length - 1] === 0) { tpl.pop(); mode = '`'; out += ' '; i++; continue; }
          tpl[tpl.length - 1]--;
        }
      }
      out += c;
      if (!/\s/.test(c)) lastSig = c;
      i++; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; } else out += ' ';
      i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += sp(c); i++; continue;
    }
    if (mode === 'regex') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '\n') { mode = 'code'; out += '\n'; i++; continue; }   // unterminated → it was division
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { mode = 'code'; lastSig = 'x'; out += ' '; i++; continue; }
      out += ' '; i++; continue;
    }
    // inside a string or template literal
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (mode === '`' && c === '$' && d === '{') { tpl.push(0); mode = 'code'; out += '  '; i += 2; continue; }
    if (c === mode) { mode = 'code'; lastSig = 'x'; out += ' '; i++; continue; }
    if (mode !== '`' && c === '\n') { mode = 'code'; out += '\n'; i++; continue; }  // unterminated quote
    out += sp(c); i++; continue;
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
  const lines = scrub(js).split('\n');   // one scan; already comment/string/regex aware
  let pos = 0;
  lines.forEach((raw, idx) => {
    const src = raw;   // scrub() already applied above
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
    for (const [, , name] of scrub(m[2]).matchAll(/(^|[^\w$.?])([A-Za-z_$][\w$]*)\s*\(/g)) {
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

  /* There is no suppression list. There was one — `va`, from the regex
   * /(^|[^a-z])va([^a-z]|\d|$)/ in fee.html — and it existed only because the
   * scanner could not tell a regex literal from division. The single-pass
   * scrubber can, so the entry was deleted rather than kept. A suppression list
   * is where a checker goes to stop being true; if something needs suppressing,
   * fix the scanner or explain it as a browser global. */

  const missing = new Map();
  const consider = (name, line, how) => {
    if (declared.has(name) || BROWSER.has(name) || guarded.has(name)) return;
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

/* Exported so the internals can be bisected from a test without re-running the
 * whole sweep. Finding a false positive means asking WHICH stage lost a name —
 * script extraction, scrubbing, or the declaration patterns — and guessing at
 * that from the outside is how four wrong fixes got made. */
export { inlineScripts, declaredIn, calledIn, handlersIn, scrub, checkPage };

/* Self-test for the scrubber, which is where every false positive this tool has
 * ever produced came from. Each case below is a real construct out of this
 * codebase that broke an earlier version. Run with --self-test; the deploy runs
 * it before the sweep, so a scrubber regression fails loudly instead of quietly
 * blanking code and reporting the calls to it as undefined.
 *
 *   node tools/check-symbols.mjs --self-test
 */
function selfTest() {
  const cases = [
    ['string containing /* does not open a comment',
     `var a='<input accept="image/*">';\nfunction survivor(){}`, 'survivor', true],
    ['apostrophe in a line comment does not open a string',
     `// don't do this\nfunction survivor(){}`, 'survivor', true],
    ['real block comment IS removed',
     `/* function ghost(){} */\nfunction survivor(){}`, 'ghost', false],
    ['real line comment IS removed',
     `// function ghost(){}\nfunction survivor(){}`, 'ghost', false],
    ['regex literal is not code',
     `if(/(^|[^a-z])va([^a-z])/.test(s)){}\nfunction survivor(){}`, 'va', false],
    ['a / that is division does not start a regex',
     `var r = a / b; var q = c / d;\nfunction survivor(){}`, 'survivor', true],
    ['slash inside a regex character class does not end it',
     `var re = /[/]x/; function survivor(){}`, 'survivor', true],
    ['template ${} holes are still code',
     'var h = `<b>${fmt(x)}</b>`;', 'fmt', true],
    ['template literal TEXT is not code',
     'var h = `Cooldown between replies (seconds)`;', 'replies', false],
    ['escaped quote does not end the string',
     `var s='it\\'s fine'; function survivor(){}`, 'survivor', true],
  ];
  let bad = 0;
  for (const [name, src, needle, shouldSurvive] of cases) {
    const out = scrub(src);
    const survived = new RegExp('\\b' + needle + '\\b').test(out);
    const ok = survived === shouldSurvive;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) console.log(`       expected ${needle} ${shouldSurvive ? 'to survive' : 'to be blanked'}\n       got: ${JSON.stringify(out)}`);
  }
  const lenOk = ((s) => scrub(s).length === s.length)(`var a='x/*y'; /* c */ // d\nfunction f(){}`);
  if (!lenOk) { bad++; console.log('  FAIL scrub is not length-preserving — line numbers would be wrong'); }
  else console.log('  ok   scrub is length-preserving (line numbers stay true)');
  console.log(bad ? `\ncheck-symbols self-test: ${bad} FAILED` : '\ncheck-symbols self-test: all passed');
  return bad;
}

/* Importing this file must not run the sweep — a test that imports it to poke at
 * one function should not also print findings and call process.exit. */
const IS_CLI = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/check-symbols.mjs');

const argv = process.argv.slice(2);
if (IS_CLI) {
if (argv.includes('--self-test')) process.exit(selfTest() ? 1 : 0);

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

/* EVERY page blocks.
 *
 * This was briefly split — public/ blocking, admin/ observed only — because the
 * admin pages produced eighteen findings and one of them, `closeTextComposer`,
 * was plainly declared at lead-detail.html:34732. Every one of those eighteen
 * turned out to be the same defect in this tool, not eighteen defects in the
 * pages: `accept="image/*"` inside a string opened a phantom block comment that
 * blanked 10,192 characters of real code. Fixing the scrubber took all eighteen
 * to zero, so there is nothing left to excuse and nothing to split. */
const GATED = () => true;

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
}
