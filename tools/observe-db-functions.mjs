#!/usr/bin/env node
/**
 * observe-db-functions — watch the Postgres function layer WITHOUT alerting.
 *
 * This is deliberately an observation, not a checker. 307 functions were
 * captured on 2026-08-05 after having no git history at all; before gating
 * anything on them we need to know how noisy a diff actually is, and which
 * functions move without anyone committing. That list is the exclusion list,
 * derived from what happens rather than guessed from name prefixes.
 *
 * So: capture nightly to a SCRATCH directory, diff against the committed
 * baseline in supabase/sql/db-functions/, append to a log. Exit 0 always.
 * Nothing here blocks a deploy, notifies anybody, or writes to the repo.
 *
 *   node tools/observe-db-functions.mjs           observe and log
 *   node tools/observe-db-functions.mjs --report  summarise the log so far
 *
 * Reads through the service-role RPC public.fn_source_export(). There is no
 * other repeatable path: `supabase db dump` needs Docker (absent here), the
 * CLI's management token is in the Windows credential store, and PostgREST
 * cannot reach pg_catalog.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REF = 'ljywhvbmsibwnssxpesh';
const BASELINE = 'supabase/sql/db-functions';
const SCRATCH = '.db-observe';                 // gitignored — never the committed dir
const LOG = join(SCRATCH, 'observations.jsonl');

function serviceKey() {
  const out = execFileSync('npx', ['supabase', 'projects', 'api-keys', '--project-ref', REF, '--output', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true });
  const k = JSON.parse(out).find((r) => r.name === 'service_role');
  if (!k) throw new Error('service_role key not returned by the CLI');
  return k.api_key;
}

async function fetchFunctions(key) {
  const r = await fetch(`https://${REF}.supabase.co/rest/v1/rpc/fn_source_export`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) throw new Error(`fn_source_export returned HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/* The committed files carry a comment header before the DDL. Compare only from
 * CREATE onward, and normalise line endings — this repo is on Windows and git
 * rewrites LF to CRLF on checkout, which would otherwise make every function
 * look changed on every run. That is exactly the kind of false positive this
 * observation exists to measure, so it must not be self-inflicted. */
function ddlOf(text) {
  const i = text.indexOf('CREATE OR REPLACE FUNCTION');
  return (i < 0 ? text : text.slice(i))
    .replace(/\r\n/g, '\n')
    /* Strip a trailing semicolon. pg_get_functiondef does NOT emit one, but the
     * splitter that wrote the baseline appended it so each file is runnable on
     * its own. Without this the very first observation reported all 307
     * functions as changed, on a one-character difference nobody made — the
     * exact kind of false positive that gets a checker switched off. */
    .replace(/;\s*$/, '')
    .trim();
}

function keyOf(fn) { return `${fn.name}(${fn.args || ''})`; }

function baselineMap() {
  const m = new Map();
  if (!existsSync(BASELINE)) return m;
  for (const f of readdirSync(BASELINE).filter((n) => n.endsWith('.sql'))) {
    const body = readFileSync(join(BASELINE, f), 'utf8');
    const sig = body.match(/^--\s+(.+?)\s*$/m);
    m.set(sig ? sig[1].trim() : f.replace(/\.sql$/, ''), { file: f, ddl: ddlOf(body) });
  }
  return m;
}

async function observe() {
  mkdirSync(SCRATCH, { recursive: true });
  const stamp = new Date().toISOString();
  let live;
  try {
    live = await fetchFunctions(serviceKey());
  } catch (e) {
    // A failed capture is itself an observation. Never throw — this runs unattended.
    appendFileSync(LOG, JSON.stringify({ at: stamp, ok: false, error: String(e.message || e) }) + '\n');
    console.log(`[observe] capture FAILED: ${e.message || e}  (logged, not alerting)`);
    return;
  }

  writeFileSync(join(SCRATCH, `capture-${stamp.slice(0, 10)}.json`), JSON.stringify(live, null, 1));

  const base = baselineMap();
  const seen = new Set();
  const changed = [], added = [];
  for (const fn of live) {
    const k = keyOf(fn);
    seen.add(k);
    const b = base.get(k);
    if (!b) { added.push(k); continue; }
    if (ddlOf(fn.def) !== b.ddl) changed.push(k);
  }
  const removed = [...base.keys()].filter((k) => !seen.has(k));

  const rec = { at: stamp, ok: true, live: live.length, baseline: base.size, changed, added, removed };
  appendFileSync(LOG, JSON.stringify(rec) + '\n');

  console.log(`[observe] ${stamp.slice(0, 10)}  live=${live.length} baseline=${base.size}  `
    + `changed=${changed.length} added=${added.length} removed=${removed.length}`);
  for (const k of changed) console.log(`    ~ ${k}`);
  for (const k of added)   console.log(`    + ${k}`);
  for (const k of removed) console.log(`    - ${k}`);
  console.log('[observe] logged only — nothing alerted, nothing blocked.');
}

function report() {
  if (!existsSync(LOG)) { console.log('[observe] no observations yet.'); return; }
  const runs = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ok = runs.filter((r) => r.ok);
  const fails = runs.length - ok.length;
  const churn = new Map();
  for (const r of ok) for (const k of [...(r.changed || []), ...(r.added || []), ...(r.removed || [])]) {
    churn.set(k, (churn.get(k) || 0) + 1);
  }
  console.log(`[observe] ${runs.length} run(s), ${fails} failed capture(s)`);
  console.log(`[observe] first ${runs[0].at.slice(0, 10)} → last ${runs[runs.length - 1].at.slice(0, 10)}`);
  const quiet = ok.filter((r) => !r.changed.length && !r.added.length && !r.removed.length).length;
  console.log(`[observe] ${quiet}/${ok.length} runs saw NO movement`);
  if (!churn.size) { console.log('[observe] nothing moved. A daily diff would be silent.'); return; }
  console.log('[observe] functions that moved, most often first — this IS the exclusion-list candidate set:');
  for (const [k, n] of [...churn.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)}×  ${k}`);
}

if (process.argv.includes('--report')) report();
else await observe();
