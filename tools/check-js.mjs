#!/usr/bin/env node
/**
 * check-js — assert a JS file is syntactically valid AND plausibly complete.
 *
 * WHY THIS EXISTS
 * The ad-hoc check this replaces was `new Function(readFileSync(path))`. It
 * reports OK on an EMPTY FILE, because an empty program is valid JavaScript.
 * During this session a scripted edit truncated admin/js/inbox.js to 0 bytes —
 * Python's open(path,'w') truncates before the write that later threw — and the
 * check said "parses OK". Nothing downstream caught it either: stamp-assets
 * would have minted a fresh content hash for the empty file, and verify-deploy
 * would have confirmed the live page requested exactly those (empty) bytes.
 * Every guard agreed, because every guard was checking consistency rather than
 * completeness.
 *
 * So this asserts three things:
 *   1. non-zero, and at least --min bytes (default 200)
 *   2. parses
 *   3. contains every --require <needle> (structural anchors: the closing of an
 *      IIFE, an exported name, whatever proves the tail of the file arrived)
 *
 * A partial write that happens to parse is caught by 1 and 3. That is the case
 * that actually shipped undetected, not the empty file.
 *
 * USAGE
 *   node tools/check-js.mjs admin/js/inbox.js
 *   node tools/check-js.mjs admin/js/inbox.js --min 150000 --require "})();" --require "function renderThread"
 *   node tools/check-js.mjs --baseline            check every known file against its committed size
 */
import { readFileSync, existsSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/* Files worth guarding, with the anchors that prove the END of the file is
 * present. Sizes are a FLOOR, deliberately loose — they exist to catch a file
 * that lost most of itself, not to police growth. */
const GUARDED = {
  'admin/js/inbox.js':        { min: 150000, require: ['})();', 'function renderThread', 'function mount'] },
  'admin/js/auth-guard.js':   { min: 8000,   require: ['})();', 'redirectToLogin'] },
  'admin/js/task-capture.js': { min: 20000,  require: ['})();', 'openDialog'] },
  'admin/js/staff-chat.js':   { min: 2000,   require: [] },
  'admin/js/loom-recorder.js':{ min: 5000,   require: [] },
  'src/worker.js':            { min: 15000,  require: ['export default'] },
  'tools/stamp-assets.mjs':   { min: 2000,   require: [] },
  /* The lead picker is the single implementation behind three mount points; a
   * truncated copy would silently take all three out at once. */
  'dashboard/utils/lead-picker.js': { min: 6000, require: ['})();', 'window.LeadPicker', 'function mount'] },
  'dashboard/utils/calendar.js':    { min: 20000, require: ['})();', 'function getViewRange'] },
  'dashboard/utils/clickup-tasks.js': { min: 15000, require: ['})();'] },
};

function check(path, opts) {
  const errs = [];
  if (!existsSync(path)) return [`${path}: does not exist`];
  const bytes = statSync(path).size;
  const min = opts.min ?? 200;

  if (bytes === 0) errs.push(`${path}: FILE IS EMPTY (0 bytes)`);
  else if (bytes < min) errs.push(`${path}: ${bytes} bytes is below the ${min}-byte floor — looks truncated`);

  let src = '';
  try { src = readFileSync(path, 'utf8'); } catch (e) { errs.push(`${path}: unreadable — ${e.message}`); }

  if (src) {
    /* Two dialects. new Function() is a script parser and rejects `export` /
     * top-level `import`, which src/worker.js and tools/*.mjs legitimately use.
     * Try script first, then module — a file is fine if EITHER accepts it. */
    let parseErr = null;
    try {
      new Function(src);
    } catch (scriptErr) {
      const tmp = `${tmpdir()}/checkjs-${randomUUID()}.mjs`;
      try {
        writeFileSync(tmp, src);
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      } catch (modErr) {
        const detail = (modErr.stderr && modErr.stderr.toString().trim().split('\n').find((l) => /Error|error/.test(l)))
          || scriptErr.message;
        parseErr = detail;
      } finally {
        try { unlinkSync(tmp); } catch (_) {}
      }
    }
    if (parseErr) errs.push(`${path}: SYNTAX ERROR — ${parseErr}`);
    for (const needle of (opts.require || [])) {
      if (!src.includes(needle)) errs.push(`${path}: missing required anchor ${JSON.stringify(needle)} — the tail of the file may be missing`);
    }
  }
  return errs;
}

/* Compare working-tree size against the last committed size. A large drop is
 * legitimate sometimes (a refactor that removes code), so this WARNS rather
 * than fails — it is a prompt to look, not a verdict. */
function baselineDrift(path) {
  try {
    const committed = execFileSync('git', ['cat-file', '-s', `HEAD:${path}`], { encoding: 'utf8' }).trim();
    const before = parseInt(committed, 10);
    const now = statSync(path).size;
    if (!before || !now) return null;
    const pct = ((now - before) / before) * 100;
    if (pct <= -20) return `${path}: ${before} → ${now} bytes (${pct.toFixed(0)}%) vs HEAD — verify this shrink is intended`;
  } catch (_) { /* untracked or no git; nothing to compare */ }
  return null;
}

const argv = process.argv.slice(2);
let failures = [], warnings = [];

if (argv.includes('--baseline') || argv.length === 0) {
  for (const [p, o] of Object.entries(GUARDED)) {
    if (!existsSync(p)) continue;
    failures.push(...check(p, o));
    const w = baselineDrift(p); if (w) warnings.push(w);
  }
} else {
  const path = argv[0];
  const opts = { min: undefined, require: [] };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--min') opts.min = Number(argv[++i]);
    else if (argv[i] === '--require') opts.require.push(argv[++i]);
  }
  const known = GUARDED[path.replace(/\\/g, '/')];
  if (known) { opts.min = opts.min ?? known.min; opts.require = opts.require.length ? opts.require : known.require; }
  failures.push(...check(path, opts));
  const w = baselineDrift(path); if (w) warnings.push(w);
}

for (const w of warnings) console.log('warn  ' + w);
if (failures.length) {
  for (const f of failures) console.error('FAIL  ' + f);
  process.exit(1);
}
console.log(`OK — ${argv.includes('--baseline') || argv.length === 0 ? Object.keys(GUARDED).filter(existsSync).length + ' guarded files' : argv[0]}: non-empty, above floor, parses, anchors present.`);
