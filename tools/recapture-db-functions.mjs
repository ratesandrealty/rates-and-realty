#!/usr/bin/env node
/**
 * recapture-db-functions — refresh the committed baseline for named DB functions.
 *
 * WHY THIS EXISTS
 * supabase/sql/db-functions/ is the only record of the Postgres function layer;
 * check-function-drift.mjs compares deployed EDGE functions and never opens the
 * database. So after changing a DB function the baseline is stale until someone
 * re-captures it by hand, and a hand transcription of a 6 KB plpgsql body is
 * exactly the kind of thing that silently loses a line.
 *
 * This pulls the LIVE definition back out of Postgres and rewrites the file, so
 * the committed copy is what the database actually holds rather than what the
 * change was intended to be.
 *
 *   node tools/recapture-db-functions.mjs normalize_pipeline_status production_report
 *   node tools/recapture-db-functions.mjs --all
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const REF = 'ljywhvbmsibwnssxpesh';
const BASELINE = 'supabase/sql/db-functions';

/* PINNED, and NOT to the latest — 2.112.0 is broken and 2.111.0 is not.
 *
 * `supabase projects api-keys` validates the API response against a schema the
 * CLI ships, and 2.112.0 rejects the `inserted_at` timestamp on the API-key rows
 * created 2026-08-07: "SchemaError(Expected a string matching the RegExp ...)".
 * Every output format fails, because it is the RESPONSE being validated, not the
 * formatting. This took down observe-db-functions and recapture-db-functions
 * together, since both read the key the same way.
 *
 * The instinct is to upgrade. That is exactly wrong here: the newest version IS
 * the broken one. Verified both directions on 2026-08-07 —
 *   supabase@2.111.0  OK
 *   supabase@2.112.0  FAILS
 * Retest before moving the pin; only `projects api-keys` is affected, so the
 * other tools that call the CLI (check-function-drift, deploy-function.sh) are
 * unaffected and deliberately left alone. */
const SUPABASE_CLI = 'supabase@2.111.0';

