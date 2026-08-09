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
import { readFileSync, existsSync, statSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
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
  /* Floor was 2000 for a 91 KB file — it would have passed a copy that lost 97%
   * of itself. Measured at 91349, set at ~85%. Anchors are the module's export
   * and the two things a truncated tail would drop. */
  'admin/js/staff-chat.js':   { min: 77000,  require: ['})();', 'function attViewHtml', 'function openLightbox'] },
  'admin/js/loom-recorder.js':{ min: 5000,   require: [] },
  /* The dialer, extracted from lead-detail so the FAB can open it anywhere. A
   * truncated copy takes the lead-detail Call button AND the FAB's Call row with
   * it, and the failure is silent — openCallModal simply would not exist.
   * Floor measured at 39699, set at ~85%. */
  'admin/js/dialer.js':       { min: 33700,  require: ['})();', 'window.RRDialer', 'function ensureSdk', 'window.openCallModal'] },
  /* The one clock. Every converted surface calls window.RRTime and renders
   * nothing at all if it is missing, so a truncated copy blanks timestamps
   * app-wide rather than showing a wrong one — which is the safer failure, but
   * still a failure worth gating. Floor measured at 6362, set at ~85%. */
  'admin/js/rr-time.js':      { min: 5400,   require: ['})();', 'window.RRTime', 'America/Los_Angeles'] },
  /* The single bottom-right FAB. It is app-wide (auth-guard mounts it on every
   * authenticated page) and it HIDES the two original floating buttons, so a
   * truncated copy takes the pin and chat entrances with it — the widgets would
   * still be loaded and still be display:none, with nothing left to open them.
   * Floor measured at 13043, set at ~85%. Anchors are the forwarding call and
   * the registry a truncated head would lose. */
  'admin/js/action-fab.js':   { min: 11000,  require: ['})();', 'var ACTIONS', 'function mirrorBadge'] },
  /* The single attachment viewer behind BOTH the email attachment path and (once
   * mounted) staff chat. Floor measured at 10747 bytes, set at ~85%. */
  'admin/js/attachment-viewer.js': { min: 9000, require: ['})();', 'window.AttachmentViewer', 'function loadPdfJs'] },
  /* The heartbeat feeding "active time". Floor measured at 5877, set at ~85%. */
  'admin/js/presence.js': { min: 5000, require: ['})();', 'presence_beat', 'presence_day'] },
  /* The single place edge-function calls get their auth. If this file were
     truncated, fnFetch would be undefined and every migrated call site would
     throw — so it is guarded like the other shared modules. Floor measured at
     4372, set at ~85%. */
  'admin/js/fn-call.js': { min: 3700, require: ['})();', 'window.fnFetch', 'window.fnCall'] },
  /* The single share path. lead-detail's toggle AND the unshared-lead nudge popup
     both write through it, so a truncated copy takes out both. Floor measured at
     4320, set at ~85%. */
  'admin/js/lead-share.js': { min: 3600, require: ['})();', 'window.LeadShare', 'function grant'] },
  /* The unshared-lead nudge popup, mounted by BOTH lead-detail.html and
     dashboard/admin.html. Floor measured at 6491, set at ~85%. */
  'admin/js/share-nudge.js': { min: 5500, require: ['})();', 'window.ShareNudge', 'LeadShare.grant'] },
  'src/worker.js':            { min: 15000,  require: ['export default'] },
  'tools/stamp-assets.mjs':   { min: 2000,   require: [] },
  /* The lead picker is the single implementation behind three mount points; a
   * truncated copy would silently take all three out at once. */
  'dashboard/utils/lead-picker.js': { min: 6000, require: ['})();', 'window.LeadPicker', 'function mount'] },
  'dashboard/utils/calendar.js':    { min: 20000, require: ['})();', 'function getViewRange'] },
  'dashboard/utils/clickup-tasks.js': { min: 15000, require: ['})();'] },

  /* HTML pages carrying substantial inline script. Unguarded until a dangling
   * ").join('');" in people.html shipped to production and broke the whole
   * page — this list existed, the deploy gate ran, and neither looked at the
   * file that was broken. Anchors are the LAST thing in each page's script, so
   * a truncated tail fails the check even if what survives happens to parse. */
  'admin/people.html':          { min: 180000, require: ['function applyFilters', 'writeFiltersToUrl'] },
  /* notifOpen/window.notifOpen were the tail anchors until the bell moved to
   * admin/js/notif-bell.js. Replaced with the LAST function each file defines,
   * which is what the anchor was always meant to be — proof the tail arrived. */
  'admin/lead-detail.html':     { min: 2000000, require: ['function goBack', 'function _mfRenderLenderBody'] },
  'dashboard/admin.html':       { min: 300000, require: ['function _activity', 'NotifBell.mount'] },
  /* The bell both of the above now depend on. Floor measured at 11-12 KB. */
  'admin/js/notif-bell.js':     { min: 9000,   require: ['})();', 'window.NotifBell', 'function open'] },
  'admin/email-marketing.html': { min: 95000,  require: ['function emVideo'] },
  'admin/pipeline.html':        { min: 12000,  require: [] },
  'admin/lenders.html':         { min: 140000, require: [] },
  'admin/video-chats.html':     { min: 6000,   require: ['video_chat_sessions'] },
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

  /* HTML: parse the INLINE SCRIPT BLOCKS, one at a time, the way a browser does.
   *
   * This guard only ever covered .js/.mjs, so the biggest and most-edited files
   * in the repo — lead-detail.html at 2.3 MB, people.html, dashboard/admin.html
   * — were never parsed at all. A scripted edit left a dangling ").join('');"
   * in people.html, deploy.sh ran check-js, check-js said "OK — 10 guarded
   * files", and the page shipped with its entire inline script failing to
   * parse: static nav, nothing else. The gate was honest; it just wasn't
   * looking here.
   *
   * Blocks are checked SEPARATELY because that is how a browser treats them: a
   * parse error in one does not stop the next, but it does kill everything in
   * that block. Concatenating them could also mask an imbalance in one by
   * cancelling it against another.
   *
   * Only executable blocks: no src= (that's a separate file, guarded on its own
   * terms) and no non-JS type= (application/json, text/template). */
  if (src && /\.html?$/i.test(path)) {
    const blocks = [...src.matchAll(/<script([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
      .filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs)
        && !/\btype\s*=\s*["']?(?!text\/javascript|module|application\/javascript)[^"'\s>]+/i.test(attrs));
    if (!blocks.length) errs.push(`${path}: no inline <script> blocks found — extraction may be broken`);
    blocks.forEach(([, , code], i) => {
      const where = `${path} inline block ${i + 1}/${blocks.length}`;
      try {
        new Function(code);
      } catch (scriptErr) {
        const tmp = `${tmpdir()}/checkjs-${randomUUID()}.mjs`;
        try {
          writeFileSync(tmp, code);
          execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
        } catch (modErr) {
          const detail = (modErr.stderr && modErr.stderr.toString().trim().split('\n').find((l) => /Error|error/.test(l)))
            || scriptErr.message;
          errs.push(`${where}: SYNTAX ERROR — ${detail}`);
        } finally { try { unlinkSync(tmp); } catch (_) {} }
      }
    });
    for (const needle of (opts.require || [])) {
      if (!src.includes(needle)) errs.push(`${path}: missing required anchor ${JSON.stringify(needle)} — the tail of the file may be missing`);
    }
    return errs;
  }

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
let failures = [], warnings = [], sweptPages = 0;

/* ── EVERY HTML PAGE WITH INLINE SCRIPT, NOT JUST THE LISTED ONES ───────────
 *
 * GUARDED is hand-curated, and the curation is the hole. When admin/settings.html
 * shipped with `changeDisplayName('' + u.user_id + '', ...)` — escaped quotes
 * that had lost their backslashes — the page's ONE inline script failed to
 * parse, so nothing ran and the content area rendered empty behind an intact
 * static shell. check-js reported "OK — 26 guarded files" and was telling the
 * truth: settings.html was not one of them.
 *
 * It had all the machinery already. HTML inline-block parsing was added after
 * people.html shipped broken; what was missing was settings.html's NAME in a
 * list somebody has to remember to update. An audit at the time of this change
 * found 37 of 44 pages with >=4KB of inline script were unlisted, including
 * sign.html, auth/index.html and the public portal.
 *
 * So discovery replaces memory. Every .html in the repo is parse-checked.
 * Pages already in GUARDED keep their stronger checks (byte floor + tail
 * anchors, which need measuring per file and cannot be inferred); everything
 * else gets the parse check, which is the one that would have caught this and
 * costs nothing to apply universally.
 *
 * Deliberately NOT extended to scope analysis — a name that exists but is out
 * of scope still parses fine. That needs a real scope analyser (ESLint
 * no-undef), and is separate work. */
const SWEEP_SKIP = /(^|\/)(node_modules|\.git|\.claude|\.wrangler|\.db-observe|snapshots)(\/|$)/;
function discoverHtml(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = `${dir}/${e.name}`.replace(/^\.\//, '');
    if (SWEEP_SKIP.test(p)) continue;
    if (e.isDirectory()) discoverHtml(p, out);
    else if (/\.html?$/i.test(e.name)) out.push(p);
  }
  return out;
}

if (argv.includes('--baseline') || argv.length === 0) {
  for (const [p, o] of Object.entries(GUARDED)) {
    if (!existsSync(p)) continue;
    failures.push(...check(p, o));
    const w = baselineDrift(p); if (w) warnings.push(w);
  }
  /* Parse-only sweep over every unlisted HTML page. No floor, no anchors —
   * those are per-file measurements. A page with no inline script at all is
   * skipped rather than reported, since "no blocks found" is only meaningful
   * for a page that is supposed to have them. */
  for (const p of discoverHtml('.')) {
    if (GUARDED[p]) continue;
    let src = '';
    try { src = readFileSync(p, 'utf8'); } catch { continue; }
    const hasInline = [...src.matchAll(/<script([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
      .some(([, attrs, code]) => !/\bsrc\s*=/i.test(attrs || '') && code.trim().length > 0);
    if (!hasInline) continue;
    sweptPages++;
    failures.push(...check(p, { min: 0, require: [] }));
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
console.log(`OK — ${argv.includes('--baseline') || argv.length === 0 ? Object.keys(GUARDED).filter(existsSync).length + ' guarded files + ' + sweptPages + ' swept HTML page(s)' : argv[0]}: non-empty, above floor, parses, anchors present.`);
