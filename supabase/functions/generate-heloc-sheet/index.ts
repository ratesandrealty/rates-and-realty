import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { PDFDocument, rgb, StandardFonts, PDFFont } from 'npm:pdf-lib@1.17.1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

const W = 720, H = 1020, M = 36, CW = W - M * 2;

const GOLD     = rgb(0.788, 0.659, 0.298);
const WHITE    = rgb(1, 1, 1);
const DARK     = rgb(0.08, 0.08, 0.08);
const GRAY     = rgb(0.52, 0.52, 0.52);
const LGRAY    = rgb(0.87, 0.87, 0.87);
const GOLD_HDR = rgb(0.16, 0.13, 0.03);
const GOLD_TINT= rgb(0.98, 0.97, 0.93);
const ALT_ROW  = rgb(0.975, 0.975, 0.975);
const ROWLINE  = rgb(0.90, 0.90, 0.90);

const san = (x: any): string => x == null ? '' :
  String(x).replace(/[\r\n\t]/g,' ').replace(/[\x00-\x1F\x7F]/g,'').replace(/\s+/g,' ').trim();
const fmtD  = (n: number) => '$' + (isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtPct = (n: number) => (isFinite(n) ? n : 0).toFixed(n % 1 === 0 ? 0 : 2).replace(/\.?0+$/,'') + '%';

function u8b64(arr: Uint8Array): string {
  let b = ''; const ch = 8192;
  for (let i = 0; i < arr.length; i += ch) b += String.fromCharCode(...arr.subarray(i, i + ch));
  return btoa(b);
}

function monthlyPayment(principal: number, annualRatePct: number, termMonths: number): number {
  const n = Math.max(1, Math.round(termMonths));
  const r = (annualRatePct / 100) / 12;
  if (r <= 0) return principal / n;
  const f = Math.pow(1 + r, n);
  return principal * r * f / (f - 1);
}

interface CardIn { type?: string; term_years?: number; rate?: number; selected?: boolean; label?: string; }

function computeHeloc(d: any) {
  const drawAmount   = Number(d.draw_amount || 0);
  const origPct      = Number(d.origination_pct ?? (Array.isArray(d.origination_options) ? d.origination_options[0] : 0)) || 0;
  const autopay      = !!d.autopay;
  const aprCut       = autopay ? (Number(d.autopay_apr_reduction ?? 0.25) || 0) : 0;
  const origFee      = drawAmount * (origPct / 100);
  const totalLoan    = drawAmount + origFee;
  const cashAtClose  = Number(d.cash_at_closing ?? 0) || 0;

  const cardsIn: CardIn[] = Array.isArray(d.cards) ? d.cards.slice(0, 8) : [];
  const cards = cardsIn.map((c) => {
    const termYears  = Number(c.term_years || 0) || 0;
    const termMonths = Math.round(termYears * 12);
    const isVariable = String(c.type || '').toLowerCase().startsWith('var');
    const enteredRate= Number(c.rate || 0) || 0;
    const effRate    = Math.max(0, enteredRate - aprCut);
    return {
      type: isVariable ? 'Variable' : 'Fixed', isVariable, termYears, termMonths,
      enteredRate, effectiveRate: effRate,
      monthly: monthlyPayment(totalLoan, effRate, termMonths),
      selected: !!c.selected,
    };
  });
  const sel = cards.find(c => c.selected) || cards[0] || null;

  const estValue   = Number(d.estimated_value || 0) || 0;
  const mtgBalance = Number(d.mortgage_balance || 0) || 0;
  const cltvMax    = Number(d.cltv_max ?? 85) || 85;
  const maxDraw    = estValue > 0 ? Math.max(0, estValue * (cltvMax / 100) - mtgBalance) : 0;

  return {
    drawAmount, origPct, origFee, totalLoan, cashAtClose, autopay, aprCut,
    estValue, mtgBalance, cltvMax, maxDraw, cards, selected: sel,
    origination_options: Array.isArray(d.origination_options)
      ? d.origination_options.map((p: any) => { const pct = Number(p) || 0; return { pct, fee: drawAmount * (pct / 100) }; })
      : [{ pct: origPct, fee: origFee }]
  };
}

async function buildPDF(d: any, r: ReturnType<typeof computeHeloc>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const R  = await doc.embedFont(StandardFonts.Helvetica);
  const B  = await doc.embedFont(StandardFonts.HelveticaBold);
  const RI = await doc.embedFont(StandardFonts.HelveticaOblique);

  const T = (s: string, x: number, y: number, font: PDFFont, sz: number, color: any) => {
    if (s != null && s !== '') page.drawText(san(s), { x, y, size: sz, font, color });
  };
  const TR = (s: string, xRight: number, y: number, font: PDFFont, sz: number, color: any) => {
    page.drawText(san(s), { x: xRight - font.widthOfTextAtSize(san(s), sz), y, size: sz, font, color });
  };
  const rect = (x: number, y: number, w: number, h: number, color: any) =>
    page.drawRectangle({ x, y, width: w, height: h, color });
  const line = (x: number, y: number, w: number) =>
    page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: 0.5, color: ROWLINE });

  const borrower = san(d.borrower_name || 'Borrower');
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const quoteNum = 'HE-' + Date.now().toString(36).toUpperCase();

  // HEADER BAR (matches fee sheet)
  const hdrH = 60, hdrTop = H;
  rect(0, hdrTop - hdrH, W, hdrH, DARK);
  T('Rates & Realty', M, hdrTop - 24, B, 18, GOLD);
  T('AI-Powered Mortgage  |  NMLS #1416824', M, hdrTop - 38, R, 8, GRAY);
  const rX = W - M;
  let ry = hdrTop - 18;
  TR('Rene Duarte', rX, ry, B, 14, WHITE); ry -= 14;
  TR('Loan Officer  |  NMLS #1795044', rX, ry, R, 8, GRAY); ry -= 11;
  TR('(714) 472-8508  |  rene@ratesandrealty.com', rX, ry, R, 8, GRAY);

  // GOLD BANNER
  let y = hdrTop - hdrH;
  const bannerH = 16;
  rect(0, y - bannerH, W, bannerH, GOLD);
  const banner = 'HOME EQUITY LINE OF CREDIT  \u2014  ESTIMATE';
  T(banner, (W - B.widthOfTextAtSize(banner, 8)) / 2, y - bannerH + 5, B, 8, DARK);
  y -= bannerH + 24;

  // Borrower / property
  T('Prepared for', M, y, R, 8, GRAY);
  T(borrower, M, y - 14, B, 13, DARK);
  if (san(d.property_address)) T(san(d.property_address), M, y - 30, R, 9.5, GRAY);
  TR(today, rX, y, R, 9, GRAY);
  TR('Quote ' + quoteNum, rX, y - 13, R, 8, GRAY);
  y -= 52;

  // Equity context
  if (r.estValue > 0) {
    rect(M, y - 46, CW, 46, GOLD_TINT);
    const cellW = CW / 4;
    const cells: [string, string][] = [
      ['Estimated Value', fmtD(r.estValue)],
      ['Mortgage Balance', fmtD(r.mtgBalance)],
      ['Available Equity (' + fmtPct(r.cltvMax) + ' CLTV)', fmtD(r.maxDraw)],
      ['Requested Draw', fmtD(r.drawAmount)]
    ];
    cells.forEach(([lbl, val], i) => {
      const cx = M + cellW * i + 10;
      T(lbl, cx, y - 16, R, 7.5, GRAY);
      T(val, cx, y - 34, B, 13, DARK);
    });
    y -= 64;
  } else {
    T('Requested Draw', M, y, R, 8, GRAY);
    T(fmtD(r.drawAmount), M, y - 18, B, 15, DARK);
    y -= 38;
  }

  // Origination fee options
  T('ORIGINATION FEE', M, y, B, 9, DARK); y -= 4; line(M, y, CW); y -= 16;
  T('One-time fee added to the loan amount (deducted from proceeds \u2014 no out-of-pocket cost at closing).', M, y, RI, 8, GRAY);
  y -= 18;
  r.origination_options.forEach((o, i) => {
    const sel = Math.abs(o.pct - r.origPct) < 1e-9;
    const bx = M + i * 150;
    rect(bx, y - 26, 140, 30, sel ? GOLD_TINT : WHITE);
    page.drawRectangle({ x: bx, y: y - 26, width: 140, height: 30, borderColor: sel ? GOLD : LGRAY, borderWidth: sel ? 1.5 : 0.75 });
    T(fmtPct(o.pct), bx + 10, y - 11, B, 11, DARK);
    T(fmtD(o.fee), bx + 10, y - 23, R, 9, GRAY);
    if (sel) T('SELECTED', bx + 70, y - 11, B, 7, GOLD);
  });
  y -= 44;

  // Comparison table
  T('SELECT THE TERM & MONTHLY PAYMENT', M, y, B, 9, DARK); y -= 6;
  const colTerm = M, colType = M + CW * 0.30, colRate = M + CW * 0.52, colPmtR = W - M, rh = 26;
  rect(M, y - rh, CW, rh, rgb(0.13, 0.13, 0.13));
  T('Term', colTerm + 10, y - 17, B, 9, WHITE);
  T('Type', colType, y - 17, B, 9, WHITE);
  T('Rate', colRate, y - 17, B, 9, WHITE);
  TR('Est. Monthly Payment', colPmtR - 10, y - 17, B, 9, WHITE);
  y -= rh;
  const nCards = r.cards.length;
  r.cards.forEach((c, i) => {
    const isSel = r.selected && c === r.selected;
    rect(M, y - rh, CW, rh, isSel ? GOLD_TINT : (i % 2 ? ALT_ROW : WHITE));
    if (isSel) rect(M, y - rh, 3, rh, GOLD);
    T(c.termYears + ' yr', colTerm + 10, y - 17, B, 10, DARK);
    T(c.type, colType, y - 17, R, 10, c.isVariable ? GRAY : DARK);
    const rateLabel = (c.isVariable ? 'Starting ' : '') + fmtPct(c.enteredRate) +
                      (r.autopay && r.aprCut > 0 ? '  (' + fmtPct(c.effectiveRate) + ' w/AutoPay)' : '');
    T(rateLabel, colRate, y - 17, R, 9, DARK);
    TR(fmtD(c.monthly) + '/mo', colPmtR - 10, y - 17, B, 11, DARK);
    line(M, y - rh, CW);
    y -= rh;
  });
  page.drawRectangle({ x: M, y, width: CW, height: rh * nCards + rh, borderColor: LGRAY, borderWidth: 0.75 });
  y -= 24;

  // Loan Breakdown
  const sel = r.selected;
  T('LOAN BREAKDOWN', M, y, B, 9, DARK);
  if (sel) T(sel.termYears + 'yr ' + sel.type.toLowerCase(), M + 120, y, RI, 8, GRAY);
  y -= 8;
  const boxTop = y;
  const rows: [string, string][] = [
    ['Initial Draw Amount', fmtD(r.drawAmount)],
    ['Cash Required at Closing', fmtD(r.cashAtClose)],
    ['Term', sel ? (sel.termYears + ' yrs / ' + sel.termMonths + ' mo.') : '\u2014'],
    ['Origination Fee (deducted from total)', fmtPct(r.origPct) + '   ' + fmtD(r.origFee)],
  ];
  const brh = 22;
  rect(M, boxTop - brh * (rows.length + 2), CW, brh * (rows.length + 2), rgb(0.985, 0.985, 0.985));
  page.drawRectangle({ x: M, y: boxTop - brh * (rows.length + 2), width: CW, height: brh * (rows.length + 2), borderColor: LGRAY, borderWidth: 0.75 });
  let by = boxTop - 16;
  rows.forEach(([l, v]) => { T(l, M + 12, by, R, 9.5, DARK); TR(v, W - M - 12, by, R, 9.5, DARK); by -= brh; line(M + 8, by + 6, CW - 16); });
  T('Total Loan Amount', M + 12, by, B, 10, DARK);
  T('Initial draw + origination fee', M + 12, by - 9, RI, 6.5, GRAY);
  TR(fmtD(r.totalLoan), W - M - 12, by, B, 11, DARK);
  by -= brh; line(M + 8, by + 6, CW - 16);
  T('Est. Monthly Payment', M + 12, by, B, 10, GOLD_HDR);
  TR(sel ? fmtD(sel.monthly) : '\u2014', W - M - 12, by, B, 12, GOLD_HDR);
  y = boxTop - brh * (rows.length + 2) - 18;
  if (r.autopay) { T('AutoPay enrolled \u2014 ' + fmtPct(r.aprCut) + ' APR reduction applied to the rates above.', M, y, RI, 8, GRAY); y -= 16; }

  // FOOTER DISCLAIMER (matches fee sheet)
  const disc =
    'This Home Equity Line of Credit estimate is provided for informational purposes only and does not constitute a commitment to lend or a Loan Estimate as defined under TRID/TILA-RESPA. ' +
    'All rates, payments, fees, and available credit shown are estimates based on rates entered by the loan officer and current information, and are subject to change. Final terms will be confirmed after a completed application, property valuation, and full underwriting review. ' +
    'Prepared by Rene Duarte, NMLS #1795044, Rates & Realty Inc., NMLS #1416824, CA DRE #02075036. Equal Housing Lender.';
  let fy = Math.min(y, 80);
  rect(M, fy + 6, CW, 0.75, LGRAY);
  const words = disc.split(' ');
  let lineStr = ''; let ly = fy - 6;
  for (const w of words) {
    const test = lineStr ? lineStr + ' ' + w : w;
    if (RI.widthOfTextAtSize(test, 6) > CW) { T(lineStr, M, ly, RI, 6, GRAY); ly -= 8; lineStr = w; }
    else lineStr = test;
  }
  if (lineStr) T(lineStr, M, ly, RI, 6, GRAY);

  return doc.save();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json();
    const results = computeHeloc(body);
    const wantPdf = body.pdf !== false;
    let pdf: string | undefined;
    if (wantPdf) pdf = u8b64(await buildPDF(body, results));
    return new Response(JSON.stringify({ success: true, results, pdf }),
      { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('generate-heloc-sheet:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
