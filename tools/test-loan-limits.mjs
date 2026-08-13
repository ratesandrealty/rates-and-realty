/**
 * test-loan-limits — pins the county conforming-limit table to its source.
 *
 *   node tools/test-loan-limits.mjs
 *
 * WHY. The table this replaced was commented "County loan limits (2026
 * California)" and actually held 2023 baseline ($726,200) and 2024 high-cost
 * ($1,149,825) values. Nothing checked the label against the numbers, so a
 * borrower-facing sheet printed a three-year-stale limit — under a WRONG county —
 * on two live links.
 *
 * So this asserts the numbers, not the comment: spot values taken from the FHFA
 * file itself, the shape of the spread (41 baseline / 10 ceiling / 7 between),
 * and that the classifier moves off CONFORMING in both directions. A badge that
 * has only ever said CONFORMING proves nothing.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('tools/fee-sheet.html', 'utf8');

/* Lift the real declarations out of the page rather than restating them —
   a test with its own copy of the table cannot detect the table changing. */
function lift(name, kind) {
  const marker = kind === 'fn' ? `function ${name}(` : `const ${name} `;
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('could not find ' + name);
  let j = src.indexOf(kind === 'fn' ? '{' : '=', i), depth = 0, end = -1;
  if (kind !== 'fn') j = src.indexOf(/[[{(]/.exec(src.slice(j))[0], j);
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  /* LOAN_LIMITS is `const X = (function(){…})();` — brace matching stops at the
     closing paren of the function expression, so without this the const gets the
     FUNCTION rather than its result and every lookup reads undefined. Swallow a
     trailing invocation if one is there. */
  const tail = src.slice(end, end + 2);
  if (kind !== 'fn' && tail === '()') end += 2;
  return src.slice(i, end) + (kind === 'fn' ? '' : ';');
}

const ctx = new Function(
  lift('LOAN_LIMITS_AS_OF') + lift('CA_LIMIT_OVERRIDES') + lift('CA_BASELINE_COUNTIES')
  + lift('LOAN_LIMITS') + lift('getLoanLimitInfo', 'fn') + lift('ZIP_TO_COUNTY')
  + 'return { LOAN_LIMITS_AS_OF, LOAN_LIMITS, getLoanLimitInfo, ZIP_TO_COUNTY, CA_LIMIT_OVERRIDES, CA_BASELINE_COUNTIES };'
)();

let pass = 0, fail = 0;
const t = (l, ok, d) => { ok ? pass++ : fail++; console.log((ok ? '  OK   ' : '  FAIL ') + l); if (!ok && d) console.log('        ' + d); };

const A = ctx.LOAN_LIMITS_AS_OF;
console.log('the table declares its vintage');
t('AS_OF year is 2026', A.year === 2026, String(A.year));
t('AS_OF names a source URL', /fhfa\.gov/.test(A.url || ''), A.url);
t('baseline is $832,750', A.baseline === 832750, String(A.baseline));
t('ceiling is $1,249,125', A.ceiling === 1249125, String(A.ceiling));
t('no 2023 baseline survives anywhere in the table',
  !Object.values(ctx.LOAN_LIMITS).some((v) => v.conforming === 726200));
t('no 2024 ceiling survives anywhere in the table',
  !Object.values(ctx.LOAN_LIMITS).some((v) => v.conforming === 1149825));

console.log('\nall 58 California counties, with the FHFA spread');
const vals = Object.values(ctx.LOAN_LIMITS).map((v) => v.conforming);
t('58 counties present', Object.keys(ctx.LOAN_LIMITS).length === 58, String(Object.keys(ctx.LOAN_LIMITS).length));
t('41 at the baseline', vals.filter((v) => v === 832750).length === 41, String(vals.filter((v) => v === 832750).length));
t('10 at the ceiling', vals.filter((v) => v === 1249125).length === 10, String(vals.filter((v) => v === 1249125).length));
t('7 between baseline and ceiling', vals.filter((v) => v !== 832750 && v !== 1249125).length === 7);

console.log('\nspot values, straight from the FHFA file');
for (const [county, want] of [
  ['Los Angeles', 1249125], ['Orange', 1249125], ['San Francisco', 1249125],
  ['Kern', 832750],           // verified baseline, NOT high-cost
  ['Riverside', 832750], ['San Bernardino', 832750], ['Fresno', 832750],
  ['San Diego', 1104000], ['Ventura', 1035000], ['Napa', 1017750],
  ['San Luis Obispo', 1000500], ['Monterey', 994750], ['Santa Barbara', 941850], ['Sonoma', 897000],
]) {
  const got = ctx.LOAN_LIMITS[county] && ctx.LOAN_LIMITS[county].conforming;
  t(`${county} = $${want.toLocaleString()}`, got === want, 'got ' + got);
}

console.log('\nthe classifier moves off CONFORMING in BOTH directions');
const cls = (county, amt) => { const i = ctx.getLoanLimitInfo(county, amt); return i ? i.type : null; };
t('LA $712,500 (Shelley) -> CONFORMING', cls('Los Angeles', 712500) === 'CONFORMING', cls('Los Angeles', 712500));
t('LA $1,249,125 exactly -> CONFORMING', cls('Los Angeles', 1249125) === 'CONFORMING', cls('Los Angeles', 1249125));
t('LA $1,249,126 -> NOT conforming', cls('Los Angeles', 1249126) !== 'CONFORMING', cls('Los Angeles', 1249126));
t('LA $1,500,000 -> HIGH BALANCE', cls('Los Angeles', 1500000) === 'HIGH BALANCE', cls('Los Angeles', 1500000));
t('LA $2,000,000 -> JUMBO', cls('Los Angeles', 2000000) === 'JUMBO', cls('Los Angeles', 2000000));
t('Kern $832,750 exactly -> CONFORMING', cls('Kern', 832750) === 'CONFORMING', cls('Kern', 832750));
t('Kern $832,751 -> HIGH BALANCE', cls('Kern', 832751) === 'HIGH BALANCE', cls('Kern', 832751));
t('Kern $900,000 (baseline county, over) -> HIGH BALANCE', cls('Kern', 900000) === 'HIGH BALANCE', cls('Kern', 900000));
t('an unknown county returns NO badge', ctx.getLoanLimitInfo('Nowhere', 500000) === null);
t('an empty county returns NO badge', ctx.getLoanLimitInfo('', 500000) === null);

console.log('\nthe ZIP prefix that sent a Lancaster sheet to Kern');
t("935 -> Los Angeles", ctx.ZIP_TO_COUNTY['935'] === 'Los Angeles', ctx.ZIP_TO_COUNTY['935']);
t("932 still -> Kern", ctx.ZIP_TO_COUNTY['932'] === 'Kern');
t("933 still -> Kern", ctx.ZIP_TO_COUNTY['933'] === 'Kern');
t('every mapped prefix resolves to a county in the limit table',
  Object.values(ctx.ZIP_TO_COUNTY).every((c) => !!ctx.LOAN_LIMITS[c]),
  Object.values(ctx.ZIP_TO_COUNTY).filter((c) => !ctx.LOAN_LIMITS[c]).join(','));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
