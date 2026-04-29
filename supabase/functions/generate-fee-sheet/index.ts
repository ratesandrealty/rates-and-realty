import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { PDFDocument, rgb, StandardFonts, PDFFont, PDFPage } from 'npm:pdf-lib@1.17.1';

const QR_CODE_B64 = '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';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

// LANDSCAPE letter
const W = 792, H = 612, M = 30, CW = W - M * 2;

const GOLD  = rgb(0.788, 0.659, 0.298);
const WHITE = rgb(1, 1, 1);
const DARK  = rgb(0.08, 0.08, 0.08);
const GRAY  = rgb(0.52, 0.52, 0.52);
const LGRAY = rgb(0.87, 0.87, 0.87);
const BGRAY = rgb(0.97, 0.96, 0.94);
const GOLD_TINT = rgb(0.98, 0.97, 0.93);      // very subtle gold tint for recommended cells
const GOLD_HDR  = rgb(0.16, 0.13, 0.03);       // gold-tinted dark bg for recommended header

const san = (x: any): string => x == null ? '' :
  String(x).replace(/[\r\n\t]/g,' ').replace(/[\x00-\x1F\x7F]/g,'').replace(/\s+/g,' ').trim();
const fmt  = (n: number, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtD = (n: number) => '$' + fmt(n, 2);
const fmtD0 = (n: number) => '$' + fmt(n, 0);

function u8b64(arr: Uint8Array): string {
  let b = ''; const ch = 8192;
  for (let i = 0; i < arr.length; i += ch) b += String.fromCharCode(...arr.subarray(i, i + ch));
  return btoa(b);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const body = await req.json();
    const pdfBytes = await buildPDF(body);
    return new Response(JSON.stringify({ success: true, pdf: u8b64(pdfBytes), type: 'application/pdf' }),
      { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('generate-fee-sheet:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});

// ─── Fee calculation helpers ─────────────────────────────────────────────────

interface Scenario {
  id: string; label: string; rate: number; points: number;
  origComp: number; lenderCredits: number; recommended: boolean;
}

function calcAppraisalFee(propertyType: string): number {
  const t = (propertyType || 'SFR').toUpperCase();
  if (t.includes('CONDO')) return 695;
  if (t.includes('2-4') || t.includes('MULTI') || t.includes('UNIT')) return 895;
  if (t.includes('TOWN')) return 595;
  return 595; // SFR default
}

function calcTitleLenderPolicy(purchasePrice: number): number {
  if (purchasePrice <= 500000) return 450;
  if (purchasePrice <= 1000000) return 450 + (purchasePrice - 500000) / 1000 * 1.75;
  return 1325 + (purchasePrice - 1000000) / 1000 * 1.50;
}

function calcEscrowFee(purchasePrice: number): number {
  return Math.max(500, purchasePrice / 1000 * 2);
}

function calcRecordingFee(state: string): number {
  const s = (state || 'CA').toUpperCase();
  if (s === 'TX') return 100;
  if (s === 'FL') return 150;
  if (s === 'NY') return 250;
  return 125; // CA / default
}

function calcMonthlyPI(loanAmount: number, ratePercent: number, termMonths = 360): number {
  const r = ratePercent / 100 / 12;
  if (r === 0) return loanAmount / termMonths;
  const factor = Math.pow(1 + r, termMonths);
  return loanAmount * r * factor / (factor - 1);
}

function calcMI(loanProduct: string, ltv: number, loanAmount: number): number {
  const prod = (loanProduct || '').toUpperCase();
  if (prod.includes('FHA')) return loanAmount * 0.0055 / 12;
  if (prod.includes('CONV') && ltv > 80) return loanAmount * 0.005 / 12;
  return 0;
}

// ─── Build PDF ───────────────────────────────────────────────────────────────

async function buildPDF(d: any): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const R = await doc.embedFont(StandardFonts.Helvetica);
  const B = await doc.embedFont(StandardFonts.HelveticaBold);

  const borrowerName    = san(d.borrower_name || 'Borrower');
  const propertyAddress = san(d.property_address || '');
  const purchasePrice   = Number(d.purchase_price || 0);
  const loanAmount      = Number(d.loan_amount || 0);
  const downPct         = Number(d.down_pct || 0);
  const ltv             = Number(d.ltv || 0);
  const loanProduct     = san(d.loan_product || 'Conv 30yr Fixed');
  const lockPeriod      = san(d.lock_period || '30 days');
  const annualTax       = Number(d.annual_tax || 0);
  const annualIns       = Number(d.annual_insurance || 0);
  const propertyType    = san(d.property_type || 'SFR');
  const state           = san(d.state || 'CA');
  const scenarios: Scenario[] = (d.scenarios || []).slice(0, 3);

  const numScenarios = scenarios.length;
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const quoteNum = 'FE-' + Date.now().toString(36).toUpperCase();

  // shorthand
  const T = (s: string, x: number, y: number, font: PDFFont, sz: number, color: any) => {
    if (s) page.drawText(san(s), { x, y, size: sz, font, color });
  };
  const rect = (x: number, y: number, w: number, h: number, color: any) => {
    page.drawRectangle({ x, y, width: w, height: h, color });
  };
  const hLine = (x: number, y: number, w: number, color: any) => {
    page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: 0.5, color });
  };

  let y = H; // cursor from top

  // ── 1. HEADER BAR ──────────────────────────────────────────────────────────
  const hdrH = 45;
  rect(0, H - hdrH, W, hdrH, DARK);
  y = H - 14;
  T('Rates & Realty', M, y, B, 14, GOLD);
  y -= 12;
  T('AI-Powered Mortgage  |  NMLS #1416824', M, y, R, 7, GRAY);

  // Right side
  const rX = W - M;
  let ry = H - 12;
  const rText1 = 'Rene Duarte';
  T(rText1, rX - B.widthOfTextAtSize(rText1, 9), ry, B, 9, WHITE);
  ry -= 11;
  const rText2 = 'Loan Officer  |  NMLS #1795044';
  T(rText2, rX - R.widthOfTextAtSize(rText2, 7), ry, R, 7, GRAY);
  ry -= 10;
  const rText3 = '(818) 590-7389  |  rene@ratesandrealty.com';
  T(rText3, rX - R.widthOfTextAtSize(rText3, 7), ry, R, 7, GRAY);

  y = H - hdrH;

  // ── 2. GOLD BANNER ─────────────────────────────────────────────────────────
  const bannerH = 16;
  rect(0, y - bannerH, W, bannerH, GOLD);
  const bannerText = 'LOAN FEE ESTIMATE';
  T(bannerText, (W - B.widthOfTextAtSize(bannerText, 9)) / 2, y - bannerH + 4, B, 9, DARK);
  y -= bannerH;

  // ── 3. INFO ROW ────────────────────────────────────────────────────────────
  const infoH = 16;
  rect(0, y - infoH, W, infoH, BGRAY);
  const iy = y - infoH + 4;
  T('Date: ' + today, M, iy, R, 7, DARK);
  const qt = 'Quote #: ' + quoteNum;
  T(qt, (W - R.widthOfTextAtSize(qt, 7)) / 2, iy, R, 7, DARK);
  const infoRight = borrowerName + '  |  ' + propertyAddress;
  T(infoRight, rX - R.widthOfTextAtSize(infoRight, 7), iy, R, 7, DARK);
  y -= infoH;

  // ── 4. SUMMARY STRIP ──────────────────────────────────────────────────────
  const stripH = 16;
  rect(0, y - stripH, W, stripH, WHITE);
  hLine(0, y, W, LGRAY);
  hLine(0, y - stripH, W, LGRAY);

  const summaryItems = [
    { label: 'Purchase Price', value: fmtD0(purchasePrice) },
    { label: 'Loan Amount', value: fmtD0(loanAmount) },
    { label: 'LTV', value: ltv + '%' },
    { label: 'Product', value: loanProduct },
    { label: 'Lock', value: lockPeriod },
  ];
  const colW = CW / summaryItems.length;
  const sy = y - stripH + 4;
  summaryItems.forEach((item, i) => {
    const cx = M + colW * i;
    T(item.label + ': ', cx + 4, sy, R, 6.5, GRAY);
    const lw = R.widthOfTextAtSize(item.label + ': ', 6.5);
    T(item.value, cx + 4 + lw, sy, B, 6.5, DARK);
    if (i > 0) page.drawLine({ start: { x: cx, y: y }, end: { x: cx, y: y - stripH }, thickness: 0.5, color: LGRAY });
  });
  y -= stripH;

  // ── 5. FEE TABLE ───────────────────────────────────────────────────────────
  y -= 2; // small gap

  // Column layout
  const descColW = CW * 0.44;
  const scenColW = (CW - descColW) / numScenarios;
  const tableX = M;
  const descX = tableX;

  // Pre-compute all fees per scenario
  const appraisalFee = calcAppraisalFee(propertyType);
  const titleFee = calcTitleLenderPolicy(purchasePrice);
  const escrowFee = calcEscrowFee(purchasePrice);
  const recordingFee = calcRecordingFee(state);

  interface FeeRow {
    label: string;
    values: number[];
    type: 'row' | 'category' | 'subtotal' | 'grandtotal';
  }

  const rows: FeeRow[] = [];

  // Helper to push row
  const addCat = (label: string) => rows.push({ label, values: [], type: 'category' });
  const addRow = (label: string, vals: number[]) => rows.push({ label, values: vals, type: 'row' });
  const addSub = (label: string, vals: number[]) => rows.push({ label, values: vals, type: 'subtotal' });
  const addGrand = (label: string, vals: number[]) => rows.push({ label, values: vals, type: 'grandtotal' });

  // A. ORIGINATION CHARGES
  const origFees = scenarios.map(s => loanAmount * s.origComp / 100);
  const discPoints = scenarios.map(s => s.points > 0 ? loanAmount * s.points / 100 : 0);
  const uwFee = scenarios.map(() => 1350);
  const subA = scenarios.map((_, i) => origFees[i] + discPoints[i] + uwFee[i]);

  addCat('A. ORIGINATION CHARGES');
  addRow('Origination Fee', origFees);
  addRow('Discount Points', discPoints);
  addRow('Underwriting Fee', uwFee);
  addSub('Subtotal A', subA);

  // B. SERVICES YOU CANNOT SHOP FOR
  const appr = scenarios.map(() => appraisalFee);
  const credit = scenarios.map(() => 65);
  const flood = scenarios.map(() => 12);
  const taxSvc = scenarios.map(() => 85);
  const mers = scenarios.map(() => 24.95);
  const proc = scenarios.map(() => 995);
  const subB = scenarios.map((_, i) => appr[i] + credit[i] + flood[i] + taxSvc[i] + mers[i] + proc[i]);

  addCat('B. SERVICES YOU CANNOT SHOP FOR');
  addRow('Appraisal Fee', appr);
  addRow('Credit Report', credit);
  addRow('Flood Certification', flood);
  addRow('Tax Service Fee', taxSvc);
  addRow('MERS Registration', mers);
  addRow('Processing Fee', proc);
  addSub('Subtotal B', subB);

  // C. SERVICES YOU CAN SHOP FOR
  const titleV = scenarios.map(() => titleFee);
  const escrowV = scenarios.map(() => escrowFee);
  const recV = scenarios.map(() => recordingFee);
  const notary = scenarios.map(() => 175);
  const tieIn = scenarios.map(() => 150);
  const messenger = scenarios.map(() => 125);
  const subEsc = scenarios.map(() => 50);
  const subC = scenarios.map((_, i) => titleV[i] + escrowV[i] + recV[i] + notary[i] + tieIn[i] + messenger[i] + subEsc[i]);

  addCat('C. SERVICES YOU CAN SHOP FOR');
  addRow("Title - Lender's Policy", titleV);
  addRow('Escrow / Settlement Fee', escrowV);
  addRow('Recording Fees', recV);
  addRow('Notary Fee', notary);
  addRow('Loan Tie-In Fee', tieIn);
  addRow('Messenger Fee', messenger);
  addRow('Sub-Escrow Fee', subEsc);
  addSub('Subtotal C', subC);

  // D. TOTAL LOAN COSTS
  const totalD = scenarios.map((_, i) => subA[i] + subB[i] + subC[i]);
  addGrand('D. TOTAL LOAN COSTS (A+B+C)', totalD);

  // E. PREPAIDS
  const prepaidInt = scenarios.map(s => loanAmount * s.rate / 100 / 365 * 3);
  const hoIns = scenarios.map(() => annualIns);
  const subE = scenarios.map((_, i) => prepaidInt[i] + hoIns[i]);

  addCat('E. PREPAIDS');
  addRow('Prepaid Interest (3 days)', prepaidInt);
  addRow("Homeowner's Insurance (12 mo)", hoIns);
  addSub('Subtotal E', subE);

  // F. INITIAL ESCROW PAYMENT AT CLOSING
  const taxRes = scenarios.map(() => annualTax / 12 * 3);
  const hazRes = scenarios.map(() => annualIns / 12 * 2);
  const subF = scenarios.map((_, i) => taxRes[i] + hazRes[i]);

  addCat('F. INITIAL ESCROW PAYMENT AT CLOSING');
  addRow('Property Tax Reserve (3 mo)', taxRes);
  addRow('Hazard Insurance Reserve (2 mo)', hazRes);
  addSub('Subtotal F', subF);

  // G. TOTAL OTHER COSTS
  const totalG = scenarios.map((_, i) => subE[i] + subF[i]);
  addGrand('G. TOTAL OTHER COSTS (E+F)', totalG);

  // H. TOTAL CLOSING COSTS
  const totalH = scenarios.map((_, i) => totalD[i] + totalG[i]);
  addGrand('H. TOTAL CLOSING COSTS (D+G)', totalH);

  // I. LENDER CREDITS
  const lenderCreditVals = scenarios.map(s => s.lenderCredits > 0 ? -s.lenderCredits : 0);
  const pointsCredit = scenarios.map(s => s.points < 0 ? loanAmount * s.points / 100 : 0);

  addCat('I. LENDER CREDITS');
  addRow('Lender Credits', lenderCreditVals);
  addRow('Points Credit', pointsCredit);

  // J. ESTIMATED CASH TO CLOSE
  const downPayment = scenarios.map(() => purchasePrice * downPct / 100);
  const totalCreditsI = scenarios.map((_, i) => lenderCreditVals[i] + pointsCredit[i]);
  const estFundsNeeded = scenarios.map((_, i) => downPayment[i] + totalH[i] + totalCreditsI[i]);

  addCat('J. ESTIMATED CASH TO CLOSE');
  addRow('Down Payment', downPayment);
  addRow('Total Closing Costs', totalH);
  addRow('Less: Lender Credits', totalCreditsI);
  addGrand('Estimated Funds Needed', estFundsNeeded);

  // ── Draw table header row ──
  const rowH = 10;
  const catH = 11;
  const subRowH = 10;
  const grandRowH = 11;

  // Table column headers
  const hdrRowH = 14;
  rect(tableX, y - hdrRowH, descColW, hdrRowH, DARK);
  T('Fee Description', descX + 4, y - hdrRowH + 4, B, 7, WHITE);

  scenarios.forEach((s, i) => {
    const sx = tableX + descColW + scenColW * i;
    const bgColor = s.recommended ? GOLD_HDR : DARK;
    rect(sx, y - hdrRowH, scenColW, hdrRowH, bgColor);
    const hdrLabel = 'Option ' + s.id + (s.recommended ? ' *' : '');
    const subLabel = s.label + ' | ' + s.rate.toFixed(3) + '%';
    T(hdrLabel, sx + 4, y - hdrRowH + 7, B, 7, s.recommended ? GOLD : WHITE);
    T(subLabel, sx + 4, y - hdrRowH + 1, R, 5, s.recommended ? GOLD : LGRAY);
  });
  y -= hdrRowH;

  // ── Draw fee rows ──
  let altRow = false;
  for (const row of rows) {
    let rh: number;
    switch (row.type) {
      case 'category': rh = catH; break;
      case 'subtotal': rh = subRowH; break;
      case 'grandtotal': rh = grandRowH; break;
      default: rh = rowH;
    }

    if (row.type === 'category') {
      rect(tableX, y - rh, CW, rh, rgb(0.15, 0.15, 0.15));
      T(row.label, descX + 4, y - rh + 3, B, 7, WHITE);
      altRow = false;
    } else if (row.type === 'grandtotal') {
      rect(tableX, y - rh, descColW, rh, DARK);
      T(row.label, descX + 4, y - rh + 3, B, 7.5, WHITE);
      scenarios.forEach((s, i) => {
        const sx = tableX + descColW + scenColW * i;
        rect(sx, y - rh, scenColW, rh, s.recommended ? GOLD_HDR : DARK);
        const vt = fmtD(row.values[i]);
        T(vt, sx + scenColW - R.widthOfTextAtSize(vt, 7.5) - 4, y - rh + 3, B, 7.5, s.recommended ? GOLD : WHITE);
      });
      altRow = false;
    } else if (row.type === 'subtotal') {
      rect(tableX, y - rh, descColW, rh, BGRAY);
      T(row.label, descX + 4, y - rh + 3, B, 7, DARK);
      hLine(tableX, y, CW, LGRAY);
      scenarios.forEach((s, i) => {
        const sx = tableX + descColW + scenColW * i;
        rect(sx, y - rh, scenColW, rh, s.recommended ? GOLD_TINT : BGRAY);
        const vt = fmtD(row.values[i]);
        T(vt, sx + scenColW - B.widthOfTextAtSize(vt, 7) - 4, y - rh + 3, B, 7, DARK);
      });
      altRow = false;
    } else {
      // normal row
      const bgBase = altRow ? rgb(0.97, 0.97, 0.97) : WHITE;
      rect(tableX, y - rh, descColW, rh, bgBase);
      T(row.label, descX + 8, y - rh + 3, R, 6.5, DARK);
      scenarios.forEach((s, i) => {
        const sx = tableX + descColW + scenColW * i;
        const cellBg = s.recommended ? (altRow ? rgb(0.97, 0.96, 0.92) : GOLD_TINT) : bgBase;
        rect(sx, y - rh, scenColW, rh, cellBg);
        const vt = fmtD(row.values[i]);
        T(vt, sx + scenColW - R.widthOfTextAtSize(vt, 6.5) - 4, y - rh + 3, R, 6.5, DARK);
      });
      altRow = !altRow;
    }
    y -= rh;
  }

  // table bottom border
  hLine(tableX, y, CW, DARK);

  // ── 6. MONTHLY PAYMENT SECTION ─────────────────────────────────────────────
  y -= 6;
  const mpHdrH = 12;
  rect(tableX, y - mpHdrH, CW, mpHdrH, DARK);
  T('ESTIMATED MONTHLY PAYMENT', descX + 4, y - mpHdrH + 3, B, 7, GOLD);
  scenarios.forEach((s, i) => {
    const sx = tableX + descColW + scenColW * i;
    const lbl = 'Option ' + s.id;
    T(lbl, sx + 4, y - mpHdrH + 3, B, 7, s.recommended ? GOLD : WHITE);
  });
  y -= mpHdrH;

  const mpRows: { label: string; values: number[]; bold: boolean }[] = [];
  const piVals = scenarios.map(s => calcMonthlyPI(loanAmount, s.rate));
  const taxMo = scenarios.map(() => annualTax / 12);
  const insMo = scenarios.map(() => annualIns / 12);
  const miVals = scenarios.map(s => calcMI(loanProduct, ltv, loanAmount));
  const totalMo = scenarios.map((_, i) => piVals[i] + taxMo[i] + insMo[i] + miVals[i]);

  mpRows.push({ label: 'Principal & Interest', values: piVals, bold: false });
  mpRows.push({ label: 'Property Tax', values: taxMo, bold: false });
  mpRows.push({ label: 'Hazard Insurance', values: insMo, bold: false });
  mpRows.push({ label: 'Mortgage Insurance', values: miVals, bold: false });
  mpRows.push({ label: 'Total Monthly Payment', values: totalMo, bold: true });

  for (const mr of mpRows) {
    const mrH = mr.bold ? 11 : 10;
    if (mr.bold) {
      rect(tableX, y - mrH, descColW, mrH, DARK);
      T(mr.label, descX + 4, y - mrH + 3, B, 7, WHITE);
      scenarios.forEach((s, i) => {
        const sx = tableX + descColW + scenColW * i;
        rect(sx, y - mrH, scenColW, mrH, s.recommended ? GOLD_HDR : DARK);
        const vt = fmtD(mr.values[i]);
        T(vt, sx + scenColW - B.widthOfTextAtSize(vt, 7) - 4, y - mrH + 3, B, 7, s.recommended ? GOLD : WHITE);
      });
    } else {
      rect(tableX, y - mrH, descColW, mrH, WHITE);
      T(mr.label, descX + 8, y - mrH + 3, R, 6.5, DARK);
      scenarios.forEach((s, i) => {
        const sx = tableX + descColW + scenColW * i;
        const cellBg = s.recommended ? GOLD_TINT : WHITE;
        rect(sx, y - mrH, scenColW, mrH, cellBg);
        const vt = fmtD(mr.values[i]);
        T(vt, sx + scenColW - R.widthOfTextAtSize(vt, 6.5) - 4, y - mrH + 3, R, 6.5, DARK);
      });
    }
    y -= mrH;
  }
  hLine(tableX, y, CW, DARK);

  // ── 7. FOOTER ──────────────────────────────────────────────────────────────
  y -= 6;
  const disc =
    'This Loan Fee Estimate is provided for informational purposes only and does not constitute a commitment to lend or a Loan Estimate as defined under TRID/TILA-RESPA. ' +
    'All fees, rates, and costs shown are estimates based on current information and are subject to change. Final terms will be confirmed upon issuance of an official Loan Estimate ' +
    'after a completed loan application. Rates and fees may vary based on credit approval, market conditions, property appraisal, and full underwriting review. ' +
    'Prepared by Rene Duarte, NMLS #1795044, Rates & Realty Inc., NMLS #1416824, CA DRE #02075036. Equal Housing Lender.';

  // Word-wrap disclaimer
  const discSz = 5;
  const discMaxW = CW - 80; // leave room for QR
  const words = disc.split(' ');
  let line = '';
  const lines: string[] = [];
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (R.widthOfTextAtSize(test, discSz) > discMaxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);

  for (const l of lines) {
    T(l, M, y, R, discSz, GRAY);
    y -= 7;
  }

  // QR code
  try {
    const qrBytes = Uint8Array.from(atob(QR_CODE_B64), c => c.charCodeAt(0));
    const qrImg = await doc.embedPng(qrBytes);
    const qrSize = 60;
    const qrX = W - M - qrSize;
    const qrY = y + 7; // align near bottom of disclaimer
    page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });
    T('Scan to connect', qrX + (qrSize - R.widthOfTextAtSize('Scan to connect', 5)) / 2, qrY - 7, R, 5, GRAY);
  } catch (e) { console.log('[qr] embed error:', String(e).slice(0, 80)); }

  return doc.save();
}
