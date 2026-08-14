/**
 * test-mi-factors — one MI table, and it must STAY one.
 *
 *   node tools/test-mi-factors.mjs
 *
 * WHY THIS EXISTS. There were SIX independent MI implementations and
 * conventional >80% LTV had FOUR different answers (0.20 / 0.30 / 0.50 / the
 * LTV ladder), plus a FICO matrix in mortgage-calc and a seventh inline copy
 * inside the fee sheet's APR block. A live share link quoted a borrower
 * $118.75/mo where the ladder gives $504.69.
 *
 * The table now lives in two files because Deno cannot import from the site
 * tree and the browser cannot import from supabase/functions. Two files is how
 * this started. So this test lifts BOTH and requires them to agree across the
 * whole product x LTV grid — editing one without the other fails here.
 *
 * It also greps every surface for a resurrected hard-coded factor, because the
 * failure mode is not "the shared table is wrong", it is "someone added a
 * seventh copy next to it".
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log((ok ? '  OK   ' : '  FAIL ') + label);
  if (!ok && detail) console.log('        ' + detail);
};
const near = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;

/* ── load the browser copy ─────────────────────────────────────────────── */
const browserSrc = readFileSync('public/js/mi-factors.js', 'utf8');
const browser = new Function(browserSrc + '\nreturn globalThis.RRMiFactors;')();

/* ── load the Deno copy by transpiling the type annotations away ───────── */
const denoSrc = readFileSync('supabase/functions/_shared/mi-factors.ts', 'utf8')
  .replace(/^export\s+/gm, '')
  .replace(/:\s*\{\s*maxLtv:\s*number;\s*rate:\s*number\s*\}\[\]/g, '')
  .replace(/\(product:\s*string,\s*ltv:\s*number\)\s*:\s*\{[^}]*\}/g, '(product, ltv)')
  .replace(/\(ltv:\s*number\)\s*:\s*number/g, '(ltv)')
  .replace(/\(product:\s*string\)\s*:\s*string/g, '(product)')
  .replace(/\(opts:\s*\{[\s\S]*?\}\)\s*:\s*number\s*\|\s*null/g, '(opts)')
  .replace(/const\s+kind\s*=\s*productKind\(product\);/, 'const kind = productKind(product);');
const deno = new Function(denoSrc + '\nreturn { CONV_LADDER, USDA_ANNUAL, fhaRate, productKind, miFactor, monthlyMI };')();

/* ── the grid ──────────────────────────────────────────────────────────── */
const PRODUCTS = ['Conv 30yr Fixed', 'Conventional', 'Jumbo', 'FHA 30yr Fixed', 'FHA',
                  'VA 30yr Fixed', 'USDA', 'Non-QM', 'DSCR', '', 'Bank Statement'];
const LTVS = [0, 50, 75, 79.99, 80, 80.01, 85, 85.01, 90, 90.01, 95, 95.01, 96.5, 97, 100];

console.log('the two copies agree across the whole product x LTV grid');
let mismatches = 0;
for (const p of PRODUCTS) {
  for (const l of LTVS) {
    const a = browser.monthlyMI({ product: p, ltv: l, loanAmount: 400000 });
    const b = deno.monthlyMI({ product: p, ltv: l, loanAmount: 400000 });
    if (!(a === b || (a != null && b != null && near(a, b, 1e-9)))) {
      mismatches++;
      if (mismatches <= 3) console.log(`        ${p} @ ${l}%: browser ${a} vs deno ${b}`);
    }
  }
}
t(`${PRODUCTS.length * LTVS.length} grid points identical`, mismatches === 0, mismatches + ' mismatched');

console.log('\nShelley Hurle — the live link that was wrong (712,500 @ 95% LTV, conventional)');
const shelley = browser.monthlyMI({ product: 'Conv 30yr Fixed', ltv: 95, loanAmount: 712500 });
t('MI is $504.69, not the old $118.75', near(shelley, 504.6875, 0.01), 'got ' + shelley.toFixed(2));
t('the old flat 0.20% would have given $118.75', near(712500 * 0.002 / 12, 118.75, 0.01));

console.log('\nthe ladder boundaries — inclusive upper bounds');
for (const [ltv, rate] of [[80, 0], [85, 0.0052], [90, 0.0068], [95, 0.0085], [95.01, 0.0102], [96.5, 0.0102]]) {
  const got = browser.miFactor('Conventional', ltv).rate;
  t(`conventional @ ${ltv}% -> ${(rate * 100).toFixed(2)}%`, got === rate, 'got ' + (got * 100).toFixed(2) + '%');
}
t('80% LTV conventional is EXACTLY zero', browser.monthlyMI({ product: 'Conventional', ltv: 80, loanAmount: 712500 }) === 0);

console.log('\nFHA branches preserved in the shared table');
t('FHA > 95% LTV -> 0.55%', browser.fhaRate(96.5) === 0.0055);
t('FHA <= 95% LTV -> 0.50%', browser.fhaRate(95) === 0.0050);
t('FHA at 75% LTV still charges MIP (no >80 gate)',
  browser.monthlyMI({ product: 'FHA', ltv: 75, loanAmount: 400000 }) > 0);
t('FHA prices on the FINANCED balance when supplied',
  near(browser.monthlyMI({ product: 'FHA', ltv: 96.5, loanAmount: 400000, totalLoanAmount: 407000 }),
       407000 * 0.0055 / 12, 0.01));
t('VA is always zero, even above 95%', browser.monthlyMI({ product: 'VA 30yr Fixed', ltv: 100, loanAmount: 400000 }) === 0);
t('USDA is 0.35%', near(browser.monthlyMI({ product: 'USDA', ltv: 100, loanAmount: 400000 }), 400000 * 0.0035 / 12, 0.01));

console.log('\nunknown products return null, NOT zero');
t('Non-QM -> null (keep the manual value)', browser.monthlyMI({ product: 'Non-QM', ltv: 95, loanAmount: 400000 }) === null);
t('DSCR -> null', browser.monthlyMI({ product: 'DSCR', ltv: 95, loanAmount: 400000 }) === null);
t('empty product -> null', browser.monthlyMI({ product: '', ltv: 95, loanAmount: 400000 }) === null);
t('Jumbo is treated as conventional, not unknown',
  browser.monthlyMI({ product: 'Jumbo', ltv: 95, loanAmount: 400000 }) > 0);

console.log('\nno surface has resurrected a hard-coded factor');
/* FIVE SITES, and this list covered four. admin/lead-detail.html holds two
   RRMiFactors call sites — the 1003 dash and the loan sizer that feeds EVERY
   pre-approval letter — and was not guarded, so a hardcoded factor
   reintroduced there would have passed. It is the surface whose number leaves
   the building on a signed letter. */
const SURFACES = [
  'tools/fee-sheet.html', 'public/fee.html', 'admin/lead-detail.html',
  'supabase/functions/generate-fee-sheet/index.ts', 'supabase/functions/mortgage-calc/index.ts',
];
const BANNED = /0\.002\s*\/\s*12|0\.0030?\s*\/\s*12|0\.005\s*\/\s*12|0\.0052|0\.0068|0\.0085|0\.0102|pmiRate/;
for (const f of SURFACES) {
  const src = readFileSync(f, 'utf8');
  const body = src.split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
  t(`${f} holds no MI factor of its own`, !BANNED.test(body),
    (body.match(BANNED) || [''])[0]);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
