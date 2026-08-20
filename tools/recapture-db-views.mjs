#!/usr/bin/env node
/**
 * recapture-db-views — capture the VIEW layer the way db-functions are captured.
 *
 * WHY THIS EXISTS
 * The repo captured 389 Postgres functions in supabase/sql/db-functions/ and ZERO
 * views. `tools/recapture-db-functions.mjs` reads pg_proc; nothing read pg_class.
 *
 * That gap was not theoretical. On 2026-08-20 `contacts_live` was found returning
 * 1,046 borrower records -- name, email, phone, address, DOB, ssn_last4 -- to the
 * public anon key. A view is NOT subject to its base tables' RLS unless declared
 * security_invoker, so the protection on `contacts` was intact and irrelevant.
 * And because no CREATE VIEW for it exists anywhere in the tree, it could not be
 * dated from git and the exposure window could not be bounded.
 * See docs/CONTACTS-LIVE-EXPOSURE-EVIDENCE-2026-08-20.md
 *
 * WHAT IT CAPTURES, AND WHY NOT JUST THE SQL
 * Three facts decide whether a view is dangerous, and only one of them is in the
 * definition text:
 *   1. security_invoker   -- reloptions, NOT part of pg_get_viewdef
 *   2. base tables + RLS  -- resolved through pg_rewrite/pg_depend
 *   3. who can SELECT it  -- the ACL
 * A capture holding only the definition means the next person greps for these
 * instead of diffing them, which is how the condition went unnoticed for an
 * unbounded period. They are written as a structured header on every file so a
 * change to any of the three shows up as a diff.
 *
 *   node tools/recapture-db-views.mjs            # all views
 *   node tools/recapture-db-views.mjs contacts_live contacts_secure
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REF = 'ljywhvbmsibwnssxpesh';
const BASELINE = 'supabase/sql/db-views';

/* Same pin and same reason as recapture-db-functions: `supabase projects
 * api-keys` is broken in 2.112.0 and works in 2.111.0. Do not "upgrade" it. */
const SUPABASE_CLI = 'supabase@2.111.0';

function serviceKey() {
  const out = execFileSync('npx', ['-y', SUPABASE_CLI, 'projects', 'api-keys', '--project-ref', REF, '--output', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true });
  const k = JSON.parse(out).find((r) => r.name === 'service_role');
  if (!k) throw new Error('service_role key not returned by the CLI');
  return k.api_key;
}

export async function fetchViews(key = serviceKey()) {
  const r = await fetch(`https://${REF}.supabase.co/rest/v1/rpc/view_source_export`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) throw new Error(`view_source_export returned HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

function render(v) {
  const tables = Array.isArray(v.base_tables) ? v.base_tables : [];
  const rlsTables = tables.filter((t) => t.rls).map((t) => t.table);
  const plainTables = tables.filter((t) => !t.rls).map((t) => t.table);
  const readers = ['anon', 'authenticated', 'service_role']
    .filter((r) => v[`${r === 'anon' ? 'anon' : r}_select`]);

  /* The header is the point of this file. Keep the field names stable — the
   * exposure check and any future diff read them. */
  const lines = [
    `-- ${v.view_name} (${v.kind})`,
    `-- Captured from production by tools/recapture-db-views.mjs. Do not hand-edit.`,
    `--`,
    `-- security_invoker: ${v.security_invoker}`,
    v.security_invoker
      ? `--   RLS on the base tables APPLIES to callers of this view.`
      : `--   DEFINER: this view runs as its OWNER and is NOT subject to the base`,
    v.security_invoker ? null
      : `--   tables' RLS. Anything granted SELECT here reads past that protection.`,
    `-- base_tables_with_rls: ${rlsTables.length ? rlsTables.join(', ') : '(none)'}`,
    `-- base_tables_without_rls: ${plainTables.length ? plainTables.join(', ') : '(none)'}`,
    `-- select_granted_to: ${readers.length ? readers.join(', ') : '(none)'}`,
    !v.security_invoker && rlsTables.length && v.anon_select
      ? `--\n-- !! DEFINER + reads an RLS table + anon can SELECT. This is the\n-- !! contacts_live configuration. See tools/check-view-exposure.mjs.`
      : null,
    `--`,
    '',
    `create or replace view public.${v.view_name} as`,
    v.definition.trimEnd().replace(/;+\s*$/, '') + ';',
    '',
  ].filter((l) => l !== null);
  return lines.join('\n');
}

async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const all = await fetchViews();
  const picked = wanted.length ? all.filter((v) => wanted.includes(v.view_name)) : all;

  if (wanted.length) {
    const missing = wanted.filter((w) => !all.some((v) => v.view_name === w));
    if (missing.length) {
      console.error(`[views] not found in production: ${missing.join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  if (!existsSync(BASELINE)) mkdirSync(BASELINE, { recursive: true });

  for (const v of picked) {
    writeFileSync(join(BASELINE, `${v.view_name}.sql`), render(v), 'utf8');
    const flag = !v.security_invoker && (v.base_tables || []).some((t) => t.rls) && v.anon_select ? '  <-- EXPOSED' : '';
    console.log(`captured  ${v.view_name}.sql${flag}`);
  }

  /* Report files with no matching view, the way recapture-db-functions' two-files
   * -for-one-name check surfaces an accidental overload. A stale file here means a
   * view was dropped and its capture was left behind, which reads as live. */
  if (!wanted.length) {
    const onDisk = readdirSync(BASELINE).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, ''));
    const orphans = onDisk.filter((f) => !all.some((v) => v.view_name === f));
    for (const o of orphans) console.log(`ORPHAN    ${o}.sql — no such view in production; drop the file or restore the view`);
  }

  console.log(`OK — ${picked.length} view file(s) refreshed from production.`);
}

/* process.exitCode, never process.exit() — on Windows an exit with sockets still
 * open aborts teardown and REPLACES the exit code with 0, so a tool that found a
 * problem reports success. Recorded in CLAUDE.md after it bit the CORS checks. */
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('recapture-db-views.mjs')) {
  main().catch((e) => { console.error('[views]', e.message); process.exitCode = 2; });
}
