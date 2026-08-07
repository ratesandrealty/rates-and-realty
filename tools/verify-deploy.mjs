#!/usr/bin/env node
/**
 * verify-deploy — after `wrangler deploy`, prove the LIVE HTML asks for the asset
 * that was actually shipped.
 *
 * WHY THIS SHAPE
 * Curl-ing the JS file directly is not this check and does not catch the failure it
 * exists for. Fetching /admin/js/inbox.js returns whatever is deployed — which was
 * correct — while every browser kept loading the OLD file, because the HTML still
 * pointed at ?v=<old>. The bug lives in the RELATIONSHIP between the two, so the
 * check has to follow the reference:
 *
 *   1. fetch the live HTML                     → what the browser is told to load
 *   2. read each ?v= pin out of it             → the exact URL it will request
 *   3. fetch the asset AT THAT PINNED URL      → what the browser actually gets
 *   4. hash it, compare to the local file      → is that the code we shipped?
 *
 * Step 3 is the part that matters: it requests the pinned URL, not the bare path.
 *
 * USAGE
 *   node tools/verify-deploy.mjs                       (defaults to admin host)
 *   node tools/verify-deploy.mjs https://example.com
 * Exit code is non-zero if anything is stale, so it can gate a deploy.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const BASE = (process.argv.find((a) => a.startsWith('http')) || 'https://admin.ratesandrealty.com').replace(/\/$/, '');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude', '.wrangler', 'dist', 'build']);
const REF = /(?:src|href)="(\/[^"?]+)\?v=([^"]*)"/g;
// Same exclusions as the stamper, for the same reasons.
const DYNAMIC = new Set(['/api/env.js', '/api/env.example.js']);
const isSkipped = (p) => DYNAMIC.has(p) || p.includes('/vendor/');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

function localHash(urlPath) {
  const local = join(ROOT, urlPath.replace(/^\//, '').split('/').join(sep));
  if (!existsSync(local) || !statSync(local).isFile()) return null;
  return createHash('sha256').update(readFileSync(local)).digest('hex').slice(0, 10);
}

/* File path → the URL the worker serves it at. App HTML is served extensionless
 * (topbar links are href="inbox"), so try that first and fall back to the .html.
 * public/foo.html is ALSO served at the short URL /foo, which is the canonical
 * one and therefore the one worth checking first. */
function urlCandidates(relPath) {
  const noExt = relPath.replace(/\.html$/, '');
  if (noExt === 'index') return ['/', '/index.html'];
  if (noExt.endsWith('/index')) return ['/' + noExt.replace(/\/index$/, '') + '/', '/' + relPath];
  if (noExt.startsWith('public/')) return ['/' + noExt.slice('public/'.length), '/' + noExt, '/' + relPath];
  return ['/' + noExt, '/' + relPath];
}

async function fetchText(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
  return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : '' };
}
async function fetchHash(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) return { ok: false, status: r.status, hash: null };
  const buf = new Uint8Array(await r.arrayBuffer());
  return { ok: true, status: r.status, hash: createHash('sha256').update(buf).digest('hex').slice(0, 10) };
}

const pages = walk(ROOT).filter((p) => {
  const s = readFileSync(p, 'utf8');
  REF.lastIndex = 0;
  return REF.test(s);
});

console.log(`verify-deploy → ${BASE}`);
console.log(`${pages.length} page(s) reference versioned assets\n`);

let checked = 0, failures = 0, unreachable = 0;
const assetCache = new Map();   // pinned url → {ok,hash}

for (const page of pages) {
  const relPath = relative(ROOT, page).split(sep).join('/');
  const src = readFileSync(page, 'utf8');

  // 1) fetch the live HTML for this page
  let live = null, usedUrl = null;
  for (const cand of urlCandidates(relPath)) {
    const r = await fetchText(BASE + cand);
    if (r.ok && r.text) { live = r.text; usedUrl = cand; break; }
  }
  if (!live) { console.log(`  ?  ${relPath}  — not reachable on ${BASE}, skipped`); unreachable++; continue; }

  // 2) read the pins the LIVE html asks for
  const refs = [];
  let m;
  REF.lastIndex = 0;
  while ((m = REF.exec(live)) !== null) refs.push({ path: m[1], ver: m[2] });

  const problems = [];
  for (const { path, ver } of refs) {
    if (isSkipped(path)) continue;
    const want = localHash(path);
    if (!want) continue;                       // not a repo asset
    checked++;

    // (a) does the live HTML point at the code we have?
    if (ver !== want) {
      problems.push(`STALE PIN   ${path}  html asks ?v=${ver}  ·  shipped is ${want}`);
      continue;
    }

    // (b) does that exact pinned URL actually serve those bytes?
    const pinned = `${BASE}${path}?v=${ver}`;
    if (!assetCache.has(pinned)) assetCache.set(pinned, await fetchHash(pinned));
    const got = assetCache.get(pinned);
    if (!got.ok) problems.push(`UNREACHABLE ${path}?v=${ver}  http=${got.status}`);
    else if (got.hash !== want) problems.push(`STALE ASSET ${path}?v=${ver}  served ${got.hash}  ·  shipped ${want}`);
  }

  if (problems.length) {
    failures += problems.length;
    console.log(`  FAIL ${relPath}  (${usedUrl})`);
    for (const p of problems) console.log(`         ${p}`);
  } else {
    console.log(`  ok   ${relPath}  (${usedUrl})`);
  }
}

