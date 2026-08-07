#!/usr/bin/env node
/**
 * stamp-assets — derive every `?v=` cache pin from the asset's own content hash.
 *
 * WHY THIS EXISTS
 * Pins were hand-edited dates. Shipping a changed file without remembering to bump
 * its pin leaves every returning browser on the cached old copy, and the app looks
 * unchanged for reasons that have nothing to do with the code. That happened to
 * admin/js/inbox.js: the composer work shipped, the pin stayed at 2026072804, and
 * the previous file kept being served from cache.
 *
 * A content hash removes the human step: change the file and the URL changes with
 * it; don't change the file and the URL is stable, so caches still hit.
 *
 * USAGE
 *   node tools/stamp-assets.mjs            rewrite stale pins in place
 *   node tools/stamp-assets.mjs --check    exit 1 if any pin is stale (no writes)
 *   node tools/stamp-assets.mjs --report   inventory only, no writes
 *
 * WHAT IS DELIBERATELY NOT STAMPED
 *   - assets with no file on disk (e.g. /api/env.js, which src/worker.js serves
 *     dynamically and blocks as a static file) — nothing to hash
 *   - anything under /vendor/, where the pin is a real upstream version carrying an
 *     SRI `integrity` attribute; that pin means something and is not ours to churn
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude', '.wrangler', 'dist', 'build']);
const REF = /(src|href)="(\/[^"?]+)\?v=([^"]*)"/g;

/* Pins that live in JS STRING LITERALS rather than HTML attributes.
 *
 * admin/js/auth-guard.js injects four app-wide widgets by writing
 *     sc.src = '/admin/js/staff-chat.js?v=2026070603';
 * which the HTML scanner above never saw, because it only walks .html. Those four
 * pins — staff-chat, help-button, task-capture, action-fab — were hand-maintained
 * dates that no gate checked, while src/worker.js serves any ?v=-pinned asset
 * `immutable` for a year. A forgotten bump there does not self-heal: returning
 * browsers keep the old file with no revalidation until some later deploy changes
 * the pin. That is precisely the failure this tool was written to remove, and it
 * was live in the one file that loads on every authenticated page.
 *
 * Matches single, double or backtick quotes so it does not depend on the quoting
 * style of whoever writes the next one. */
