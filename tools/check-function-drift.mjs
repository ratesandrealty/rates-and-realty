#!/usr/bin/env node
/* Refuse to deploy an edge function when production contains code this repo has
 * never seen.
 *
 * WHY THIS EXISTS. The repo copy of email-service was 85 days behind what was
 * running. The deployed version had the action alias table, link and open
 * tracking, bulk_send, bulk_schedule, send_test, preview, merge tags and
 * attachments; the repo had none of it. `supabase functions deploy
 * email-service` would have silently rolled all of that back, reported success,
 * and broken email marketing with no error anywhere. Four functions were
 * deployed from this checkout on 2026-08-03 and it was luck that this was not
 * one of them. google-calendar-sync and trestle-proxy were behind too — and
 * trestle-proxy's 2-day gap, which looked like a redeploy from timestamps
 * alone, was a GET ?photo= endpoint that listing emails depend on.
 *
 * WHAT IT COMPARES, AND WHY NOT SIMPLY repo-vs-deployed. A plain "refuse if
 * deployed differs from the repo" blocks every legitimate deploy: the whole
 * point of deploying is that you changed the repo and production has not caught
 * up yet. The question that actually distinguishes safe from dangerous is not
 * "are they different" but "is what is running something we have a record of".
 * So the deployed bytes are compared against EVERY committed revision of that
 * file, across all branches:
 *
 *   - matches the working tree            in sync, nothing to lose
 *   - matches some earlier committed rev  the repo has moved ahead; deploying
 *                                         replaces a known state. Allowed.
 *   - matches nothing in history          production holds code that has never
 *                                         been in this repo. Deploying destroys
 *                                         it. REFUSED.
 *
 * Capture it first (`supabase functions download <slug> --use-api`), commit
 * that as a source-only change, then deploy.
 *
 *   node tools/check-function-drift.mjs <slug> [slug...]
 *   node tools/check-function-drift.mjs --all      # sweep every deployed fn
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_REF = 'ljywhvbmsibwnssxpesh';

/* Git stores LF; core.autocrlf leaves CRLF in the working tree; the platform
 * returns LF. Compare content, not checkout conventions. */
const norm = (b) => b.toString('utf8').replace(/\r\n/g, '\n');
const hash = (s) => createHash('sha256').update(norm(s)).digest('hex');

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }
};

function deployedSlugs() {
  const out = execFileSync('supabase', ['functions', 'list', '--project-ref', PROJECT_REF, '-o', 'json'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out).filter((f) => f.status === 'ACTIVE').map((f) => f.slug).sort();
}

/* Every committed revision of this path, on every branch. */
function historicalHashes(rel) {
  const log = git(['log', '--all', '--format=%H', '--', rel]);
  if (!log) return new Set();
  const set = new Set();
  for (const sha of norm(log).split('\n').filter(Boolean)) {
    const blob = git(['show', `${sha}:${rel}`]);
    if (blob) set.add(hash(blob));
  }
  return set;
}

function download(slug, work) {
  execFileSync('supabase', ['functions', 'download', slug, '--project-ref', PROJECT_REF, '--use-api', '--workdir', work],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const p = join(work, 'supabase', 'functions', slug, 'index.ts');
  return existsSync(p) ? readFileSync(p) : null;
}

const args = process.argv.slice(2);
const all = args.includes('--all');
const slugs = all ? deployedSlugs() : args.filter((a) => !a.startsWith('-'));

if (!slugs.length) {
  console.error('usage: check-function-drift.mjs <slug> [slug...] | --all');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'fn-drift-'));
const drifted = [], missing = [], ahead = [], synced = [], unreadable = [];

try {
  process.stderr.write(`[drift] comparing ${slugs.length} function(s) against deployed…\n`);
  for (const slug of slugs) {
    const rel = `supabase/functions/${slug}/index.ts`;
    const abs = join(ROOT, rel);
    let live, downloadErr = null;
    try { live = download(slug, work); } catch (e) { live = null; downloadErr = String(e.stderr || e.message || e).trim().split('\n')[0]; }
    /* Not drift. Saying "production holds code you have no record of" when the
     * truth is "the download failed" is the same defect this tool exists to
     * catch: reporting on a call's outcome without looking at what came back.
     * Still fatal — an unverifiable function is not a deployable one. */
    if (!live) { unreadable.push([slug, downloadErr || 'no index.ts in the downloaded bundle']); continue; }
    const liveHash = hash(live);

    if (!existsSync(abs)) { missing.push(slug); continue; }
    if (liveHash === hash(readFileSync(abs))) { synced.push(slug); continue; }
    if (historicalHashes(rel).has(liveHash)) { ahead.push(slug); continue; }
    drifted.push([slug, 'deployed source matches no committed revision']);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (synced.length) console.log(`[drift] in sync: ${synced.length}`);
if (ahead.length) {
  console.log(`[drift] repo ahead of deployed (safe to deploy): ${ahead.length}`);
  for (const s of ahead) console.log(`    ${s}`);
}

if (!drifted.length && !missing.length && !unreadable.length) {
  console.log(`[drift] OK — every deployed function is captured in this repo.`);
  process.exit(0);
}

console.error('\n[drift] DEPLOY BLOCKED\n');
for (const [s, why] of unreadable) {
  console.error(`  COULD NOT VERIFY  ${s}`);
  console.error(`    ${why}`);
  console.error(`    Not necessarily drift — but an unverifiable function is not a deployable one.\n`);
}
for (const s of missing) {
  console.error(`  NO REPO SOURCE  ${s}`);
  console.error(`    Deployed, but supabase/functions/${s}/index.ts does not exist.\n`);
}
for (const [s, why] of drifted) {
  console.error(`  DRIFTED  ${s}`);
  console.error(`    ${why}.`);
  console.error(`    Production holds code this repo has no record of. Deploying would destroy it.\n`);
}
console.error('Capture production first, then deploy:');
console.error(`  supabase functions download <slug> --project-ref ${PROJECT_REF} --use-api`);
console.error('  git add -A && git commit -m "Capture deployed <slug>"    (source-only, no deploy)\n');
process.exit(1);
