#!/usr/bin/env node
/* Type-check every edge function source and BLOCK on anything new.
 *
 * WHY THIS EXISTS. gdrive-sync v82 shipped calling getDriveAccessToken() with
 * no import for it and a module-scope `sb` that does not exist. Every borrower
 * document stopped reaching Drive for two and a half days. `deno check` finds
 * both errors in under a second and nothing was running it. The bug was found
 * by accident, while chasing a missing ID photo.
 *
 * WHY A BASELINE RATHER THAN A CLEAN GATE. There are 48 pre-existing errors
 * across 26 functions. Blocking on all of them today would either wedge the
 * deploy or force 48 rushed fixes into an unrelated change. So: every known
 * error is recorded in typecheck-baseline.json, and the gate fails on anything
 * NOT in it. The baseline can only shrink — new code cannot add to it without
 * someone deliberately re-recording it, and `--update-baseline` prints exactly
 * what it is about to bless.
 *
 * ALWAYS-FATAL CODES bypass the baseline entirely. TS2304/TS2552 are undefined
 * identifiers — they are ReferenceErrors at runtime, which is precisely the
 * defect this gate was built for. Those block even if someone baselines them.
 *
 *   node tools/check-functions.mjs                  # gate (used by deploy.sh)
 *   node tools/check-functions.mjs --update-baseline
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FN_DIR = join(ROOT, 'supabase', 'functions');
const BASELINE = join(ROOT, 'tools', 'typecheck-baseline.json');

/* Undefined identifiers. A ReferenceError the moment that line runs. */
const ALWAYS_FATAL = new Set(['TS2304', 'TS2552']);

function sources() {
  const out = [];
  for (const e of readdirSync(FN_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name === '_shared') {
      for (const f of readdirSync(join(FN_DIR, '_shared'))) {
        if (f.endsWith('.ts') && !f.endsWith('.test.ts')) out.push(`supabase/functions/_shared/${f}`);
      }
      continue;
    }
    const idx = join(FN_DIR, e.name, 'index.ts');
    if (existsSync(idx)) out.push(`supabase/functions/${e.name}/index.ts`);
  }
  return out.sort();
}

function runCheck(files) {
  try {
    execFileSync('deno', ['check', ...files], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return '';
  } catch (e) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
}

/* Key on code + file + message, NOT line number. A line number changes every
 * time someone adds a comment above it, which would silently un-baseline an
 * error and block an unrelated deploy. */
function parse(raw) {
  const txt = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const re = /(TS\d+) \[ERROR\]: ([\s\S]*?)\n(?:[\s\S]*?)?\s+at (file:\/\/\/\S+?):(\d+):(\d+)/g;
  const found = [];
  let m;
  while ((m = re.exec(txt)) !== null) {
    const [, code, msg, url, line] = m;
    const file = url.split('/supabase/functions/')[1];
    if (!file) continue;
    found.push({
      code,
      file: `supabase/functions/${file}`,
      message: msg.trim().split('\n')[0].slice(0, 200),
      line: Number(line),
    });
  }
  return found;
}

const key = (e) => `${e.code}|${e.file}|${e.message}`;

const files = sources();
process.stderr.write(`[check-functions] type-checking ${files.length} source(s)…\n`);
const raw = runCheck(files);
const errors = parse(raw);

/* A checker that could not RUN is not a checker that found nothing.
 *
 * Adding package.json (jsdom, for tools/test-composer.mjs) made Deno adopt the
 * npm project and fail type resolution outright:
 *   "Failed resolving types. Could not find a matching package for 'npm:openai'"
 * That message carries no TS#### code, so parse() returned [], and this gate
 * reported "0 known errors, 0 new" and went green — for every function, on every
 * deploy, silently. Fixed by deno.json's nodeModulesDir:none, but the reason it
 * went unnoticed for a whole commit is that the gate only ever looked at what it
 * could parse and never at whether parsing had anything to work with. */
const toolchainErrors = String(raw)
  .replace(/\x1b\[[0-9;]*m/g, '')
  .split('\n')
  .filter((l) => /^error: /.test(l.trim()) && !/^error: Type checking failed/.test(l.trim()));
if (toolchainErrors.length && !errors.length) {
  console.error('\n[check-functions] DEPLOY BLOCKED — the type checker did not run\n');
  for (const l of toolchainErrors.slice(0, 5)) console.error('  ' + l.trim());
  console.error('\nThis is NOT "no type errors found". deno check failed before it could');
  console.error('report any, so this gate has no opinion. Fix the toolchain, then re-run.\n');
  process.exit(1);
}

if (process.argv.includes('--update-baseline')) {
  const rec = [...new Set(errors.map(key))].sort();
  writeFileSync(BASELINE, JSON.stringify({
    note: 'Known type errors, recorded so the gate blocks only NEW ones. This list may shrink, never grow without review.',
    recorded_at: new Date().toISOString().slice(0, 10),
    count: rec.length,
    errors: rec,
  }, null, 2) + '\n');
  console.log(`[check-functions] baseline written: ${rec.length} known error(s)`);
  for (const k of rec) console.log('  ' + k);
  process.exit(0);
}

const base = existsSync(BASELINE) ? new Set(JSON.parse(readFileSync(BASELINE, 'utf8')).errors || []) : new Set();
const fatal = errors.filter((e) => ALWAYS_FATAL.has(e.code));
const novel = errors.filter((e) => !base.has(key(e)) && !ALWAYS_FATAL.has(e.code));

if (!fatal.length && !novel.length) {
  console.log(`[check-functions] OK — ${files.length} source(s), ${errors.length} known error(s), 0 new.`);
  process.exit(0);
}

console.error('\n[check-functions] DEPLOY BLOCKED\n');
for (const e of fatal) {
  console.error(`  UNDEFINED NAME (always fatal)  ${e.code}  ${e.file}:${e.line}`);
  console.error(`    ${e.message}`);
  console.error('    This is a ReferenceError at runtime. It cannot be baselined.\n');
}
for (const e of novel) {
  console.error(`  NEW  ${e.code}  ${e.file}:${e.line}`);
  console.error(`    ${e.message}\n`);
}
console.error('Fix these, or if a new error is genuinely acceptable, run:');
console.error('  node tools/check-functions.mjs --update-baseline    (and commit the diff)\n');
process.exit(1);
