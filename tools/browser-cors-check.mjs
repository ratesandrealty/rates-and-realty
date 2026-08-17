#!/usr/bin/env node
/* Does every edge function a BROWSER calls actually allow the browser in?
 *
 *   node tools/browser-cors-check.mjs            # sweep every invoked slug
 *   node tools/browser-cors-check.mjs voe-form-fill
 *
 * WHY THIS EXISTS
 * voe-form-fill was deployed, ACTIVE, verify_jwt matching its pin, and answered
 * curl perfectly — while being unreachable from the page for ELEVEN DAYS. Its
 * Access-Control-Allow-Headers listed 'Content-Type, Authorization, apikey' and
 * omitted x-client-info, which supabase-js attaches to every functions.invoke().
 * A preflight that does not allow back EVERY requested header fails, so the
 * browser abandoned the request and never sent the POST.
 *
 * The user saw "Failed to send a request to the Edge Function" — supabase-js's
 * CLIENT-SIDE FunctionsFetchError, which reads like the function is down or
 * missing. The edge log showed OPTIONS 200 and no POST after it. That pairing —
 * a successful preflight followed by nothing — is the signature.
 *
 * IT SURVIVED BECAUSE curl and Deno send no preflight and enforce no CORS.
 * Every server-side check passed, every Node proof passed, and the page was
 * broken the whole time. This tool exists because "it works from the terminal"
 * is not evidence about a browser, and nothing else here tested that boundary.
 *
 * WHAT THIS TOOL DOES NOT PROVE: that the page works. It checks one header on
 * one preflight. A green sweep says the browser will be allowed to send the
 * request, not that the response is correct or that the feature functions.
 * The authoritative check is a real browser making a real supabase-js call.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const SB = 'https://ljywhvbmsibwnssxpesh.supabase.co';
const ORIGIN = 'https://admin.ratesandrealty.com';

/* Exactly what supabase-js triggers. x-client-info is the one that matters and
   the one that was missing; the others are listed because a preflight must allow
   back every header the browser asks for, not merely the interesting one. */
const REQUESTED = 'authorization,x-client-info,apikey,content-type';
const MUST_ALLOW = ['authorization', 'x-client-info', 'apikey', 'content-type'];

const ROOTS = ['admin', 'dashboard', 'components', 'api'];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch (_) { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch (_) { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (['.html', '.js'].includes(extname(p))) out.push(p);
  }
  return out;
}

function discoverSlugs() {
  const found = new Map();               // slug -> Set(files)
  for (const root of ROOTS) {
    for (const f of walk(root)) {
      const src = readFileSync(f, 'utf8');
      /* Only functions.invoke(). A raw fetch() sends no x-client-info unless the
         caller adds it, so it is not exposed to this failure — esign-docs is
         called that way and works today despite omitting the header. Widening
         this regex to all fetches would report failures that cannot happen. */
      for (const m of src.matchAll(/functions\.invoke\(\s*['"]([a-z0-9-]+)['"]/g)) {
        if (!found.has(m[1])) found.set(m[1], new Set());
        found.get(m[1]).add(f);
      }
    }
  }
  return found;
}

async function preflight(slug) {
  const r = await fetch(`${SB}/functions/v1/${slug}`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': REQUESTED,
    },
  });
  const allowRaw = r.headers.get('access-control-allow-headers') || '';
  const allowOrigin = r.headers.get('access-control-allow-origin') || '';
  const allow = allowRaw.toLowerCase();
  const missing = MUST_ALLOW.filter((h) => !allow.includes(h));
  return { status: r.status, allowRaw, allowOrigin, missing };
}

const argv = process.argv.slice(2);
const discovered = discoverSlugs();
const slugs = argv.length ? argv : [...discovered.keys()].sort();

if (!slugs.length) {
  console.error('no functions.invoke() call sites found — refusing to report a clean sweep');
  process.exit(2);
}

console.log(`[browser-cors] ${slugs.length} slug(s) called via supabase-js functions.invoke()\n`);

let bad = 0;
for (const slug of slugs) {
  let r;
  try { r = await preflight(slug); }
  catch (e) { console.log(`  ERROR    ${slug} — ${e.message}`); bad++; continue; }

  const callers = discovered.has(slug) ? [...discovered.get(slug)].join(', ') : '(named on the command line)';
  if (r.status >= 400) {
    console.log(`  FAIL     ${slug} — preflight returned ${r.status}`);
    console.log(`           called from: ${callers}`);
    bad++;
  } else if (!r.allowOrigin) {
    console.log(`  FAIL     ${slug} — preflight ${r.status} with NO Access-Control-Allow-Origin`);
    console.log(`           called from: ${callers}`);
    bad++;
  } else if (r.missing.length) {
    console.log(`  BLOCKED  ${slug} — preflight ${r.status}, but does not allow: ${r.missing.join(', ')}`);
    console.log(`           allows: ${r.allowRaw}`);
    console.log(`           the browser will NOT send the request; supabase-js reports`);
    console.log(`           "Failed to send a request to the Edge Function"`);
    console.log(`           called from: ${callers}`);
    bad++;
  } else {
    console.log(`  ok       ${slug}`);
  }
}

console.log(
  bad
    ? `\n[browser-cors] ${bad} of ${slugs.length} would be BLOCKED in a browser.`
    : `\n[browser-cors] OK — all ${slugs.length} allow every header supabase-js sends.`,
);
console.log('This checks the preflight only. It does not prove the page works.');
/* process.exitCode, NOT process.exit(). process.exit() with sockets still open
   aborts teardown on Windows ("Assertion failed: !(handle->flags &
   UV_HANDLE_CLOSING)") and the crash REPLACES the exit code with 0 — so a run
   that correctly found a blocked function reported success. A gate that always
   exits 0 is worse than no gate, because it is believed. */
process.exitCode = bad ? 1 : 0;
