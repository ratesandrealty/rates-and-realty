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
 * (topbar links are href="inbox"), so try that first and fall back to the .html. */
function urlCandidates(relPath) {
  const noExt = relPath.replace(/\.html$/, '');
  if (noExt === 'index') return ['/'];
  if (noExt.endsWith('/index')) return ['/' + noExt.replace(/\/index$/, '') + '/', '/' + relPath];
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

if (failures) {
  console.log('\nFAIL: the deployed HTML does not match the shipped assets.');
  console.log('Run `node tools/stamp-assets.mjs`, commit, and redeploy.');
  process.exit(1);
}
console.log('\nOK: every live page requests exactly the assets that were shipped.');