console.log(`\n${checked} asset reference(s) verified · ${failures} problem(s)` +
  (unreachable ? ` · ${unreachable} page(s) unreachable` : ''));

/* Cloudflare takes a few seconds to propagate freshly uploaded assets. Running this
 * immediately after `wrangler deploy` can therefore read the previous HTML and report
 * a failure that fixes itself — which is worse than useless, because a check that
 * cries wolf gets ignored. Retry a bounded number of times before believing it.
 * A genuinely stale deploy still fails: the retries just expire. */
if (failures && !process.argv.includes('--no-retry')) {
  const attempts = 3, waitMs = 10000;
  for (let i = 1; i <= attempts && failures; i++) {
    console.log(`\npropagation may be in flight — retry ${i}/${attempts} in ${waitMs / 1000}s…`);
    await new Promise((r) => setTimeout(r, waitMs));
    failures = 0;
    assetCache.clear();
    for (const page of pages) {
      const relPath = relative(ROOT, page).split(sep).join('/');
      let live = null;
      for (const cand of urlCandidates(relPath)) {
        const r = await fetchText(BASE + cand);
        if (r.ok && r.text) { live = r.text; break; }
      }
      if (!live) continue;
      const refs = [];
      let mm;
      REF.lastIndex = 0;
      while ((mm = REF.exec(live)) !== null) refs.push({ path: mm[1], ver: mm[2] });
      for (const { path, ver } of refs) {
        if (isSkipped(path)) continue;
        const want = localHash(path);
        if (!want) continue;
        if (ver !== want) { failures++; continue; }
        const pinned = `${BASE}${path}?v=${ver}`;
        if (!assetCache.has(pinned)) assetCache.set(pinned, await fetchHash(pinned));
        const got = assetCache.get(pinned);
        if (!got.ok || got.hash !== want) failures++;
      }
    }
    console.log(`  after retry ${i}: ${failures} problem(s)`);
  }
}

/* ── PASS 2: DID THE PAGE ITSELF SHIP? ───────────────────────────────────────
 *
 * Pass 1 only looks at pages carrying a `?v=` pin, because that is all it can
 * check. Every page under public/ has no pins, so ALL of them — search-homes,
 * unified-portal, portal, contact, property-detail and 25 more — were filtered
 * out and deployed with nothing verified at all. The borrower-facing half of the
 * site was invisible to the deploy gate.
 *
 * This pass compares the SERVED BYTES to the local file. The worker returns HTML
 * byte-identically, so an exact hash match is the right test, and it catches two
 * things pass 1 cannot: a page that never deployed, and a route that serves a
 * DIFFERENT file than the one someone would edit.
 *
 * THE SOFT-404 IS THE REASON THIS MATTERS. Unknown paths answer 200 with
 * index.html, so /search-homes looks like a working page and is the marketing
 * homepage — that already produced one false conclusion during this session, and
 * it is the same soft-404 that once filled the R2 backup with copies of the
 * homepage. A short URL is reported explicitly rather than as a generic
 * mismatch, because "it returns 200" is exactly what makes it convincing.
 *
 * supabase/functions/** is excluded: those .html files are PDF templates
 * compiled into an edge function, not pages, and are correctly not web-served. */
const IS_PAGE = (rel) => !rel.startsWith('supabase/functions/');
const allPages = walk(ROOT)
  .map((p) => relative(ROOT, p).split(sep).join('/'))
  .filter(IS_PAGE);

let indexHash = null;
try { indexHash = localHash('/index.html'); } catch { /* no homepage, fine */ }

/* Propagation retry, same as pass 1 has. Without it this pass fails on almost
 * every deploy — the edge has not caught up yet — and a check that cries wolf
 * routinely is one that gets ignored or switched off. Observed immediately: the
 * first run of this pass failed on admin/lead-detail.html and matched cleanly
 * seconds later. */
