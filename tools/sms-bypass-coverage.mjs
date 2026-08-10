/* Coverage check: every caller of sms-service must either declare a bypass
 * reason from the closed set, or be deliberately in the enforced column.
 * A caller in neither is one nobody classified — and the flag must not flip. */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';

const files = [];
function walk(d) {
  for (const n of readdirSync(d)) {
    if (['.git', 'node_modules', '.claude', '.wrangler'].includes(n)) continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|js|html)$/.test(n)) files.push(p);
  }
}
for (const d of ['supabase/functions', 'admin', 'public', 'dashboard']) if (existsSync(d)) walk(d);

const VALID = new Set(['staff_alert', 'staff_message', 'user_initiated']);
const rows = [];
for (const f of files) {
  if (f.includes('sms-service')) continue;                 // the function itself
  const src = readFileSync(f, 'utf8');
  const lines = src.split(/\r?\n/);
  /* INDIRECTION. The first version of this checker missed six real call sites:
     lead-detail assigns the URL to SMS_FN and fetches THAT, and crm-comms.js
     calls a _post(name) wrapper. A checker that only sees the literal URL
     reports false coverage, which is worse than no checker. Collect any local
     constant holding the sms-service URL and treat uses of it as call sites. */
  const aliases = new Set();
  for (const m of src.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`][^'"`]*functions\/v1\/sms-service/g)) aliases.add(m[1]);
  const aliasRe = aliases.size ? new RegExp('\\b(?:' + [...aliases].join('|') + ')\\b') : null;

  lines.forEach((l, i) => {
    const literal = /functions\/v1\/sms-service|invoke\(['"]sms-service['"]|_post\(['"]sms-service['"]/.test(l);
    const viaAlias = aliasRe && aliasRe.test(l) && /fetch\s*\(/.test(l);
    if (!literal && !viaAlias) return;
    if (/^\s*(\/\/|\*|<!--)/.test(l)) return;               // prose, not a call
    // A bare constant declaration is not a call site; its USES are.
    if (/(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*['"`]/.test(l) && !/fetch\s*\(/.test(l)) return;
    const win = lines.slice(i, i + 14).join(' ');           // payload may wrap
    const m = win.match(/quiet_hours_bypass\s*:\s*['"]([a-z_]+)['"]/);
    rows.push({ file: f.split(sep).join('/'), line: i + 1, reason: m ? m[1] : 'ENFORCED' });
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('CALLER', 50) + pad('LINE', 6) + 'BYPASS / ENFORCED');
console.log('-'.repeat(94));
for (const r of rows.sort((a, b) => a.reason === b.reason ? a.file.localeCompare(b.file) : a.reason.localeCompare(b.reason))) {
  console.log(pad(r.file, 50) + pad(r.line, 6) + r.reason);
}
const bypassed = rows.filter((r) => r.reason !== 'ENFORCED');
const bad = bypassed.filter((r) => !VALID.has(r.reason));
console.log(`\ncallers: ${rows.length}   bypassed: ${bypassed.length}   enforced: ${rows.length - bypassed.length}`);
if (bad.length) { console.log('INVALID REASON — flag must not flip:'); bad.forEach((b) => console.log('  ', b)); process.exit(1); }
console.log('every caller is in exactly one column.');
