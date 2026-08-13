/* mi-factors — THE mortgage-insurance factor table. One definition.
 *
 * Before this file there were SIX independent implementations and conventional
 * >80% LTV had FOUR different answers:
 *
 *   tools/fee-sheet.html:1643      conv 0.20%   (and a 7th inline copy at :1926)
 *   public/fee.html:150            conv 0.20%
 *   generate-fee-sheet:96          conv 0.50%
 *   lead-detail.html:25427         conv/Jumbo 0.30%
 *   lead-detail.html:27484         LTV ladder 0.52 / 0.68 / 0.85 / 1.02
 *   mortgage-calc:60               FICO x LTV matrix 0.28 – 0.95%
 *
 * On a real live link (Shelley Hurle, $712,500 at 95% LTV) the 0.20% flat rate
 * quoted the borrower $118.75/mo where the ladder gives $504.69 — a $385.94
 * monthly understatement, on a sheet that had been viewed and sent.
 *
 * THE LADDER IS THE CANONICAL TABLE. It is the only one of the six that prices
 * by LTV, which is how private MI is actually priced; a flat rate is wrong at
 * both ends of the range and most wrong exactly where these sheets sit (95%).
 * FICO tiering (mortgage-calc's matrix) is more precise still, but credit score
 * is not present on the fee-sheet inputs at all, so adopting it would mean
 * inventing a score. Where a real MI quote exists it should override this
 * entirely — this is an estimate and every surface labels it as one.
 *
 * DUAL SOURCE, GUARDED. Deno cannot import from the site tree, so the same
 * table exists at supabase/functions/_shared/mi-factors.ts.
 * tools/test-mi-factors.mjs lifts BOTH and asserts they agree across the whole
 * product x LTV grid, so the copies cannot drift the way these six did.
 */
(function (root) {
  'use strict';

  /* Conventional / Jumbo private MI, annual % of the base loan, LTV-priced.
     Ordered; first match wins. No entry at or below 80% — MI ends there. */
  var CONV_LADDER = [
    { maxLtv: 80,       rate: 0      },
    { maxLtv: 85,       rate: 0.0052 },
    { maxLtv: 90,       rate: 0.0068 },
    { maxLtv: 95,       rate: 0.0085 },
    { maxLtv: Infinity, rate: 0.0102 },
  ];

  /* FHA annual MIP, 30-year. NOT LTV>80-gated: FHA MIP is charged for the life
     of the loan above 90% LTV and for 11 years below it, so an FHA loan at 75%
     still pays it. Charged on the FINANCED balance (post-UFMIP) where the
     caller knows it. High-balance FHA prices higher above a threshold that is
     unresolved here — see the $726,200 warning in lead-detail. */
  function fhaRate(ltv) { return ltv > 95 ? 0.0055 : 0.0050; }

  var USDA_ANNUAL = 0.0035;   // USDA annual guarantee fee

  function productKind(product) {
    var p = String(product || '').toUpperCase().trim();
    if (!p) return 'unknown';
    if (/\bFHA\b/.test(p))  return 'fha';
    if (/\bVA\b/.test(p))   return 'va';
    if (/\bUSDA\b/.test(p)) return 'usda';
    if (/\bCONV(ENTIONAL)?\b/.test(p) || /\bJUMBO\b/.test(p)) return 'conventional';
    return 'unknown';
  }

  /* Returns { rate, kind, manual }.
     manual:true means "we have no defensible factor for this product" — the
     caller must keep whatever the user typed rather than substitute a number.
     That is Non-QM / DSCR / anything unrecognised. Returning 0 for those would
     silently quote a borrower no mortgage insurance at all. */
  function miFactor(product, ltv) {
    var kind = productKind(product);
    var l = Number(ltv) || 0;
    if (kind === 'va')   return { rate: 0, kind: kind, manual: false };
    if (kind === 'fha')  return { rate: fhaRate(l), kind: kind, manual: false };
    if (kind === 'usda') return { rate: USDA_ANNUAL, kind: kind, manual: false };
    if (kind === 'conventional') {
      for (var i = 0; i < CONV_LADDER.length; i++) {
        if (l <= CONV_LADDER[i].maxLtv) return { rate: CONV_LADDER[i].rate, kind: kind, manual: false };
      }
    }
    return { rate: 0, kind: 'unknown', manual: true };
  }

  /* Monthly MI in dollars.
     `loanAmount` is the base loan; `totalLoanAmount` the financed balance
     (base + any financed upfront fee). FHA prices on the financed balance when
     one is supplied; conventional prices on the base loan. */
  function monthlyMI(opts) {
    opts = opts || {};
    var f = miFactor(opts.product, opts.ltv);
    if (f.manual) return null;
    if (!f.rate) return 0;
    var base = (f.kind === 'fha' && opts.totalLoanAmount) ? opts.totalLoanAmount : opts.loanAmount;
    var n = Number(base) || 0;
    if (n <= 0) return 0;
    return n * f.rate / 12;
  }

  var api = {
    CONV_LADDER: CONV_LADDER,
    USDA_ANNUAL: USDA_ANNUAL,
    fhaRate: fhaRate,
    productKind: productKind,
    miFactor: miFactor,
    monthlyMI: monthlyMI,
  };

  root.RRMiFactors = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
