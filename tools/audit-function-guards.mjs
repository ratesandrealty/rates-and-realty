#!/usr/bin/env node
/**
 * audit-function-guards — for each edge function, report whether it has an
 * IN-FUNCTION auth check, and what its config.toml verify_jwt pin says.
 *
 * WHY: verify_jwt = true is not an access control. The Supabase gateway checks
 * only that the bearer is a JWT signed by this project, and the anon key is a
 * project-signed JWT printed in every page's source. So the pin and the guard
 * are independent facts and this prints both, because the failure mode being
 * hunted is exactly a function where the pin was mistaken for the guard.
 *
 * A "guard" here means the function does one of:
 *   - getUser() / auth.getUser on the caller's token, then a role lookup
 *   - compares a header against a service key or a shared secret
 *   - validates a row-held token (the lender-portal form_token pattern)
 *
 * Reported, never inferred: this greps source and prints what it found, so a
 * "GUARDED" verdict can be checked by eye against the matched line.
 *
 *   node tools/audit-function-guards.mjs                 all functions
 *   node tools/audit-function-guards.mjs --list a,b,c    only these
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FN_DIR = 'supabase/functions';
const CONFIG = 'supabase/config.toml';

/* Each pattern is a distinct KIND of check, so the report can say which. */
const GUARD_PATTERNS = [
  [/getUser\s*\(/,                                  'getUser()'],
  [/auth_user_roles/,                               'auth_user_roles lookup'],
  [/requireAdmin|requireStaff|requireRole|assertAdmin/, 'require* helper'],
  [/SERVICE_ROLE_KEY\s*(===|==|!==|!=)|(===|==|!==|!=)\s*SERVICE/, 'service-key comparison'],
  /* A caller that IS the database proves itself with a vault secret verified
   * in Postgres — market-rate reads as UNGUARDED without this, and it is not.
   * See verify_cron_secret() and _shared/require-staff.ts allowInternal. */
  [/verify_cron_secret|x-cron-secret|x-internal-secret/,   'vault-secret check'],
  [/form_token|row_token|shared_secret|SHARED_SECRET/, 'row/shared token'],
  [/TEST_KEY|_SECRET\b/,                            'secret header'],
];

/* Line-based, deliberately. A regex that grabbed [functions.x] and then searched
 * the following blob mis-read sms-service as false when it is pinned true — the
 * `verify_jwt = false` it found belonged to the PRECEDING section. A tool that
 * misreports a pin is more dangerous than no tool: acting on "it's false" would
 * mean flipping a value that is already correct. TOML sections are line
 * delimited, so walk lines and track the current section. */
function pins() {
  const m = new Map();
  if (!existsSync(CONFIG)) return m;
  let current = null;
  for (const raw of readFileSync(CONFIG, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      const fn = sec[1].match(/^functions\.(.+)$/);
      current = fn ? fn[1] : null;
      if (current && !m.has(current)) m.set(current, '(section, no verify_jwt)');
      continue;
    }
    if (!current) continue;
    const v = line.match(/^verify_jwt\s*=\s*(true|false)\b/i);
    if (v) m.set(current, v[1].toLowerCase());
  }
  return m;
}

const pinMap = pins();
const argIdx = process.argv.indexOf('--list');
const only = argIdx > -1 ? new Set(process.argv[argIdx + 1].split(',').map(s => s.trim())) : null;

const names = existsSync(FN_DIR)
  ? readdirSync(FN_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
  : [];

const rows = [];
for (const name of names) {
  if (only && !only.has(name)) continue;
  const entry = join(FN_DIR, name, 'index.ts');
  if (!existsSync(entry)) { rows.push({ name, pin: pinMap.get(name) ?? '(not pinned)', guards: [], note: 'no index.ts' }); continue; }
  const src = readFileSync(entry, 'utf8');
  const guards = [];
  for (const [re, label] of GUARD_PATTERNS) if (re.test(src)) guards.push(label);
  rows.push({ name, pin: pinMap.get(name) ?? '(not pinned)', guards, bytes: src.length });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('function', 30) + pad('verify_jwt', 13) + 'in-function auth');
console.log('-'.repeat(84));
let open = 0;
for (const r of rows) {
  const verdict = r.guards.length ? r.guards.join(', ') : '*** NONE ***';
  if (!r.guards.length) open++;
  console.log(pad(r.name, 30) + pad(r.pin, 13) + verdict);
}
console.log('-'.repeat(84));
console.log(`${rows.length} function(s); ${open} with no in-function auth of any kind.`);
