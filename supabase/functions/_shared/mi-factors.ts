/* mi-factors — THE mortgage-insurance factor table, Deno half.
 *
 * The canonical explanation lives in public/js/mi-factors.js. Short version:
 * there were SIX independent MI implementations and conventional >80% LTV had
 * FOUR different answers, so a real live share link quoted a borrower $118.75/mo
 * where the LTV ladder gives $504.69.
 *
 * THIS FILE MUST STAY IDENTICAL IN BEHAVIOUR to public/js/mi-factors.js. Deno
 * cannot import from the site tree and the browser cannot import from
 * supabase/functions, so the table exists twice on purpose.
 * tools/test-mi-factors.mjs lifts BOTH and compares them across the whole
 * product x LTV grid; a drift between these two files fails that test. Editing
 * one without the other is the exact failure this replaced.
 */

export const CONV_LADDER: { maxLtv: number; rate: number }[] = [
  { maxLtv: 80,       rate: 0      },
  { maxLtv: 85,       rate: 0.0052 },
  { maxLtv: 90,       rate: 0.0068 },
  { maxLtv: 95,       rate: 0.0085 },
  { maxLtv: Infinity, rate: 0.0102 },
];

export const USDA_ANNUAL = 0.0035;

export function fhaRate(ltv: number): number {
  return ltv > 95 ? 0.0055 : 0.0050;
}

export function productKind(product: string): string {
  const p = String(product || "").toUpperCase().trim();
  if (!p) return "unknown";
  if (/\bFHA\b/.test(p))  return "fha";
  if (/\bVA\b/.test(p))   return "va";
  if (/\bUSDA\b/.test(p)) return "usda";
  if (/\bCONV(ENTIONAL)?\b/.test(p) || /\bJUMBO\b/.test(p)) return "conventional";
  return "unknown";
}

export function miFactor(product: string, ltv: number): { rate: number; kind: string; manual: boolean } {
  const kind = productKind(product);
  const l = Number(ltv) || 0;
  if (kind === "va")   return { rate: 0, kind, manual: false };
  if (kind === "fha")  return { rate: fhaRate(l), kind, manual: false };
  if (kind === "usda") return { rate: USDA_ANNUAL, kind, manual: false };
  if (kind === "conventional") {
    for (const step of CONV_LADDER) {
      if (l <= step.maxLtv) return { rate: step.rate, kind, manual: false };
    }
  }
  return { rate: 0, kind: "unknown", manual: true };
}

/* null means "no defensible factor for this product — keep what the user
   typed". Returning 0 would quote a borrower no mortgage insurance at all. */
export function monthlyMI(opts: {
  product?: string; ltv?: number; loanAmount?: number; totalLoanAmount?: number;
}): number | null {
  const f = miFactor(opts.product || "", Number(opts.ltv) || 0);
  if (f.manual) return null;
  if (!f.rate) return 0;
  const base = (f.kind === "fha" && opts.totalLoanAmount) ? opts.totalLoanAmount : opts.loanAmount;
  const n = Number(base) || 0;
  if (n <= 0) return 0;
  return n * f.rate / 12;
}
