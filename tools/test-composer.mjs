#!/usr/bin/env node
/* Behavioural tests for the inbox composer's SANITIZER.
 *
 * WHY THIS EXISTS. admin/js/inbox.js is the one file where a silent divergence
 * is a security bug rather than drift: every scrap of HTML that becomes outbound
 * mail passes through sanitize(), and the config carries fixes that took several
 * rounds to get right (the style-declaration filter, ADD_URI_SAFE_ATTR for
 * table-based signatures). Before this file the repo had ZERO behavioural tests
 * for any browser JS — tools/check-js.mjs asserts a file is non-empty, parses and
 * contains its anchors, which says nothing about what it does.
 *
 * It exists now because the composer is about to be extracted into
 * admin/js/composer.js, and "the extraction changed nothing" is a claim that
 * needs a number on both sides of it rather than a promise.
 *
 * HOW. jsdom + the VENDORED purify.min.js — the same bytes the browser loads,
 * not an npm copy that could differ from what is pinned by SRI. inbox.js is
 * eval'd into that window and the real window.GmailInbox.sanitize is exercised.
 * No mocks: a mocked sanitizer would test the mock.
 *
 *   node tools/test-composer.mjs            # run
 *   node tools/test-composer.mjs --verbose  # print every assertion
 */
import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

/* The composer may live in inbox.js today and composer.js after the extraction.
 * Load whichever exist, in that order, into the SAME window — the extracted
 * component is expected to keep using inbox.js's exported sanitize, and loading
 * both is how that stays true rather than assumed. */
const SOURCES = ['admin/js/inbox.js', 'admin/js/composer.js'].filter((p) => existsSync(join(ROOT, p)));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; if (VERBOSE) console.log(`  ok   ${name}`); }
  else { fail++; failures.push([name, detail]); console.log(`  FAIL ${name}${detail ? '\n         ' + detail : ''}`); }
}
const has = (h, s) => String(h).toLowerCase().includes(s.toLowerCase());

const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
const w = dom.window;
w.eval(readFileSync(join(ROOT, 'admin/js/vendor/purify.min.js'), 'utf8'));
for (const s of SOURCES) w.eval(readFileSync(join(ROOT, s), 'utf8'));

const GI = w.GmailInbox;
if (!GI || typeof GI.sanitize !== 'function') {
  console.error('FATAL: window.GmailInbox.sanitize not found after loading:', SOURCES.join(', '));
  process.exit(2);
}
const S = GI.sanitize;

console.log(`[test-composer] sources: ${SOURCES.join(', ')}`);
console.log('\n── sanitizer: script and event handlers ─────────────────');
check('<script> is removed entirely', !has(S('<b>hi</b><script>alert(1)</script>'), 'alert(1)'));
check('<script> removal keeps surrounding content', has(S('<b>hi</b><script>alert(1)</script>'), 'hi'));
check('onerror= attribute is stripped', !has(S('<img src="x" onerror="alert(1)">'), 'onerror'));
check('onclick= attribute is stripped', !has(S('<div onclick="alert(1)">t</div>'), 'onclick'));
check('javascript: href is stripped', !has(S('<a href="javascript:alert(1)">x</a>'), 'javascript:'));
check('<iframe> is removed', !has(S('<iframe src="https://evil.test"></iframe>'), '<iframe'));
check('<style> block is removed', !has(S('<style>body{x:1}</style><p>k</p>'), '<style'));
check('https href survives', has(S('<a href="https://ratesandrealty.com">x</a>'), 'https://ratesandrealty.com'));

console.log('\n── sanitizer: the style-declaration filter ──────────────');
const posFixed = S('<div style="position:fixed;color:red">t</div>');
check('position:fixed declaration dropped', !has(posFixed, 'fixed'), posFixed);
check('  …and its sibling declaration survives', has(posFixed, 'color'), posFixed);
const posAbs = S('<div style="position:absolute;color:red">t</div>');
check('position:absolute declaration dropped', !has(posAbs, 'absolute'), posAbs);
check('  …and its sibling declaration survives', has(posAbs, 'color'), posAbs);
check('position:static is NOT dropped', has(S('<div style="position:static">t</div>'), 'static'));