const REF_JS = /(['"`])(\/[^'"`?\s]+)\?v=([^'"`]*)\1/g;

/* Served dynamically by src/worker.js, which explicitly BLOCKS the static file at
 * these paths. A copy may exist on a developer's disk (api/env.js is gitignored and
 * holds local keys), but hashing it would stamp a pin from content that is never the
 * content deployed — and would differ per machine. Leave these alone. */
const DYNAMIC = new Set(['/api/env.js', '/api/env.example.js']);

const mode = process.argv.includes('--check') ? 'check'
  : process.argv.includes('--report') ? 'report' : 'write';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.html') || name.endsWith('.js')) out.push(p);
  }
  return out;
}

const hashCache = new Map();
function assetHash(urlPath) {
  if (hashCache.has(urlPath)) return hashCache.get(urlPath);
  const local = join(ROOT, urlPath.replace(/^\//, '').split('/').join(sep));
  let h = null;
  if (existsSync(local) && statSync(local).isFile()) {
    h = createHash('sha256').update(readFileSync(local)).digest('hex').slice(0, 10);
  }
  hashCache.set(urlPath, h);
  return h;
}

const pages = walk(ROOT);
const stale = [];
const skippedNoFile = new Set();
const skippedVendor = new Set();
const skippedDynamic = new Set();
const byAsset = new Map();
let refCount = 0, pagesTouched = 0, pagesWithRefs = 0;

function runPass(write) {
  hashCache.clear();                 // a previous pass may have changed the bytes
  const passStale = [];
  let touched = 0;
  refCount = 0; pagesWithRefs = 0; byAsset.clear();

  for (const page of pages) {
    const src = readFileSync(page, 'utf8');
    const isJs = page.endsWith('.js');
    let hasRef = false;

    /* One decision function, two syntaxes. The rewrite differs only in how the
       match is put back together — attribute vs quoted string literal. */
    const decide = (whole, path, ver, rebuild) => {
      hasRef = true;
      refCount++;
      byAsset.set(path, (byAsset.get(path) || 0) + 1);
      if (DYNAMIC.has(path)) { skippedDynamic.add(path); return whole; }
      if (path.includes('/vendor/')) { skippedVendor.add(path); return whole; }
      const h = assetHash(path);
      if (!h) { skippedNoFile.add(path); return whole; }
      if (ver === h) return whole;
      passStale.push({ page: relative(ROOT, page).split(sep).join('/'), path, from: ver, to: h });
      return rebuild(h);
    };

    const next = isJs
      ? src.replace(REF_JS, (whole, q, path, ver) =>
          decide(whole, path, ver, (h) => `${q}${path}?v=${h}${q}`))
      : src.replace(REF, (whole, attr, path, ver) =>
          decide(whole, path, ver, (h) => `${attr}="${path}?v=${h}"`));

    if (hasRef) pagesWithRefs++;
    if (next !== src) {
      touched++;
      if (write) writeFileSync(page, next);
    }
  }
  return { passStale, touched };
}

/* ITERATE TO A FIXED POINT.
 *
 * One pass was enough while only .html carried pins: HTML is never itself a
 * pinned asset, so nothing depended on its hash. Now that .js is scanned, pins
 * CASCADE — rewriting a pin inside a JS file changes that file's bytes, so its
 * own hash changes, so every pin pointing AT it is now stale.
 *
 * Observed on the very first run, three levels deep:
 *     loom-recorder.js -> help-button.js -> auth-guard.js -> 34 html pages
 * A single pass left the tree stale and reported success, which is the exact
 * class of bug this tool exists to prevent — and it would have shipped
 * auth-guard.js under a pin no page requested.
 *
 * Loop until a pass changes nothing. The cap is a runaway guard, not a budget:
 * a pin graph this shallow converges in a handful of passes, and failing loudly
 * beats spinning. --check and --report never write, so they run a single pass;
 * at a fixed point one pass finds nothing, and finding something is the failure
 * they are there to report. */
const MAX_PASSES = 10;
let passes = 0;
if (mode === 'write') {
  for (; passes < MAX_PASSES; passes++) {
    const { passStale } = runPass(true);
    stale.push(...passStale);
    if (!passStale.length) break;
    pagesTouched += new Set(passStale.map(s => s.page)).size;
  }
  if (passes >= MAX_PASSES) {
    console.error(`\nFAIL: pins did not settle after ${MAX_PASSES} passes — a cyclic ?v= reference?`);
    process.exit(1);
  }
} else {
  const { passStale, touched } = runPass(false);
  stale.push(...passStale);
  pagesTouched = touched;
}

const rel = (p) => relative(ROOT, p).split(sep).join('/');
console.log(`scanned ${pages.length} html+js files · ${pagesWithRefs} reference versioned assets · ${refCount} references · ${byAsset.size} distinct assets`);

if (skippedDynamic.size) {
  console.log('\nskipped — served dynamically by the worker (static file is blocked):');
  for (const p of [...skippedDynamic].sort()) console.log('   ' + p);
}
if (skippedNoFile.size) {
  console.log('\nskipped — no file on disk (served dynamically or external):');
  for (const p of [...skippedNoFile].sort()) console.log('   ' + p);
}
if (skippedVendor.size) {
  console.log('\nskipped — vendored, pin is an upstream version with SRI:');
  for (const p of [...skippedVendor].sort()) console.log('   ' + p);
}

if (mode === 'report') {
  console.log('\nassets by reference count:');
  for (const [p, c] of [...byAsset.entries()].sort((a, b) => b[1] - a[1])) {
    const skipped = DYNAMIC.has(p) || p.includes('/vendor/');
    const h = skipped ? null : assetHash(p);
    console.log(`   ${String(c).padStart(3)}  ${p}  ${h ? '→ ' + h : '(not stamped)'}`);
  }
  process.exit(0);
}

if (!stale.length) {
  console.log('\nall pins current.');
  process.exit(0);
}

console.log(`\n${stale.length} stale pin(s) across ${pagesTouched} file(s):`);
for (const s of stale) console.log(`   ${s.page}\n      ${s.path}  ${s.from} → ${s.to}`);

if (mode === 'check') {
  console.log('\nFAIL: pins are stale. Run `node tools/stamp-assets.mjs` and commit before deploying.');
  process.exit(1);
}
console.log('\nrewritten.');