function serviceKey() {
  const out = execFileSync('npx', ['-y', SUPABASE_CLI, 'projects', 'api-keys', '--project-ref', REF, '--output', 'json'],
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
  if (!r.ok) throw new Error(`fn_source_export returned HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/* Keep the existing header comment if the file already has one — it carries the
 * provenance note, and rewriting it away on every capture would discard the one
 * piece of context the DDL itself cannot express. Only the date is refreshed. */
function headerFor(file, fn, today) {
  const path = join(BASELINE, file);
  if (existsSync(path)) {
    const body = readFileSync(path, 'utf8');
    const i = body.indexOf('CREATE OR REPLACE FUNCTION');
    if (i > 0) {
      return body.slice(0, i).replace(/Captured from production \d{4}-\d{2}-\d{2}/, `Captured from production ${today}`);
    }
  }
  return `-- ${fn.name}(${fn.args || ''})\n-- language: ${fn.lang || 'plpgsql'}\n-- Captured from production ${today}.\n\n`;
}

const argv = process.argv.slice(2);
if (!argv.length) {
  console.error('usage: recapture-db-functions.mjs <name> [name…] | --all');
  process.exit(2);
}

const live = await fetchFunctions(serviceKey());
const wantAll = argv.includes('--all');
const want = new Set(argv.filter((a) => !a.startsWith('--')));
const today = new Date().toISOString().slice(0, 10);

let written = 0, missed = [];
const seen = new Set();

/* HOW MANY OVERLOADS EACH NAME HAS, computed before writing anything.
 *
 * THE BUG THIS FIXES, because it hid in plain sight for weeks. The rule below
 * used to be "reuse the existing filename if there is exactly one candidate,
 * else <name>.sql" — which for a name with TWO overloads and one baseline file
 * resolved to the SAME path for both, so the second silently overwrote the
 * first. order_note_add has two:
 *     (p_order_id, p_note_text, p_is_follow_up, p_author_display)
 *     (p_order_id, p_contact_id, p_note_text, p_is_request)
 * The file could only ever hold one, so observe-db-functions reported it as
 * `changed` on EVERY run and no amount of re-capturing could settle it. It read
 * as stale drift; it was the capture tool losing a function. */
const overloadCount = new Map();
for (const fn of live) overloadCount.set(fn.name, (overloadCount.get(fn.name) || 0) + 1);

/* Stable, readable, collision-proof. The slug is for humans reading the
 * directory; the hash is what guarantees two overloads never land on one path. */
function argSlug(args) {
  const s = String(args || 'noargs').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  const h = createHash('sha1').update(String(args || '')).digest('hex').slice(0, 6);
  return `${s || 'noargs'}_${h}`;
}

/* The signature line every baseline file opens with — the same string
 * observe-db-functions keys on, so matching it here is matching what the
 * observer will compare. */
function sigOf(fn) { return `${fn.name}(${fn.args || ''})`; }

const baselineFiles = existsSync(BASELINE) ? readdirSync(BASELINE).filter((n) => n.endsWith('.sql')) : [];
function fileHoldingSig(sig) {
  for (const f of baselineFiles) {
    /* baselineFiles is the listing from startup and the loop below DELETES the
     * bare file of an overloaded name, so a later lookup can name a file that is
     * already gone. Skip it rather than throwing ENOENT mid-capture. */
    const p = join(BASELINE, f);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^--\s+(.+?)\s*$/m);
    if (m && m[1].trim() === sig) return f;
  }
  return null;
}

for (const fn of live) {
  if (!wantAll && !want.has(fn.name)) continue;
  seen.add(fn.name);
  /* ONE FILE PER name+args. A single-overload name keeps the plain <name>.sql it
   * has always had — renaming 300 files to fix two would be churn for nothing. */
  let file;
  if ((overloadCount.get(fn.name) || 1) < 2) {
    const candidates = baselineFiles.filter((n) => n === `${fn.name}.sql` || n.startsWith(`${fn.name}__`));
    file = candidates.length === 1 ? candidates[0] : `${fn.name}.sql`;
  } else {
    /* AN OVERLOADED NAME USES ONLY `<name>__<args>.sql`, never the bare
     * `<name>.sql`. Allowing the plain file as a candidate is what let two
     * overloads share a path; it also leaves an ambiguous file that can hold
     * only one of them. Prefer an existing __ file carrying THIS signature so a
     * re-capture lands where the last one did and the diff stays readable. */
    const held = fileHoldingSig(sigOf(fn));
    file = (held && held.startsWith(`${fn.name}__`)) ? held : `${fn.name}__${argSlug(fn.args)}.sql`;
    /* The bare file is now a leftover that can only ever be one overload —
     * exactly the state that made this name read as permanently drifted. */
    const bare = join(BASELINE, `${fn.name}.sql`);
    if (existsSync(bare)) { rmSync(bare); console.log(`removed   ${fn.name}.sql  (overloaded name — one file per signature)`); }
  }
  /* fn_source_export returns { name, args, lang, secdef, def } — `def` is
     pg_get_functiondef output. Field names confirmed against the live RPC, not
     guessed: an earlier guess of `definition`/`source` silently matched nothing
     and reported every function as missing. */
  const ddl = String(fn.def || '').replace(/\r\n/g, '\n').replace(/;\s*$/, '').trim();
  if (!ddl.includes('CREATE OR REPLACE FUNCTION')) { missed.push(`${fn.name}: no DDL in export`); continue; }
  writeFileSync(join(BASELINE, file), headerFor(file, fn, today) + ddl + ';\n');
  console.log(`captured  ${file}  (${ddl.length} bytes)`);
  written++;
}

for (const n of want) if (!seen.has(n)) missed.push(`${n}: not found in production`);
if (missed.length) { for (const m of missed) console.error('MISS  ' + m); process.exit(1); }
console.log(`OK — ${written} function file(s) refreshed from production.`);
