#!/usr/bin/env node
/**
 * audit-stage-lists — find hardcoded pipeline-stage lists carrying values that
 * are not stages.
 *
 * WHY THIS SHAPE OF SEARCH
 * The Follow Up pass swept for the literal 'Clear to Close' and still missed four
 * sites, because a list can be a stage list without containing the one term you
 * grepped for. people-admin's "Active clients" was excluded from that pass
 * entirely and was carrying two fossils ('Submitted', 'Approved') that match no
 * contact and never have.
 *
 * So this does not search for a term. It finds every BRACKETED LIST OF STRING
 * LITERALS that contains at least one known stage, then reports every member.
 * Anything in such a list that is not canonical is either a fossil, a different
 * vocabulary that happens to overlap, or a bug — all three are worth seeing.
 *
 * Covers JS/TS arrays, PostgREST .in(...) lists, SQL array[...] and IN (...).
 *
 *   node tools/audit-stage-lists.mjs            report
 *   node tools/audit-stage-lists.mjs --strict   exit 1 if any fossil is found
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const CANON = ['New Lead', 'Contacted', 'Follow Up', 'Pre-Approved', 'Under Contract',
               'Processing', 'Clear to Close', 'Closed', 'Lost'];
const CANON_SET = new Set(CANON);

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', '.db-observe', 'dist', 'build', '.wrangler']);
const EXT = /\.(html?|js|mjs|ts|sql)$/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

/* Strip comments before scanning, preserving line count so reported line numbers
 * still point at the right place.
 *
 * WHY: the first run of this tool reported people-admin as still carrying
 * 'Submitted'/'Approved' — it had matched the COMMENT that documents the old
 * list, three lines above the corrected code. A checker that reports a note
 * about a fixed bug as the bug itself is one nobody will trust twice. The same
 * mistake was made earlier in this project with an ILIKE over pg_proc.prosrc
 * that matched its own explanatory comment. */
function stripComments(src, isSql) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  let out = src;
  out = out.replace(/<!--[\s\S]*?-->/g, blank);
  if (isSql) out = out.replace(/--[^\n]*/g, blank);
  out = out.replace(/\/\*[\s\S]*?\*\//g, blank);
  /* Line comments only when // starts the line or follows whitespace, so a URL
   * like https://host is not truncated mid-string. */
  out = out.replace(/(^|[\s;,{}()])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
  return out;
}

/* Pull every quoted string out of a candidate list body. Handles ' and " and `. */
function membersOf(body) {
  const out = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(body))) out.push(m[2]);
  return out;
}

/* Candidate lists: the smallest bracketed run that has no nested bracket of the
 * same kind. Deliberately simple — a stage list is always a flat list of
 * literals, so anything with structure is not what we are looking for. */
function candidates(src) {
  const out = [];
  const re = /[[(]([^[\]()]{0,600})[\])]/g;
  let m;
  while ((m = re.exec(src))) out.push({ body: m[1], index: m.index });
  return out;
}

const root = process.cwd();
const files = walk(root);
const findings = [];
let listsSeen = 0;

for (const f of files) {
  let src; try { src = readFileSync(f, 'utf8'); } catch { continue; }
  const rel = relative(root, f).replace(/\\/g, '/');
  src = stripComments(src, /\.sql$/i.test(f));
  for (const c of candidates(src)) {
    const mem = membersOf(c.body);
    if (mem.length < 2) continue;
    const hits = mem.filter((s) => CANON_SET.has(s));
    if (!hits.length) continue;
    /* Require the list to be MOSTLY stages, so a prose sentence that happens to
     * quote one stage name does not register as a stage list. */
    if (hits.length / mem.length < 0.4) continue;
    listsSeen++;
    const fossils = mem.filter((s) => !CANON_SET.has(s));
    if (!fossils.length) continue;
    findings.push({
      file: rel,
      line: src.slice(0, c.index).split('\n').length,
      members: mem,
      fossils,
      missing: CANON.filter((s) => !mem.includes(s)),
    });
  }
}

if (!findings.length) {
  console.log(`OK — ${listsSeen} stage list(s) examined, none carrying a non-stage value.`);
  process.exit(0);
}

console.log(`${listsSeen} stage list(s) examined; ${findings.length} carrying value(s) that are not stages:\n`);
for (const f of findings) {
  console.log(`${f.file}:${f.line}`);
  console.log(`   members : ${f.members.join(' | ')}`);
  console.log(`   NOT a stage : ${f.fossils.join(', ')}`);
  if (f.missing.length) console.log(`   absent      : ${f.missing.join(', ')}`);
  console.log('');
}
process.exit(process.argv.includes('--strict') ? 1 : 0);
