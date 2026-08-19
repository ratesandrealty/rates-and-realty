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

/* Two kinds of browser caller, and they are exposed differently.
 *
 *   invoke    functions.invoke() — supabase-js attaches x-client-info itself, so
 *             the preflight MUST allow it. Omit it and the call is impossible.
 *   fetch     a hand-built fetch('/functions/v1/<slug>') — sends only the headers
 *             the caller chose, so it survives a narrow allow-list. esign-docs is
 *             called this way, which is the only reason it worked while
 *             voe-form-fill, with the identical header list, did not.
 *
 * A 'fetch' caller is NOT broken today. It is a LATENT one: convert that call to
 * functions.invoke() — the obvious tidy-up — and it breaks instantly, with no
 * change to the function to explain it. Reported, not failed. */
function discoverSlugs() {
  const found = new Map();               // slug -> { invoke:Set, fetch:Set }
  const add = (slug, kind, file) => {
    if (!found.has(slug)) found.set(slug, { invoke: new Set(), fetch: new Set() });
    found.get(slug)[kind].add(file);
  };
  for (const root of ROOTS) {
    for (const f of walk(root)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/functions\.invoke\(\s*['"]([a-z0-9-]+)['"]/g)) add(m[1], 'invoke', f);
      for (const m of src.matchAll(/functions\/v1\/([a-z0-9-]+)/g)) add(m[1], 'fetch', f);
      /* THE THIRD CALL SHAPE, and it was invisible here until 2026-08-19.
         admin/js/fn-call.js wraps the URL up: fnFetch('slug') names the function
         without the /functions/v1/ path, so neither pattern above sees it. Eight
         real browser callers — call-intelligence, delete-contacts,
         generate-1003-pdf, generate-cma, generate-deal-analysis, generate-mismo,
         generate-mismo-data, pull-comps — had dropped out of the default sweep
         entirely, and the run still reported OK. All eight happened to allow
         x-client-info, so nothing was hidden; the point is that nothing would
         have SAID so if they had not.
         Classified 'fetch', not 'invoke': fnFetch builds a raw fetch and picks
         its own headers, so it sends no x-client-info and survives a narrow
         allow-list exactly like a hand-rolled one. Latent, not blocked. */
      for (const m of src.matchAll(/\bfnFetch\(\s*['"]([a-z0-9-]+)['"]/g)) add(m[1], 'fetch', f);
    }
  }
  return found;
}

// Every function in the repo, for --all. A slug no browser calls today is still
// worth knowing about: it is one refactor away from being a browser caller.
function allSlugs() {
  return readdirSync('supabase/functions')
    .filter((d) => !d.startsWith('_') && !d.startsWith('.'))
    .filter((d) => { try { return statSync(join('supabase/functions', d)).isDirectory(); } catch (_) { return false; } })
    .sort();
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
  /* A bare `*` allows everything, and a substring check does not know that — it
     reported claude-ai as missing all four headers when Chrome reaches it fine
     (measured with browser-fn-probe: status 200). A checker that invents
     failures gets ignored, and then it is worthless for the real ones. */
  const wildcard = allow.split(',').map((s) => s.trim()).includes('*');
  const missing = wildcard ? [] : MUST_ALLOW.filter((h) => !allow.includes(h));
  return { status: r.status, allowRaw, allowOrigin, missing, wildcard };
}

const argv = process.argv.slice(2);
const all = argv.includes('--all');
const named = argv.filter((a) => !a.startsWith('--'));
const discovered = discoverSlugs();
const slugs = named.length ? named : (all ? allSlugs() : [...discovered.keys()].sort());

if (!slugs.length) {
  console.error('no slugs to check — refusing to report a clean sweep');
  process.exit(2);
}

console.log(`[browser-cors] checking ${slugs.length} slug(s)${all ? ' (--all: every function in the repo)' : ''}\n`);

/* Severity depends on who calls it, and only the first is broken TODAY:
 *   BLOCKED  an invoke() caller exists — the page cannot reach it. Fails the run.
 *   latent   only a raw fetch() caller, or none. Reported, does not fail. */
let bad = 0;
const latent = [];
for (const slug of slugs) {
  const d = discovered.get(slug);
  const viaInvoke = d ? [...d.invoke] : [];
  const viaFetch = d ? [...d.fetch] : [];

  let r;
  try { r = await preflight(slug); }
  catch (e) { console.log(`  ERROR    ${slug} — ${e.message}`); bad++; continue; }

  const ok = r.status < 400 && r.allowOrigin && !r.missing.length;
  if (ok) { if (!all) console.log(`  ok       ${slug}`); continue; }

  const why = r.status >= 400 ? `preflight returned ${r.status}`
    : !r.allowOrigin ? `preflight ${r.status} with NO Access-Control-Allow-Origin`
    : `does not allow: ${r.missing.join(', ')}`;

  if (viaInvoke.length) {
    console.log(`  BLOCKED  ${slug} — ${why}`);
    console.log(`           allows: ${r.allowRaw || '(none)'}`);
    console.log(`           supabase-js will report "Failed to send a request to the Edge Function"`);
    console.log(`           invoke() caller(s): ${viaInvoke.join(', ')}`);
    bad++;
  } else {
    latent.push({ slug, why, allows: r.allowRaw, viaFetch });
  }
}

if (latent.length) {
  console.log(`\n  ── latent (${latent.length}) — not broken today, breaks the moment a caller uses functions.invoke() ──`);
  for (const l of latent) {
    const who = l.viaFetch.length ? `raw fetch() from ${l.viaFetch.join(', ')}` : 'no browser caller found';
    console.log(`  latent   ${l.slug} — ${l.why}  [${who}]`);
  }
}

console.log(
  bad
    ? `\n[browser-cors] ${bad} of ${slugs.length} would be BLOCKED in a browser (an invoke() caller exists).`
    : `\n[browser-cors] OK — every slug with an invoke() caller allows all headers supabase-js sends.`,
);
if (latent.length) {
  console.log(`[browser-cors] ${latent.length} latent — safe only because nothing calls them via functions.invoke().`);
}
console.log('This checks the preflight only. It does not prove the page works.');
/* process.exitCode, NOT process.exit(). process.exit() with sockets still open
   aborts teardown on Windows ("Assertion failed: !(handle->flags &
   UV_HANDLE_CLOSING)") and the crash REPLACES the exit code with 0 — so a run
   that correctly found a blocked function reported success. A gate that always
   exits 0 is worse than no gate, because it is believed. */
process.exitCode = bad ? 1 : 0;