const httpUrl = S('<div style="background:url(http://evil.test/a.png);color:red">t</div>');
check('non-https url() declaration dropped', !has(httpUrl, 'evil.test'), httpUrl);
check('  …and its sibling declaration survives', has(httpUrl, 'color'), httpUrl);
const jsUrl = S('<div style="background:url(javascript:alert(1));color:red">t</div>');
check('url(javascript:) declaration dropped', !has(jsUrl, 'javascript'), jsUrl);
check('  …and its sibling declaration survives', has(jsUrl, 'color'), jsUrl);
const httpsUrl = S('<div style="background:url(https://cdn.test/a.png)">t</div>');
check('https url() preserved', has(httpsUrl, 'https://cdn.test/a.png'), httpsUrl);
const dataUrl = S('<div style="background:url(data:image/png;base64,iVBORw0KGgo=)">t</div>');
check('data:image/ url() preserved', has(dataUrl, 'data:image/png'), dataUrl);
const dataNonImg = S('<div style="background:url(data:text/html;base64,PHN2Zz4=)">t</div>');
check('data: non-image url() dropped', !has(dataNonImg, 'data:text/html'), dataNonImg);
/* The semicolon splitter is paren-aware; a ; inside url() must not split the
 * declaration and orphan half of it. base64 payloads routinely contain none, so
 * this is the case that regresses unnoticed. */
const semiInUrl = S('<div style="background:url(data:image/png;base64,AAA=);color:red">t</div>');
check('semicolon inside url() does not split the declaration', has(semiInUrl, 'color') && has(semiInUrl, 'data:image/png'), semiInUrl);

console.log('\n── the branded signature round-trip ─────────────────────');
const SIG = [
  '<table cellpadding="6" cellspacing="0" border="0" bgcolor="#ffffff" width="600">',
  '<tbody><tr>',
  '<td colspan="2" valign="top" align="left" bgcolor="#f7f4ec">',
  '<img src="https://ratesandrealty.com/logo.png" width="120" height="40" alt="Rates &amp; Realty">',
  '</td></tr><tr><td>',
  '<a href="https://cal.com/rene-duarte-rates-realty">Book a call</a>',
  '<a href="https://ratesandrealty.com/apply">Apply</a>',
  '<a href="https://ratesandrealty.com/search-homes">Search homes</a>',
  '<a href="mailto:rene@ratesandrealty.com">Email</a>',
  '</td></tr></tbody></table>',
].join('');
const sig = S(SIG);
for (const attr of ['cellpadding', 'cellspacing', 'bgcolor', 'colspan', 'valign', 'width', 'height', 'border', 'align'])
  check(`signature keeps ${attr}`, has(sig, attr), sig.slice(0, 200));
check('signature keeps the <table> element', has(sig, '<table'));
check('signature keeps the logo <img> src', has(sig, 'ratesandrealty.com/logo.png'));
for (const href of ['cal.com/rene-duarte-rates-realty', 'ratesandrealty.com/apply', 'ratesandrealty.com/search-homes', 'mailto:rene@ratesandrealty.com'])
  check(`signature keeps CTA href ${href.split('/')[0]}${href.includes('apply') ? '/apply' : href.includes('search') ? '/search' : ''}`, has(sig, href), sig);
check('signature round-trip is idempotent (sanitize twice == once)', S(sig) === sig);

console.log('\n── contract ────────────────────────────────────────────');
check('sanitizerReady() is true when DOMPurify is present', GI.sanitizerReady() === true);
check('PURIFY_CFG is exported', !!GI.PURIFY_CFG && Array.isArray(GI.PURIFY_CFG.ALLOWED_TAGS));
check('PURIFY_CFG allows table tags', ['table', 'tr', 'td'].every((t) => GI.PURIFY_CFG.ALLOWED_TAGS.includes(t)));
check('PURIFY_CFG does NOT allow script/iframe', !GI.PURIFY_CFG.ALLOWED_TAGS.some((t) => t === 'script' || t === 'iframe'));
check('sanitize(null) returns empty string', S(null) === '');
/* The refusal is the point: a missing sanitizer must stop a send, never degrade
 * to sending raw HTML. */
const savedDP = w.DOMPurify;
w.DOMPurify = undefined;
let threw = false;
try { S('<b>x</b>'); } catch (_e) { threw = true; }
w.DOMPurify = savedDP;
check('sanitize THROWS when DOMPurify is missing (never degrades)', threw);
check('sanitizerReady() is false when DOMPurify is missing', (() => { const d = w.DOMPurify; w.DOMPurify = undefined; const r = GI.sanitizerReady(); w.DOMPurify = d; return r === false; })());

console.log(`\n[test-composer] ${pass} passed, ${fail} failed, ${pass + fail} assertions`);
if (fail) {
  console.error('\nFailing assertions:');
  for (const [n, d] of failures) console.error(`  - ${n}${d ? '\n      got: ' + d : ''}`);
  process.exit(1);
}
process.exit(0);
