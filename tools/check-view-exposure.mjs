#!/usr/bin/env node
/**
 * check-view-exposure — this incident, expressed as a test.
 *
 * THE CONDITION
 * A view is NOT subject to its base tables' row-level security unless it is
 * declared `security_invoker`. It runs as its owner. So three facts together are
 * a disclosure, and each one alone is ordinary:
 *
 *   1. the view is NOT security_invoker      (it bypasses RLS)
 *   2. it reads at least one RLS-enabled table (there is protection to bypass)
 *   3. `anon` has SELECT on it                (the public key can reach it)
 *
 * On 2026-08-20 `contacts_live` satisfied all three and returned 1,046 borrower
 * records -- name, email, phone, address, DOB, ssn_last4 -- to the anon key
 * printed in every page. `borrower_qualifying_snapshot` was the same for income
 * and affordability. The measured contrast, same key, same request shape:
 *
 *     GET /rest/v1/loan_income     ->  []          RLS holds, the control works
 *     GET /rest/v1/contacts_live   ->  1046 rows   the view walked past it
 *
 * WHY A CHECK AND NOT A NOTE
 * Nothing detected this. There is no evidence it was ever exploited, but there is
 * also no way to bound how long it stood -- the view has no CREATE statement
 * anywhere in the repo, so it cannot even be dated from git. A condition that is
 * this cheap to query should not depend on somebody remembering it.
 *
 * WHAT IT DOES NOT PROVE
 * A view that returns [] to anon today because its own predicate keys on
 * auth.uid() still FAILS this check, and should. That predicate is a WHERE
 * clause, not a grant: `contacts_live` differed from `contacts_secure` only in
 * not having one, and one careless edit reproduces the incident. This checks the
 * configuration, not the current output.
 *
 *   node tools/check-view-exposure.mjs           # exit 1 if any view is exposed
 *   node tools/check-view-exposure.mjs --list    # show every view and its verdict
 */
import { fetchViews } from './recapture-db-views.mjs';

/* Views that may keep anon SELECT despite the three conditions. EMPTY, and it
 * should stay that way: the entire public surface of this project goes through
 * three slug-gated RPCs (get_cma_snapshot, get_fee_sheet_snapshot,
 * video_get_public), and no page reads a view as anon. An entry here needs a
 * reason and a date, the way allowConsole exclusions do in render-check. */
const ALLOW = Object.create(null);

function classify(v) {
  const rlsTables = (v.base_tables || []).filter((t) => t.rls).map((t) => t.table);
  const exposed = !v.security_invoker && rlsTables.length > 0 && v.anon_select === true;
  return { rlsTables, exposed };
}

async function main() {
  const list = process.argv.includes('--list');
  const views = await fetchViews();
  const findings = [];

  for (const v of views) {
    const { rlsTables, exposed } = classify(v);
    if (list) {
      const mode = v.security_invoker ? 'invoker' : 'DEFINER';
      console.log(
        `  ${v.view_name.padEnd(32)} ${mode.padEnd(8)} anon=${String(v.anon_select).padEnd(5)} ` +
        `rls_tables=${rlsTables.length ? rlsTables.join('+') : '-'}`);
    }
    if (!exposed) continue;
    if (ALLOW[v.view_name]) {
      console.log(`  ALLOWED  ${v.view_name} — ${ALLOW[v.view_name]}`);
      continue;
    }
    findings.push({ name: v.view_name, rlsTables });
  }

  console.log('');
  if (!findings.length) {
    console.log(`[view-exposure] OK — ${views.length} view(s) checked, none is DEFINER + RLS-backed + anon-selectable.`);
    return;
  }

  console.log(`[view-exposure] ${findings.length} EXPOSED view(s) — anon can read past row-level security:\n`);
  for (const f of findings) {
    console.log(`  ${f.name}`);
    console.log(`      not security_invoker, reads RLS table(s): ${f.rlsTables.join(', ')}, and anon has SELECT`);
    console.log(`      fix:  revoke all on public.${f.name} from anon;`);
    console.log(`      or:   alter view public.${f.name} set (security_invoker = on);   -- if a page must read it\n`);
  }
  console.log('  A view returning [] to anon today is still a finding: that is a WHERE clause on');
  console.log('  auth.uid(), not a grant. contacts_live differed only in not having one.\n');
  process.exitCode = 1;
}

/* process.exitCode, never process.exit(): on Windows, exiting with sockets still
 * open aborts teardown and REPLACES the code with 0 — a gate that always exits 0
 * is worse than no gate, because it is believed. Recorded in CLAUDE.md. */
main().catch((e) => { console.error('[view-exposure]', e.message); process.exitCode = 2; });