async function pageMismatches(list) {
  const out = [];
  for (const rel of list) {
    const want = localHash('/' + rel);
    if (!want) continue;
    const cands = urlCandidates(rel);
    if (!cands.includes('/' + rel)) cands.push('/' + rel);
    let matched = null; const seen = [];
    for (const cand of cands) {
      const got = await fetchHash(BASE + cand);
      seen.push({ cand, ...got });
      if (got.ok && got.hash === want) { matched = cand; break; }
    }
    if (!matched) out.push({ rel, want, seen });
  }
  return out;
}

console.log(`\nchecking ${allPages.length} page(s) actually shipped…`);
let bad = await pageMismatches(allPages);
if (bad.length && !process.argv.includes('--no-retry')) {
  for (let i = 1; i <= 3 && bad.length; i++) {
    console.log(`  ${bad.length} not matching yet — propagation retry ${i}/3 in 10s…`);
    await new Promise((r) => setTimeout(r, 10000));
    bad = await pageMismatches(bad.map((b) => b.rel));
  }
}
let pageFailures = bad.length;
for (const { rel, want, seen } of bad) {
  const canonical = seen[seen.length - 1] || {};
  const soft = seen.find((s) => s.ok && indexHash && s.hash === indexHash && s.cand !== canonical.cand);
  const why = canonical.ok
    ? `served different bytes (${canonical.hash} vs local ${want}) — did this page deploy?`
    : `HTTP ${canonical.status} (not served)`;
  console.log(`  FAIL  ${rel}  — ${canonical.cand || '?'} ${why}`);
  if (soft) console.log(`        note: ${soft.cand} answers 200 with the HOMEPAGE (soft 404) — not a real route.`);
}
if (!pageFailures) console.log(`  all ${allPages.length} page(s) serve their own bytes.`);

/* ── PASS 3: DOES A WRONG URL SAY SO? ────────────────────────────────────────
 *
 * The asset binding used to answer every unmatched path with index.html and a
 * 200. Everything downstream believed it: /search-homes looked like a working
 * page, two borrowers were texted a pre-filtered search that silently became
 * the marketing homepage, and the R2 backup filled with copies of index.html
 * while reporting errors: 0.
 *
 * That is now `not_found_handling = "none"` plus a 404 handler in the worker —
 * a one-line config away from coming back, with no visible symptom. So assert
 * it: a path that does not exist must not answer 200, and must not answer with
 * the homepage. */
console.log('\nchecking that unknown paths 404…');
{
  const probes = ['/definitely-not-a-page-xyzzy', '/public/definitely-not-a-page-xyzzy.html', '/admin/not-a-real-admin-page-xyzzy'];
  let softFound = 0;
  for (const p of probes) {
    const r = await fetch(BASE + p, { redirect: 'manual', headers: { 'cache-control': 'no-cache' } });
    const body = r.status === 200 ? await r.text() : '';
    const isHome = !!(body && indexHash && createHash('sha256').update(body).digest('hex').slice(0, 10) === indexHash);
    if (r.status === 404) { console.log(`  ok   ${p} → 404`); continue; }
    /* On a PUBLIC host the admin gate bounces /admin/* to the admin host before
     * routing ever reaches the 404 handler — a redirect here is the gate doing
     * its job, not a soft 404. Only the admin host can answer this probe with a
     * real 404, and it does. */
    const loc = r.headers.get('location') || '';
    if (r.status >= 300 && r.status < 400 && /admin\.ratesandrealty\.com/.test(loc)) {
      console.log(`  ok   ${p} → ${r.status} to the admin host (admin gate, not a soft 404)`);
      continue;
    }
    softFound++;
    console.log(`  FAIL ${p} → HTTP ${r.status}${isHome ? ' serving the HOMEPAGE — the soft-404 is back' : ''}`);
    if (isHome) console.log('        check not_found_handling in wrangler.toml; it must be "none".');
  }
  if (softFound) pageFailures += softFound;
}


if (failures) {
  console.log('\nFAIL: the deployed HTML does not match the shipped assets.');
  console.log('Run `node tools/stamp-assets.mjs`, commit, and redeploy.');
  process.exit(1);
}
if (pageFailures) {
  console.log(`\nFAIL: ${pageFailures} page(s) are not serving what this repo holds.`);
  process.exit(1);
}
console.log('\nOK: every live page requests exactly the assets that were shipped,');
console.log('    and every page serves the bytes this repo holds.');
