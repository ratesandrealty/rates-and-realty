/**
 * test-bridge-math — pins the bridge loan arithmetic in tools/fee-sheet.html.
 *
 *   node tools/test-bridge-math.mjs
 *
 * WHY THIS EXISTS. The bridge addendum states a TOTAL COST that Rene puts in
 * front of a borrower, derived from six inputs through four steps. There is no
 * cheap way to eyeball whether that number is right, and a formula that drifts
 * produces a wrong figure that still looks plausible — which is the worst
 * failure mode a fee sheet has. Same treatment the buydown got.
 *
 * bridgeCompute is LIFTED OUT OF fee-sheet.html at runtime rather than retyped,
 * so this cannot pass against a copy that has drifted from what ships.
 *
 * THE HAND-WORKED CASE. $800,000 departing home, $450,000 owing, 80% CLTV,
 * 10.5%, 9 months, 2 points, $1,495 fees, interest-only:
 *     max lien        800,000 x 0.80            = 640,000
 *     bridge amount   640,000 - 450,000         = 190,000
 *     monthly (IO)    190,000 x 0.105 / 12      =   1,662.50
 *     total interest  1,662.50 x 9              =  14,962.50
 *     points          190,000 x 0.02            =   3,800.00
 *     TOTAL COST      14,962.50 + 3,800 + 1,495 =  20,257.50
 */
import fs from 'fs';

const src = fs.readFileSync('tools/fee-sheet.html', 'utf8');

function lift(name, decl) {
  const start = src.indexOf((decl || 'function ') + name + (decl ? ' =' : '('));
  if (start < 0) throw new Error('could not find ' + name + ' in fee-sheet.html');
  // Brace-match to the end of the function.
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('unbalanced braces in ' + name);
  return src.slice(start, end);
}

/* parseCurrency is fee-sheet's own; lift it too rather than approximating it —
   an approximation here would test a formula this file does not actually run. */
const mod = new Function(lift('parseCurrency', 'const ') + ';\n' + lift('bridgeCompute') + '\nreturn { bridgeCompute };')();
const { bridgeCompute } = mod;

let pass = 0, fail = 0;
const near = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;
function t(label, got, want, tol) {
  const ok = (typeof want === 'number') ? near(got, want, tol) : got === want;
  ok ? pass++ : fail++;
  console.log((ok ? '  OK   ' : '  FAIL ') + label);
  if (!ok) console.log('        got ' + got + '  want ' + want);
}

const BASE = { value: '$800,000', balance: '$450,000', cltv: '80', rate: '10.5',
               months: '9', points: '2', fees: '$1,495', mode: 'io' };

console.log('interest-only — the hand-worked case');
const io = bridgeCompute(BASE);
t('max lien            640,000',   io.maxLien,       640000);
t('bridge amount       190,000',   io.amount,        190000);
t('monthly IO           1,662.50', io.monthly,       1662.50);
t('total interest      14,962.50', io.totalInterest, 14962.50);
t('points               3,800.00', io.pointsAmt,     3800);
t('fees                 1,495.00', io.fees,          1495);
t('TOTAL COST          20,257.50', io.totalCost,     20257.50);
t('io flag', io.io, true);

console.log('\nIO does not amortise — principal is untouched');
t('total interest == monthly x months', near(io.totalInterest, io.monthly * 9), true);

console.log('\namortised — available, and why it is not the default');
const am = bridgeCompute({ ...BASE, mode: 'amortized' });
t('monthly is ~13x the IO payment', am.monthly > io.monthly * 12, true);
t('monthly ~22,045.55', am.monthly, 22045.55, 0.6);
t('total interest LOWER than IO (principal repaid throughout)', am.totalInterest < io.totalInterest, true);
t('fully amortises: monthly x n - principal == interest',
  near(am.totalInterest, am.monthly * 9 - 190000, 0.01), true);

console.log('\nequity floor — a bridge cannot exceed the equity above the lien');
t('balance above max lien -> amount 0',
  bridgeCompute({ ...BASE, balance: '$700,000' }).amount, 0);
t('and no cost is invented',
  bridgeCompute({ ...BASE, balance: '$700,000' }).totalCost, 1495);   // fees only
t('zero CLTV -> amount 0', bridgeCompute({ ...BASE, cltv: '0' }).amount, 0);

console.log('\ndegenerate inputs must not produce NaN or Infinity');
for (const [label, over] of [
  ['no months',   { months: '0' }],
  ['no rate',     { rate: '0' }],
  ['no value',    { value: '' }],
  ['empty fees',  { fees: '' }],
  ['amortised, no months', { months: '0', mode: 'amortized' }],
  ['amortised, zero rate', { rate: '0', mode: 'amortized' }],
]) {
  const r = bridgeCompute({ ...BASE, ...over });
  const bad = ['amount', 'monthly', 'totalInterest', 'pointsAmt', 'totalCost']
    .filter((k) => !isFinite(r[k]));
  t(label + ' -> all finite', bad.length ? bad.join(',') : 'finite', 'finite');
}
/* Zero rate amortising must still repay the principal over the term rather than
   dividing by zero — 190,000 / 9. */
t('zero-rate amortised monthly == amount / months',
  bridgeCompute({ ...BASE, rate: '0', mode: 'amortized' }).monthly, 190000 / 9, 0.01);

console.log('\npoints and fees are on top of interest, never inside it');
const noPts = bridgeCompute({ ...BASE, points: '0', fees: '' });
t('interest unchanged by points/fees', noPts.totalInterest, io.totalInterest);
t('total cost drops by exactly points + fees', io.totalCost - noPts.totalCost, 3800 + 1495);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
