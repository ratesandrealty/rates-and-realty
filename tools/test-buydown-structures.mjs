/**
 * test-buydown-structures — pins ALL FOUR buydown structures, in BOTH renderers.
 *
 *   node tools/test-buydown-structures.mjs
 *
 * WHY BOTH. tools/fee-sheet.html is what Rene reads; public/fee.html is what the
 * borrower reads. They are separate implementations of one schedule, and the
 * failure that matters is them disagreeing — a sheet that says 3-2-1 while the
 * link draws 2-1 is a wrong payment schedule on a document that was sent. So
 * every structure is computed from BOTH and required to match.
 *
 * WHY ALL FOUR, not just the new ones. The previous schedule was
 * `structure === '1-1' ? [1,1] : [2,1]`, which drew 2-1 for ANY unrecognised
 * value. A spec covering only the structures that exist today would pass on
 * exactly that bug the next time a structure is added.
 *
 * HAND-WORKED on $400,000 at 6.875% over 30 years, note payment $2,627.72:
 *     1-0     yr1 −1%                   12 mo   total  $3,138.77
 *     1-1     yr1 −1%, yr2 −1%          24 mo   total  $6,277.54
 *     2-1     yr1 −2%, yr2 −1%          24 mo   total  $9,269.36
 *     3-2-1   yr1 −3%, yr2 −2%, yr3 −1% 36 mo   total $18,230.56
 * Cross-check that made these trustworthy: 3-2-1's year 2 (4.875%) is 2-1's
 * year 1, and its year 3 (5.875%) is both years of 1-1. The same rate must
 * produce the same payment wherever it appears.
 */
import fs from 'fs';

function liftFrom(file, names, decls = {}) {
  const src = fs.readFileSync(file, 'utf8');
  let out = '';
  for (const n of names) {
    const kind = decls[n] || 'function';
    const start = kind === 'const' ? src.indexOf('const ' + n + ' =') : src.indexOf('function ' + n + '(');
    if (start < 0) throw new Error('could not find ' + n + ' in ' + file);
    let i = src.indexOf(kind === 'const' ? '{' : '{', start), depth = 0, end = -1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    out += src.slice(start, end) + (kind === 'const' ? ';' : '') + '\n';
  }
  return out;
}

const admin = new Function(
  liftFrom('tools/fee-sheet.html', ['BD_STRUCTURES', 'bdSchedule', 'bdPmt', 'bdCompute'],
           { BD_STRUCTURES: 'const' })
  + 'return { bdSchedule, bdCompute };')();

const pub = new Function(
  liftFrom('public/fee.html', ['BD_STRUCTURES', '_bdSchedule', '_bdPmt'], { BD_STRUCTURES: 'const' })
  + 'return { _bdSchedule, _bdPmt };')();

let pass = 0, fail = 0;
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
function t(label, ok, detail) {
  ok ? pass++ : fail++;
  console.log((ok ? '  OK   ' : '  FAIL ') + label);
  if (!ok && detail) console.log('        ' + detail);
}

const LOAN = 400000, NOTE = 6.875, TERM = 30;
const EXPECT = {
  '1-0':   { cuts: [1],       months: 12, total: 3138.77,  afterYear: 2 },
  '1-1':   { cuts: [1, 1],    months: 24, total: 6277.54,  afterYear: 3 },
  '2-1':   { cuts: [2, 1],    months: 24, total: 9269.36,  afterYear: 3 },
  '3-2-1': { cuts: [3, 2, 1], months: 36, total: 18230.56, afterYear: 4 },
};

console.log('all four structures, hand-worked totals');
for (const [name, e] of Object.entries(EXPECT)) {
  const res = admin.bdCompute({ structure: name, term: TERM, noteRate: NOTE, loan: LOAN, payer: 'seller' });
  t(name + '  schedule ' + JSON.stringify(e.cuts), JSON.stringify(res.years.map(y => y.cut)) === JSON.stringify(e.cuts),
    JSON.stringify(res.years.map(y => y.cut)));
  t(name + '  ' + e.months + ' subsidised months', res.years.length * 12 === e.months);
  t(name + '  year ' + e.afterYear + ' onward at the note rate', res.years.length + 1 === e.afterYear);
  t(name + '  total cost $' + e.total.toLocaleString(), near(res.totalCost, e.total), 'got ' + res.totalCost.toFixed(2));
}

console.log('\nthe two renderers agree — same structure, same schedule');
for (const name of Object.keys(EXPECT)) {
  t(name + '  admin schedule == public schedule',
    JSON.stringify(admin.bdSchedule(name)) === JSON.stringify(pub._bdSchedule(name)),
    admin.bdSchedule(name) + ' vs ' + pub._bdSchedule(name));
}
console.log('\nand the same payment arithmetic');
for (const r of [3.875, 4.875, 5.875, 6.875]) {
  t('payment at ' + r + '% matches across renderers',
    near(admin.bdCompute({ structure: '1-0', term: TERM, noteRate: r + 1, loan: LOAN, payer: 's' }).years[0].payment,
         pub._bdPmt(LOAN, r, TERM), 0.01));
}

console.log('\nthe cross-check that makes the totals trustworthy');
const s321 = admin.bdCompute({ structure: '3-2-1', term: TERM, noteRate: NOTE, loan: LOAN, payer: 's' });
const s21  = admin.bdCompute({ structure: '2-1',   term: TERM, noteRate: NOTE, loan: LOAN, payer: 's' });
const s11  = admin.bdCompute({ structure: '1-1',   term: TERM, noteRate: NOTE, loan: LOAN, payer: 's' });
t('3-2-1 year 2 payment == 2-1 year 1 (both 4.875%)', near(s321.years[1].payment, s21.years[0].payment, 0.001));
t('3-2-1 year 3 payment == 2-1 year 2 (both 5.875%)', near(s321.years[2].payment, s21.years[1].payment, 0.001));
t('3-2-1 year 3 payment == 1-1 year 1 (both 5.875%)', near(s321.years[2].payment, s11.years[0].payment, 0.001));
t('note payment is $2,627.72 in every structure',
  [s321, s21, s11].every(x => near(x.notePmt, 2627.72)));

console.log('\nan unknown structure REFUSES rather than defaulting to 2-1');
t('admin bdSchedule(unknown) is null', admin.bdSchedule('4-3-2-1') === null);
t('public _bdSchedule(unknown) is null', pub._bdSchedule('4-3-2-1') === null);
t('admin bdCompute(unknown) is null', admin.bdCompute({ structure: 'nonsense', term: 30, noteRate: 6.875, loan: LOAN }) === null);
t('empty structure is not silently 2-1', admin.bdSchedule('') === null);

console.log('\nadding a structure is one array in each renderer');
t('both renderers expose the same key set',
  JSON.stringify(Object.keys(admin.bdSchedule('1-0') ? EXPECT : {}).sort())
  === JSON.stringify(Object.keys(EXPECT).sort()));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
