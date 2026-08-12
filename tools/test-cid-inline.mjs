/**
 * test-cid-inline — the cid: matcher and rewriter from admin/js/inbox.js.
 *
 *   node tools/test-cid-inline.mjs
 *
 * WHY THIS IS A TEST AND NOT A READ-THROUGH. Inline mail images are the one part
 * of the thread viewer with no cheap manual check: proving it by hand means
 * finding a thread that still carries a cid: signature, opening it with a live
 * session, and eyeballing a logo. The regex is where the bugs are — the first
 * version could not match src="cid:<id>", the bracketed form some Exchange and
 * Notes generators emit, and that was caught HERE rather than by reading it.
 *
 * The functions are LIFTED OUT OF inbox.js at runtime rather than retyped, so
 * these cannot pass against a copy that has drifted from what actually ships.
 */
import fs from 'fs';
const src = fs.readFileSync('admin/js/inbox.js', 'utf8');

// Lift the three pieces out of the IIFE so they are tested as written, not retyped.
function lift(name, startRe) {
  const i = src.search(startRe);
  if (i < 0) throw new Error('could not find ' + name);
  return i;
}
const reLine = src.slice(src.indexOf('var CID_SRC_RE ='));
const CID_SRC_RE_SRC = reLine.slice(0, reLine.indexOf('\n'));
const rwStart = src.indexOf('function rewriteCidSrc(');
const rwEnd = src.indexOf('\n  }', rwStart) + 4;
const REWRITE_SRC = src.slice(rwStart, rwEnd);

const mod = new Function(CID_SRC_RE_SRC + '\n' + REWRITE_SRC + '\nreturn { CID_SRC_RE, rewriteCidSrc };')();
const { CID_SRC_RE, rewriteCidSrc } = mod;

let pass = 0, fail = 0;
function t(label, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? '  OK   ' : '  FAIL ') + label);
  if (!ok) { console.log('        got  : ' + got); console.log('        want : ' + want); }
}

const MAP = { 'ii_abc123': 'blob:X', 'logo@rr': 'blob:Y' };

console.log('cid: rewriting');
t('double-quoted',
  rewriteCidSrc('<img src="cid:ii_abc123">', MAP), '<img src="blob:X">');
t('single-quoted',
  rewriteCidSrc("<img src='cid:ii_abc123'>", MAP), '<img src="blob:X">');
t('unquoted',
  rewriteCidSrc('<img src=cid:ii_abc123>', MAP), '<img src="blob:X">');
t('angle-bracketed cid (raw header form)',
  rewriteCidSrc('<img src="cid:<ii_abc123>">', MAP), '<img src="blob:X">');
t('case-insensitive cid scheme + id',
  rewriteCidSrc('<img src="CID:II_ABC123">', MAP), '<img src="blob:X">');
t('url-encoded cid',
  rewriteCidSrc('<img src="cid:logo%40rr">', MAP), '<img src="blob:Y">');
t('attributes preserved before src',
  rewriteCidSrc('<img width="120" alt="image0.jpeg" src="cid:ii_abc123" border="0">', MAP),
  '<img width="120" alt="image0.jpeg" src="blob:X" border="0">');
t('UNRESOLVED cid is left untouched, not blanked',
  rewriteCidSrc('<img src="cid:unknown999">', MAP), '<img src="cid:unknown999">');
t('two images in one body',
  rewriteCidSrc('<img src="cid:ii_abc123"><br><img src="cid:logo@rr">', MAP),
  '<img src="blob:X"><br><img src="blob:Y">');
t('a signature table survives intact',
  rewriteCidSrc('<table><tr><td><img src="cid:logo@rr" width="88"></td><td>Rene</td></tr></table>', MAP),
  '<table><tr><td><img src="blob:Y" width="88"></td><td>Rene</td></tr></table>');
t('non-img cid: (a link) is NOT rewritten',
  rewriteCidSrc('<a href="cid:ii_abc123">x</a>', MAP), '<a href="cid:ii_abc123">x</a>');
t('remote https src untouched',
  rewriteCidSrc('<img src="https://example.com/a.png">', MAP), '<img src="https://example.com/a.png">');
t('empty body', rewriteCidSrc('', MAP), '');
t('null map returns input', rewriteCidSrc('<img src="cid:ii_abc123">', null), '<img src="cid:ii_abc123">');

// lastIndex hygiene: a /g regex reused across calls silently skips matches.
console.log('\nregex statefulness (the /g lastIndex trap)');
const body = '<img src="cid:ii_abc123">';
const a = rewriteCidSrc(body, MAP), b = rewriteCidSrc(body, MAP), c = rewriteCidSrc(body, MAP);
t('same input rewrites identically three times in a row', a === b && b === c && a === '<img src="blob:X">', true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
