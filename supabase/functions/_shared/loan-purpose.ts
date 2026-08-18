/* One reading of "what kind of transaction is this", for every consumer.
 *
 * WHY A NORMALISER AND NOT A COMPARISON. There are five vocabularies writing a
 * loan purpose in this project and only two of them are constrained (see
 * docs/LOAN-PURPOSE-VOCABULARIES-2026-08-18.md). `contacts.loan_purpose` is now
 * a code with an FK to transaction_types; `mortgage_applications.loan_purpose`
 * is NOT, because the borrower portal and the MISMO importer write free text
 * into it and those surfaces were deliberately left alone. So anything reading a
 * purpose sees either a code or a legacy string, and must accept both.
 *
 * UNKNOWN RETURNS null, NEVER A DEFAULT. generate-1003 used to read
 *   v(d.loan_purpose,'Purchase') === 'Purchase'
 * which meant a contact with NO stated purpose printed a 1003 with Purchase
 * ticked -- 1032 of 1048 contacts. A form asserting a purpose nobody stated is
 * worse than one leaving it blank, so an unrecognised or absent value ticks
 * nothing at all.
 *
 * THE CASH-OUT DISTINCTION IS CARRIED BUT CANNOT BE PRINTED. Neither template
 * has a Cash-Out box -- both offer only Purchase / Refinance / Other -- so
 * refi_rate_term and refi_cash_out both render as Refinance. That is accepted:
 * adding the box is a change to a legal form and gets its own pass. cashOut()
 * exists so the data is already there when somebody does it. */

export type PurposeFamily = 'purchase' | 'refinance' | 'other' | null;

/** lowercase, and fold the separators the five vocabularies disagree about
 *  ('Cash-Out Refinance', 'refi_cash_out', 'No Cash Out Refinance'). */
function fold(raw: unknown): string {
  return String(raw ?? '').toLowerCase().replace(/[\s\-_&]+/g, '');
}

/* Keys are FOLDED forms. Anything absent is unknown, which is not 'other':
 * 'other' is a purpose somebody chose, unknown is the absence of one. */
const FAMILY: Record<string, PurposeFamily> = {
  // the constrained codes
  purchase:      'purchase',
  refirateterm:  'refinance',
  reficashout:   'refinance',
  other:         'other',
  construction:  'other',       // the trio has no Construction box; Other is the honest bucket

  // legacy free text still arriving from the portal, auth and MISMO
  refinance:            'refinance',   // bare: which kind is NOT stated
  nocashoutrefinance:   'refinance',
  cashoutrefinance:     'refinance',
  limitedcashout:       'refinance',
  cashout:              'refinance',
  rateandterm:          'refinance',
  constructiontopermanent: 'other',
};

/** Which of the form's three boxes to tick. null = tick none. */
export function purposeFamily(raw: unknown): PurposeFamily {
  const k = fold(raw);
  if (!k) return null;
  return FAMILY[k] ?? null;
}

/** true = cash-out, false = not cash-out, null = a refinance whose kind was
 *  never stated, or not a refinance at all. Three states on purpose: "we do not
 *  know" must not collapse into "no". */
export function purposeCashOut(raw: unknown): boolean | null {
  const k = fold(raw);
  if (k === 'reficashout' || k === 'cashoutrefinance' || k === 'cashout') return true;
  if (k === 'refirateterm' || k === 'nocashoutrefinance' || k === 'limitedcashout'
      || k === 'rateandterm') return false;
  return null;
}

/** The string the form prints where it prints a purpose in words. */
export function purposeLabel(raw: unknown): string {
  const k = fold(raw);
  if (k === 'purchase') return 'Purchase';
  if (k === 'reficashout' || k === 'cashoutrefinance' || k === 'cashout') return 'Refinance: Cash Out';
  if (k === 'refirateterm' || k === 'nocashoutrefinance' || k === 'limitedcashout'
      || k === 'rateandterm') return 'Refinance: Rate & Term';
  if (k === 'refinance') return 'Refinance';
  if (k === 'other' || k === 'construction' || k === 'constructiontopermanent') return 'Other';
  return '';
}
