import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { PDFDocument, rgb, StandardFonts, PDFFont, PDFPage } from 'npm:pdf-lib@1.17.1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const d = await req.json();
    const pdfBytes = await build1003PDF(d);
    const base64 = btoa(String.fromCharCode(...pdfBytes));
    return new Response(JSON.stringify({ success: true, pdf: base64, type: 'application/pdf' }), {
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  } catch(e: any) {
    console.error('generate-1003 error:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
});

// ── helpers ──────────────────────────────────────────────────────────────────
// CRITICAL: sanitize removes newlines/tabs/control chars that crash WinAnsi encoding in pdf-lib
const sanitize = (x: any): string => {
  if (x == null || x === '') return '';
  return String(x)
    .replace(/[\r\n\t]/g, ' ')  // newlines/tabs → space
    .replace(/[\x00-\x1F\x7F]/g, '')  // strip other control chars
    .replace(/\s+/g, ' ')  // collapse multiple spaces
    .trim();
};

const v  = (x: any, fb = '') => sanitize(x) || sanitize(fb) || '';
const $$ = (x: any) => { const n = parseFloat(String(x||'').replace(/[$,]/g,'')); return isNaN(n)?'':('$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})); };
const pct = (x: any) => { const n = parseFloat(String(x||'')); return isNaN(n)?'':(n.toFixed(3)+'%'); };
const cb  = (on: boolean) => on ? '☑' : '☐';

interface Ctx {
  doc: PDFDocument;
  pages: PDFPage[];
  page: PDFPage;
  pageNum: number;
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  y: number;
  margin: number;
  pageW: number;
  pageH: number;
  contentW: number;
}

const LETTER_W = 612;
const LETTER_H = 792;
const MARGIN   = 36;
const CONTENT  = LETTER_W - MARGIN * 2;
const LINE_H   = 11;

function newCtx(doc: PDFDocument, regular: PDFFont, bold: PDFFont, italic: PDFFont): Ctx {
  const page = doc.addPage([LETTER_W, LETTER_H]);
  return { doc, pages: [page], page, pageNum: 0, regular, bold, italic,
    y: LETTER_H - MARGIN, margin: MARGIN, pageW: LETTER_W, pageH: LETTER_H, contentW: CONTENT };
}

function ensureSpace(ctx: Ctx, needed: number) {
  if (ctx.y - needed < MARGIN + 20) newPage(ctx);
}

function newPage(ctx: Ctx) {
  ctx.page = ctx.doc.addPage([LETTER_W, LETTER_H]);
  ctx.pages.push(ctx.page);
  ctx.pageNum++;
  ctx.y = LETTER_H - MARGIN;
}

function text(ctx: Ctx, t: string, x: number, y: number, opts: {font?:PDFFont,size?:number,color?:any,maxWidth?:number} = {}) {
  const font = opts.font || ctx.regular;
  const size = opts.size || 7;
  const color = opts.color || rgb(0,0,0);
  // Always sanitize before drawing - prevents WinAnsi encoding errors
  const safe = sanitize(t);
  if (!safe) return;
  if (opts.maxWidth) {
    const words = safe.split(' ');
    let line = '';
    let cy = y;
    for (const w of words) {
      const test = line ? line+' '+w : w;
      const tw = font.widthOfTextAtSize(test, size);
      if (tw > opts.maxWidth && line) {
        ctx.page.drawText(line, {x, y:cy, size, font, color});
        cy -= LINE_H;
        line = w;
      } else { line = test; }
    }
    if (line) ctx.page.drawText(line, {x, y:cy, size, font, color});
    return;
  }
  ctx.page.drawText(safe, {x, y, size, font, color});
}

function hline(ctx: Ctx, x: number, y: number, w: number, thickness = 0.5) {
  ctx.page.drawLine({start:{x,y},end:{x:x+w,y},thickness,color:rgb(0,0,0)});
}

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, opts: {fill?:any,stroke?:any,thickness?:number} = {}) {
  ctx.page.drawRectangle({x, y, width:w, height:h,
    color: opts.fill, borderColor: opts.stroke||rgb(0,0,0),
    borderWidth: opts.fill&&!opts.stroke ? 0 : (opts.thickness||0.5),
    opacity: 1
  });
}

function sectionBar(ctx: Ctx, label: string, barH = 11) {
  ensureSpace(ctx, barH + 4);
  rect(ctx, MARGIN, ctx.y - barH, CONTENT, barH, {fill: rgb(0,0,0), stroke: rgb(0,0,0)});
  text(ctx, label, MARGIN+4, ctx.y - barH + 3, {font: ctx.bold, size: 8, color: rgb(1,1,1)});
  ctx.y -= barH + 2;
}

function grayBar(ctx: Ctx, label: string, barH = 10) {
  rect(ctx, MARGIN, ctx.y - barH, CONTENT, barH, {fill: rgb(0.85,0.85,0.85), stroke: rgb(0,0,0)});
  text(ctx, label, MARGIN+4, ctx.y - barH + 2, {font: ctx.regular, size: 7});
  ctx.y -= barH + 2;
}

function blank(ctx: Ctx, x: number, y: number, w: number, value = '') {
  hline(ctx, x, y-1, w);
  if (value) text(ctx, value, x+1, y, {font:ctx.regular, size:7});
}

function checkbox(ctx: Ctx, x: number, y: number, checked: boolean, label: string, labelSize=7) {
  rect(ctx, x, y-6, 7, 7, {stroke:rgb(0,0,0), thickness:0.5});
  if (checked) {
    text(ctx, 'X', x+1, y-5, {font:ctx.bold, size:6});
  }
  text(ctx, label, x+9, y, {font:ctx.regular, size:labelSize});
}

function footer(ctx: Ctx, borrowerName: string, formRef: string) {
  const fy = MARGIN + 14;
  hline(ctx, MARGIN, fy+2, CONTENT);
  text(ctx, `Borrower Name: ${borrowerName}`, MARGIN, fy-4, {font:ctx.bold, size:6.5});
  text(ctx, `Uniform Residential Loan Application  Freddie Mac Form 65 - Fannie Mae Form 1003  ${formRef}`, MARGIN, fy-12, {font:ctx.regular, size:6});
}

async function build1003PDF(d: any): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold    = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic  = await doc.embedFont(StandardFonts.HelveticaOblique);

  const ctx = newCtx(doc, regular, bold, italic);

  const liabs: any[] = Array.isArray(d.liabilities_list) ? d.liabilities_list : [];
  const assets: any[] = Array.isArray(d.assets) ? d.assets : [];
  const reo: any[] = Array.isArray(d.reo_list) ? d.reo_list : [];
  const r0 = reo[0] || {};

  const bName = [v(d.first_name),v(d.middle_name),v(d.last_name),v(d.suffix)].filter(Boolean).join(' ');
  const coName = [v(d.co_borrower_first_name),v(d.co_borrower_last_name)].filter(Boolean).join(' ');
  const ssnMasked = d.ssn ? `***-**-${String(d.ssn).slice(-4)}` : '';
  const loanType = v(d.loan_type||d.mortgage_type,'Conventional');
  const occ = v(d.occupancy_type||d.occupancy,'PrimaryResidence');
  const isPrimary = occ==='PrimaryResidence'||occ==='Primary Residence';
  const isPurchase = v(d.loan_purpose,'Purchase')==='Purchase';

  const totalInc = [d.base_income,d.overtime_income,d.bonus_income,d.commission_income,d.military_income,d.other_income]
    .reduce((s,x)=>s+(parseFloat(String(x||0))||0),0);

  // PAGE 1
  grayBar(ctx, 'To be completed by the Lender:');
  text(ctx, 'Lender Loan No./Universal Loan Identifier', MARGIN, ctx.y, {font:regular, size:7});
  hline(ctx, MARGIN+175, ctx.y-1, 200);
  text(ctx, 'Agency Case No.', MARGIN+385, ctx.y, {font:regular, size:7});
  hline(ctx, MARGIN+445, ctx.y-1, 90);
  ctx.y -= LINE_H;

  text(ctx, 'Uniform Residential Loan Application', MARGIN, ctx.y, {font:bold, size:13});
  ctx.y -= 14;
  text(ctx, 'Verify and complete the information on this application. If you are applying for this loan with others, each additional Borrower must provide information as directed by your Lender.',
    MARGIN, ctx.y, {font:regular, size:7, maxWidth:CONTENT});
  ctx.y -= 18;

  text(ctx, 'Section 1: Borrower Information.', MARGIN, ctx.y, {font:bold, size:11});
  text(ctx, ' This section asks about your personal information and your income from employment and other sources,', MARGIN+154, ctx.y, {font:regular, size:8});
  ctx.y -= 9;
  text(ctx, 'such as retirement, that you want considered to qualify for this loan.', MARGIN, ctx.y, {font:regular, size:8});
  ctx.y -= 14;

  sectionBar(ctx, '1a. Personal Information');

  text(ctx, 'Name', MARGIN, ctx.y, {font:bold, size:8});
  text(ctx, '(First, Middle, Last, Suffix)', MARGIN+28, ctx.y, {font:italic, size:7});
  ctx.y -= LINE_H;
  text(ctx, bName || '(not provided)', MARGIN, ctx.y, {font:bold, size:9});
  ctx.y -= LINE_H;
  text(ctx, 'Alternate Names -', MARGIN, ctx.y, {font:bold, size:7});
  text(ctx, ' List any names by which you are known or any names under which credit was previously received (First, Middle, Last, Suffix)', MARGIN+70, ctx.y, {font:italic, size:6.5});
  ctx.y -= 14;

  const col2x = MARGIN + CONTENT/2 + 10;
  text(ctx, 'Social Security Number', MARGIN, ctx.y, {font:bold, size:8});
  blank(ctx, MARGIN+108, ctx.y, 90, ssnMasked);
  text(ctx, '(or Individual Taxpayer Identification Number)', MARGIN, ctx.y-9, {font:italic, size:6.5});

  text(ctx, 'Date of Birth', col2x, ctx.y, {font:bold, size:8});
  blank(ctx, col2x+65, ctx.y, 70, v(d.date_of_birth));
  text(ctx, '(mm/dd/yyyy)', col2x+65, ctx.y-9, {font:italic, size:6.5});
  ctx.y -= 22;

  text(ctx, 'Citizenship', col2x, ctx.y, {font:bold, size:8});
  ctx.y -= LINE_H;
  checkbox(ctx, col2x, ctx.y, d.citizenship==='USCitizen'||d.citizenship==='US Citizen', 'U.S. Citizen');
  ctx.y -= LINE_H;
  checkbox(ctx, col2x, ctx.y, d.citizenship==='PermanentResidentAlien', 'Permanent Resident Alien');
  ctx.y -= LINE_H;
  checkbox(ctx, col2x, ctx.y, d.citizenship==='NonPermanentResidentAlien', 'Non-Permanent Resident Alien');
  ctx.y -= 6;

  text(ctx, 'Type of Credit', MARGIN, ctx.y, {font:bold, size:8});
  text(ctx, 'List Name(s) of Other Borrower(s) Applying for this Loan', col2x, ctx.y, {font:bold, size:7});
  ctx.y -= LINE_H;
  checkbox(ctx, MARGIN, ctx.y, d.credit_type==='individual', 'I am applying for individual credit.');
  text(ctx, coName || '(First, Middle, Last, Suffix)', col2x, ctx.y, {font:regular, size:7});
  ctx.y -= LINE_H;
  checkbox(ctx, MARGIN, ctx.y, d.credit_type!=='individual', 'I am applying for joint credit.');
  text(ctx, 'Total Number of Borrowers:', MARGIN+125, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+230, ctx.y, 30, v(d.borrower_count));
  ctx.y -= 14;

  const c1w = 155; const c2w = 120; const c3x = MARGIN + c1w + c2w;
  text(ctx, 'Marital Status', MARGIN, ctx.y, {font:bold, size:8});
  text(ctx, 'Dependents', MARGIN+c1w, ctx.y, {font:bold, size:8});
  text(ctx, 'Contact Information', c3x, ctx.y, {font:bold, size:8});
  ctx.y -= LINE_H;

  checkbox(ctx, MARGIN, ctx.y, d.marital_status==='Married', 'Married');
  text(ctx, '(not listed by another Borrower)', MARGIN+c1w, ctx.y, {font:italic, size:6.5});
  text(ctx, 'Home Phone', c3x, ctx.y, {font:bold, size:7});
  blank(ctx, c3x+55, ctx.y, 80, v(d.home_phone));
  ctx.y -= LINE_H;

  checkbox(ctx, MARGIN, ctx.y, d.marital_status==='Separated', 'Separated');
  text(ctx, 'Number', MARGIN+c1w, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+c1w+38, ctx.y, 30, v(d.dependents_count));
  text(ctx, 'Cell Phone', c3x, ctx.y, {font:bold, size:7});
  blank(ctx, c3x+50, ctx.y, 80, v(d.cell_phone));
  ctx.y -= LINE_H;

  checkbox(ctx, MARGIN, ctx.y, !d.marital_status||d.marital_status==='Unmarried'||d.marital_status==='Single', 'Unmarried');
  text(ctx, 'Ages', MARGIN+c1w, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+c1w+24, ctx.y, 80);
  text(ctx, 'Work Phone', c3x, ctx.y, {font:bold, size:7});
  blank(ctx, c3x+52, ctx.y, 65, v(d.work_phone));
  text(ctx, 'Ext.', c3x+120, ctx.y, {font:regular, size:7});
  blank(ctx, c3x+135, ctx.y, 30);
  ctx.y -= LINE_H;

  text(ctx, 'Email', c3x, ctx.y, {font:bold, size:7});
  blank(ctx, c3x+28, ctx.y, 110, v(d.email));
  ctx.y -= 14;

  text(ctx, 'Current Address', MARGIN, ctx.y, {font:bold, size:8});
  ctx.y -= LINE_H;
  text(ctx, 'Street', MARGIN, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+30, ctx.y, 280, v(d.current_address_street));
  text(ctx, 'Unit #', MARGIN+316, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+345, ctx.y, 55, v(d.current_address_unit));
  ctx.y -= LINE_H;

  text(ctx, 'City', MARGIN, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+18, ctx.y, 120, v(d.current_address_city));
  text(ctx, 'State', MARGIN+143, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+168, ctx.y, 30, v(d.current_address_state));
  text(ctx, 'ZIP', MARGIN+202, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+218, ctx.y, 55, v(d.current_address_zip));
  text(ctx, 'Country', MARGIN+278, ctx.y, {font:regular, size:7});
  blank(ctx, MARGIN+310, ctx.y, 90, v(d.current_address_country,'US'));
  ctx.y -= LINE_H;

  text(ctx, 'How Long at Current Address?', MARGIN, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+140, ctx.y, 20, v(d.current_address_years,''));
  text(ctx, 'Years', MARGIN+164, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+190, ctx.y, 20, v(d.current_address_months,''));
  text(ctx, 'Months', MARGIN+214, ctx.y, {font:bold, size:7});
  const houst = MARGIN+260;
  text(ctx, 'Housing', houst, ctx.y, {font:bold, size:7});
  checkbox(ctx, houst+38, ctx.y, d.current_housing_type==='Own', 'Own');
  checkbox(ctx, houst+60, ctx.y, d.current_housing_type==='Rent', 'Rent');
  if (d.rent_amount) text(ctx, `($${v(d.rent_amount)}/mo)`, houst+90, ctx.y, {font:regular, size:7});
  ctx.y -= 12;

  text(ctx, 'If at Current Address for LESS than 2 years, list Former Address', MARGIN, ctx.y, {font:bold, size:7});
  text(ctx, 'Does not apply', MARGIN+280, ctx.y, {font:italic, size:7});
  ctx.y -= LINE_H;
  text(ctx, 'Mailing Address - if different from Current Address', MARGIN, ctx.y, {font:bold, size:7});
  text(ctx, 'Does not apply', MARGIN+230, ctx.y, {font:italic, size:7});
  ctx.y -= 14;

  sectionBar(ctx, '1b. Current Employment/Self-Employment and Income');
  text(ctx, 'Does not apply', MARGIN + CONTENT - 75, ctx.y+2, {font:italic, size:7});

  const ew = CONTENT;
  const elw = Math.round(ew * 0.73);
  const erw = ew - elw;
  const ety = ctx.y;
  const ex = MARGIN;
  const erx = ex + elw;

  const r1h = 18;
  rect(ctx, ex, ety-r1h, elw, r1h, {stroke:rgb(0,0,0)});
  rect(ctx, erx, ety-r1h, erw, r1h, {stroke:rgb(0,0,0)});
  text(ctx, 'Employer or Business Name', ex+2, ety-5, {font:bold, size:8});
  blank(ctx, ex+130, ety-5, 100, v(d.employer_name));
  text(ctx, 'Phone', ex+235, ety-5, {font:bold, size:7});
  blank(ctx, ex+260, ety-5, elw-265, v(d.employer_phone));
  text(ctx, 'Gross Monthly Income', erx+3, ety-5, {font:bold, size:7});
  text(ctx, 'Base  $', erx+3, ety-14, {font:regular, size:7});
  blank(ctx, erx+32, ety-14, 45, $$(d.base_income));
  text(ctx, '/month', erx+80, ety-14, {font:regular, size:7});

  const r2y = ety - r1h; const r2h = 14;
  rect(ctx, ex, r2y-r2h, elw, r2h, {stroke:rgb(0,0,0)});
  rect(ctx, erx, r2y-r2h, erw, r2h, {stroke:rgb(0,0,0)});
  text(ctx, 'Street', ex+2, r2y-5, {font:bold, size:7});
  blank(ctx, ex+28, r2y-5, elw-50, v(d.employer_street));
  text(ctx, 'Overtime $', erx+3, r2y-5, {font:regular, size:7});
  blank(ctx, erx+48, r2y-5, 45, $$(d.overtime_income));
  text(ctx, '/month', erx+96, r2y-5, {font:regular, size:7});

  const r3y = r2y - r2h; const r3h = 14;
  rect(ctx, ex, r3y-r3h, elw, r3h, {stroke:rgb(0,0,0)});
  rect(ctx, erx, r3y-r3h, erw, r3h, {stroke:rgb(0,0,0)});
  text(ctx, 'City', ex+2, r3y-5, {font:bold, size:7});
  blank(ctx, ex+18, r3y-5, 80, v(d.employer_city));
  text(ctx, 'State', ex+102, r3y-5, {font:bold, size:7});
  blank(ctx, ex+126, r3y-5, 25, v(d.employer_state));
  text(ctx, 'ZIP', ex+154, r3y-5, {font:bold, size:7});
  blank(ctx, ex+170, r3y-5, 45, v(d.employer_zip));
  text(ctx, 'Bonus $', erx+3, r3y-5, {font:regular, size:7});
  blank(ctx, erx+40, r3y-5, 45, $$(d.bonus_income));
  text(ctx, '/month', erx+88, r3y-5, {font:regular, size:7});

  const r4y = r3y - r3h; const r4h = 14;
  const emidx = ex + Math.round(elw*0.6);
  rect(ctx, ex, r4y-r4h, emidx-ex, r4h, {stroke:rgb(0,0,0)});
  rect(ctx, emidx, r4y-r4h, erx-emidx, r4h, {stroke:rgb(0,0,0)});
  rect(ctx, erx, r4y-r4h*3, erw, r4h*3, {stroke:rgb(0,0,0)});
  text(ctx, 'Position or Title', ex+2, r4y-5, {font:bold, size:7});
  blank(ctx, ex+80, r4y-5, emidx-ex-85, v(d.position_title));
  text(ctx, 'Commission $', erx+3, r4y-5, {font:regular, size:7});
  blank(ctx, erx+60, r4y-5, 40, $$(d.commission_income));
  text(ctx, '/month', erx+103, r4y-5, {font:regular, size:7});
  text(ctx, 'Check if this statement applies:', emidx+2, r4y-5, {font:bold, size:6.5});
  text(ctx, 'I am employed by a family member, property seller,', emidx+2, r4y-13, {font:regular, size:6, maxWidth:erx-emidx-4});
  text(ctx, 'real estate agent, or other party to the transaction.', emidx+2, r4y-20, {font:regular, size:6, maxWidth:erx-emidx-4});

  const r5y = r4y - r4h; const r5h = 11;
  rect(ctx, ex, r5y-r5h, emidx-ex, r5h, {stroke:rgb(0,0,0)});
  text(ctx, 'Start Date', ex+2, r5y-4, {font:bold, size:7});
  blank(ctx, ex+50, r5y-4, 60, v(d.employment_start_date));
  text(ctx, '(mm/dd/yyyy)', ex+115, r5y-4, {font:italic, size:6.5});
  text(ctx, 'Military Entitlements $', erx+3, r5y-4, {font:regular, size:7});
  blank(ctx, erx+95, r5y-4, 36, $$(d.military_income));
  text(ctx, '/mo', erx+134, r5y-4, {font:regular, size:7});

  const r6y = r5y - r5h; const r6h = 14;
  rect(ctx, ex, r6y-r6h, emidx-ex, r6h, {stroke:rgb(0,0,0)});
  text(ctx, 'How long in this line of work?', ex+2, r6y-5, {font:bold, size:7});
  blank(ctx, ex+145, r6y-5, 18, v(d.years_in_field,''));
  text(ctx, 'Yrs', ex+166, r6y-5, {font:regular, size:7});
  blank(ctx, ex+184, r6y-5, 18, v(d.months_in_field,''));
  text(ctx, 'Mo', ex+205, r6y-5, {font:regular, size:7});
  text(ctx, 'Other $', erx+3, r6y-5, {font:regular, size:7});
  blank(ctx, erx+38, r6y-5, 50, $$(d.other_income));
  text(ctx, '/month', erx+91, r6y-5, {font:regular, size:7});

  const r7y = r6y - r6h; const r7h = 14;
  rect(ctx, ex, r7y-r7h, elw, r7h, {stroke:rgb(0,0,0)});
  rect(ctx, erx, r7y-r7h, erw, r7h, {stroke:rgb(0,0,0)});
  checkbox(ctx, ex+2, r7y-4, !!d.is_self_employed, 'Check if you are the Business Owner or Self-Employed');
  text(ctx, 'TOTAL', erx+3, r7y-4, {font:bold, size:8});
  text(ctx, `${$$(totalInc||d.total_monthly_income)||'_________'} / month`, erx+35, r7y-4, {font:bold, size:7});

  ctx.y = r7y - r7h - 6;

  sectionBar(ctx, '1c. IF APPLICABLE, Complete Information for Additional Employment/Self Employment and Income');
  text(ctx, 'Does not apply', MARGIN, ctx.y, {font:italic, size:7}); ctx.y -= 10;
  sectionBar(ctx, '1d. IF APPLICABLE, Complete Information for Previous Employment/Self Employment and Income');
  text(ctx, 'Does not apply', MARGIN, ctx.y, {font:italic, size:7}); ctx.y -= 10;
  sectionBar(ctx, '1e. Income from Other Sources');
  text(ctx, 'Does not apply', MARGIN, ctx.y, {font:italic, size:7}); ctx.y -= 14;

  footer(ctx, bName, 'Calyx Form - URLA_1.frm (12/2020). Effective 1/2021');

  // PAGE 2: ASSETS & LIABILITIES
  newPage(ctx);

  text(ctx, 'Section 2 : Financial Information - Assets and Liabilities.', MARGIN, ctx.y, {font:bold, size:11});
  ctx.y -= 9;
  text(ctx, 'This section asks about things you own that are worth money and that you want considered to qualify for this loan. It then asks about your liabilities (or debts) that you pay each month.',
    MARGIN, ctx.y, {font:regular, size:7, maxWidth:CONTENT});
  ctx.y -= 14;

  sectionBar(ctx, '2a. Assets - Bank Accounts, Retirement, and Other Accounts You Have');

  const aw = CONTENT;
  const acols = [150, 145, 145, 100];
  const ax = MARGIN;
  let arowY = ctx.y;
  const ahdrs = ['Account Type - use list above','Financial Institution','Account Number','Cash or Market Value'];
  let acx = ax;
  for (let i=0;i<4;i++) {
    rect(ctx, acx, arowY-13, acols[i], 13, {stroke:rgb(0,0,0)});
    text(ctx, ahdrs[i], acx+2, arowY-10, {font:bold, size:7});
    acx += acols[i];
  }
  arowY -= 13;

  const showAssets = assets.length ? assets : [{type:'',institution:'',account:'',value:''}];
  for (let i=0;i<Math.max(5,showAssets.length);i++) {
    const a = showAssets[i]||{};
    acx = ax;
    ensureSpace(ctx, 14);
    const vals = [v(a.type||a.asset_type), v(a.institution||a.institution_name), v(a.account||a.account_number), $$(a.value||a.current_value)||'$'];
    for (let j=0;j<4;j++) {
      rect(ctx, acx, arowY-12, acols[j], 12, {stroke:rgb(0,0,0)});
      text(ctx, vals[j], acx+2, arowY-9, {font:regular, size:7});
      acx += acols[j];
    }
    arowY -= 12;
  }
  acx = ax;
  rect(ctx, acx, arowY-12, acols[0]+acols[1]+acols[2], 12, {stroke:rgb(0,0,0)});
  text(ctx, 'Provide TOTAL Amount Here', acx+200, arowY-9, {font:bold, size:7});
  rect(ctx, acx+acols[0]+acols[1]+acols[2], arowY-12, acols[3], 12, {stroke:rgb(0,0,0)});
  const totalAssets = assets.reduce((s,a)=>s+(parseFloat(String(a.value||a.current_value||0))||0),0);
  text(ctx, totalAssets ? $$(totalAssets) : '$', acx+acols[0]+acols[1]+acols[2]+2, arowY-9, {font:bold, size:7});
  ctx.y = arowY - 12 - 6;

  sectionBar(ctx, '2b. Other Assets and Credits You Have');
  text(ctx, 'Does not apply', MARGIN, ctx.y, {font:italic, size:7}); ctx.y -= 12;

  sectionBar(ctx, '2c. Liabilities - Credit Cards, Other Debts, and Leases that You Owe');
  text(ctx, 'Account Types: Revolving (credit cards) / Installment (car, student, personal loans) / Open 30-Day (balance paid monthly) / Lease (not real estate) / Other',
    MARGIN, ctx.y, {font:regular, size:6.5, maxWidth:CONTENT});
  ctx.y -= 10;

  const lcols = [85, 124, 97, 138, 96];
  const lhdrs = ['Account Type','Company Name','Account Number','Unpaid Balance (To be paid off at or before closing)','Monthly Payment'];
  let lrowY = ctx.y;
  let lcx = MARGIN;
  for (let i=0;i<5;i++) {
    rect(ctx, lcx, lrowY-16, lcols[i], 16, {stroke:rgb(0,0,0)});
    text(ctx, lhdrs[i], lcx+2, lrowY-9, {font:bold, size:6.5, maxWidth:lcols[i]-4});
    lcx += lcols[i];
  }
  lrowY -= 16;

  for (let i=0;i<Math.max(8,liabs.length);i++) {
    const l = liabs[i]||{};
    ensureSpace(ctx, 13);
    lcx = MARGIN;
    const lvals = [
      v(l.liability_type||l.type),
      v(l.creditor_name||l.holder),
      v(l.account_number||l.account),
      ($$(l.balance)||'$') + (l.is_payoff ? ' [payoff]' : ''),
      $$(l.monthly_payment||l.payment)||'$'
    ];
    for (let j=0;j<5;j++) {
      rect(ctx, lcx, lrowY-12, lcols[j], 12, {stroke:rgb(0,0,0)});
      text(ctx, lvals[j], lcx+2, lrowY-9, {font:regular, size:7, maxWidth:lcols[j]-4});
      lcx += lcols[j];
    }
    lrowY -= 12;
  }
  ctx.y = lrowY - 6;

  sectionBar(ctx, '2d. Other Liabilities and Expenses');
  text(ctx, 'Does not apply', MARGIN, ctx.y, {font:italic, size:7}); ctx.y -= 12;

  footer(ctx, bName, 'Calyx Form - URLA_3.frm (12/2020). Effective 1/2021');

  // PAGE 3: REAL ESTATE
  newPage(ctx);

  text(ctx, 'Section 3 : Financial Information - Real Estate.', MARGIN, ctx.y, {font:bold, size:11});
  text(ctx, ' This section asks you to list all properties you currently own and what you owe on them.', MARGIN+215, ctx.y, {font:regular, size:7});
  ctx.y -= 14;

  sectionBar(ctx, '3a. Property You Own   (If you are refinancing, list the property you are refinancing FIRST.)');

  if (r0.property_address || d.current_address_street) {
    text(ctx, 'Address  Street', MARGIN, ctx.y, {font:bold, size:7});
    blank(ctx, MARGIN+70, ctx.y, 280, v(r0.property_address||r0.address));
    text(ctx, 'Unit #', MARGIN+354, ctx.y, {font:bold, size:7});
    blank(ctx, MARGIN+385, ctx.y, 55, v(r0.unit));
    ctx.y -= LINE_H;
    text(ctx, 'City', MARGIN, ctx.y, {font:bold, size:7});
    blank(ctx, MARGIN+18, ctx.y, 100, v(r0.city));
    text(ctx, 'State', MARGIN+122, ctx.y, {font:bold, size:7});
    blank(ctx, MARGIN+148, ctx.y, 25, v(r0.state));
    text(ctx, 'ZIP', MARGIN+177, ctx.y, {font:bold, size:7});
    blank(ctx, MARGIN+193, ctx.y, 50, v(r0.zip));
    text(ctx, 'Country', MARGIN+247, ctx.y, {font:regular, size:7});
    blank(ctx, MARGIN+278, ctx.y, 60, 'US');
    ctx.y -= 12;
  }

  // REO table - NO newlines in headers
  const reoCols = [65,62,92,104,88,129];
  const reoHdrs = [
    'Property Value',
    'Status (Sold/Pending/Retained)',
    'Intended Occupancy',
    'Monthly Ins, Taxes, Assoc Dues',
    'Monthly Rental Income',
    'For LENDER: Net Monthly Rental'
  ];
  let rrY = ctx.y;
  let rcx = MARGIN;
  for (let i=0;i<6;i++) {
    rect(ctx, rcx, rrY-22, reoCols[i], 22, {stroke:rgb(0,0,0)});
    text(ctx, reoHdrs[i], rcx+2, rrY-8, {font:bold, size:6, maxWidth:reoCols[i]-4});
    rcx += reoCols[i];
  }
  rrY -= 22;
  rcx = MARGIN;
  const reoVals = [
    $$(r0.market_value)||'$',
    v(r0.disposition,'Retained'),
    v(r0.current_usage||r0.occupancy,'Primary Residence'),
    $$(r0.taxes||r0.insurance)||'$',
    $$(r0.gross_rental_income)||'$',
    '$'
  ];
  for (let i=0;i<6;i++) {
    rect(ctx, rcx, rrY-14, reoCols[i], 14, {stroke:rgb(0,0,0)});
    text(ctx, reoVals[i], rcx+2, rrY-10, {font:regular, size:7});
    rcx += reoCols[i];
  }
  rrY -= 14;
  ctx.y = rrY - 4;

  text(ctx, 'Mortgage Loans on this Property', MARGIN, ctx.y, {font:bold, size:7});
  text(ctx, 'Does not apply', MARGIN+145, ctx.y, {font:italic, size:7});
  ctx.y -= 10;

  const mlCols = [90,101,65,151,70,63];
  const mlHdrs = [
    'Creditor Name',
    'Account Number',
    'Monthly Mortgage Payment',
    'Unpaid Balance (To be paid off at or before closing)',
    'Type: FHA, VA, Conv, USDA, Other',
    'Credit Limit (if applicable)'
  ];
  let mlY = ctx.y;
  let mlcx = MARGIN;
  for (let i=0;i<6;i++) {
    rect(ctx, mlcx, mlY-22, mlCols[i], 22, {stroke:rgb(0,0,0)});
    text(ctx, mlHdrs[i], mlcx+2, mlY-10, {font:bold, size:6, maxWidth:mlCols[i]-4});
    mlcx += mlCols[i];
  }
  mlY -= 22;
  for (let i=0;i<2;i++) {
    mlcx = MARGIN;
    for (let j=0;j<6;j++) {
      rect(ctx, mlcx, mlY-14, mlCols[j], 14, {stroke:rgb(0,0,0)});
      text(ctx, i===0&&j===0?v(r0.creditor_name):
           i===0&&j===1?v(r0.loan_number):
           i===0&&j===2?$$(r0.monthly_payment)||'$':
           i===0&&j===3?$$(r0.lien_balance)||'$':
           i===0&&j===4?v(r0.loan_type,'Conventional'):
           '$', mlcx+2, mlY-10, {font:regular, size:7});
      mlcx += mlCols[j];
    }
    mlY -= 14;
  }
  ctx.y = mlY - 6;

  sectionBar(ctx, '3b. IF APPLICABLE, Complete Information for Additional Property');
  text(ctx, 'Does not apply', MARGIN, ctx.y, {font:italic, size:7}); ctx.y -= 10;
  sectionBar(ctx, '3c. IF APPLICABLE, Complete Information for Additional Property');
  text(ctx, 'Does not apply', MARGIN, ctx.y, {font:italic, size:7}); ctx.y -= 12;

  footer(ctx, bName, 'Calyx Form - URLA_4.frm (04/2020). Effective 1/2021');

  // PAGE 4: LOAN INFO
  newPage(ctx);

  text(ctx, 'Section 4: Loan and Property Information.', MARGIN, ctx.y, {font:bold, size:11});
  text(ctx, ' This section asks about the loan purpose and the property you want to purchase or refinance.', MARGIN+195, ctx.y, {font:regular, size:7});
  ctx.y -= 14;

  sectionBar(ctx, '4a. Loan and Property Information');

  text(ctx, 'Loan Amount $', MARGIN, ctx.y, {font:bold, size:8});
  text(ctx, $$(d.loan_amount||d.requested_loan_amount)||'___________', MARGIN+66, ctx.y, {font:bold, size:8});
  text(ctx, 'Loan Purpose', MARGIN+180, ctx.y, {font:bold, size:8});
  checkbox(ctx, MARGIN+240, ctx.y, isPurchase, 'Purchase');
  checkbox(ctx, MARGIN+285, ctx.y, !isPurchase&&d.loan_purpose==='Refinance', 'Refinance');
  text(ctx, 'Other (specify)', MARGIN+340, ctx.y, {font:regular, size:7});
  blank(ctx, MARGIN+405, ctx.y, 90);
  ctx.y -= 12;

  text(ctx, 'Property Address', MARGIN, ctx.y, {font:bold, size:8});
  text(ctx, 'Street', MARGIN+80, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+108, ctx.y, 180, v(d.property_address_street));
  text(ctx, 'City', MARGIN+292, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+312, ctx.y, 100, v(d.property_address_city));
  ctx.y -= LINE_H;
  text(ctx, 'State', MARGIN, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+26, ctx.y, 28, v(d.property_address_state));
  text(ctx, 'ZIP', MARGIN+58, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+74, ctx.y, 55, v(d.property_address_zip));
  text(ctx, 'County', MARGIN+133, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+163, ctx.y, 80, v(d.property_address_county));
  text(ctx, 'Units', MARGIN+247, ctx.y, {font:bold, size:7});
  blank(ctx, MARGIN+272, ctx.y, 25, v(d.number_of_units||d.num_units,'1'));
  text(ctx, 'Property Value $', MARGIN+301, ctx.y, {font:bold, size:7});
  text(ctx, $$(d.property_value||d.estimated_value)||'___________', MARGIN+375, ctx.y, {font:bold, size:8});
  ctx.y -= 12;

  text(ctx, 'Occupancy', MARGIN, ctx.y, {font:bold, size:8});
  checkbox(ctx, MARGIN+55, ctx.y, isPrimary, 'Primary Residence');
  checkbox(ctx, MARGIN+140, ctx.y, occ==='SecondHome'||occ==='Second Home', 'Second Home');
  checkbox(ctx, MARGIN+205, ctx.y, occ==='Investment'||occ==='Investment Property', 'Investment Property');
  checkbox(ctx, MARGIN+290, ctx.y, false, 'FHA Secondary Residence');
  ctx.y -= 12;

  text(ctx, 'NO  YES', MARGIN, ctx.y, {font:regular, size:7});
  text(ctx, '1. Mixed-Use Property. If you will occupy the property, will you set aside space within the property to operate your own business?', MARGIN+38, ctx.y, {font:regular, size:7, maxWidth:CONTENT-38});
  ctx.y -= LINE_H;
  text(ctx, 'NO  YES', MARGIN, ctx.y, {font:regular, size:7});
  text(ctx, '2. Manufactured Home. Is the property a manufactured home? (e.g., a factory built dwelling built on a permanent chassis)', MARGIN+38, ctx.y, {font:regular, size:7, maxWidth:CONTENT-38});
  ctx.y -= 14;

  sectionBar(ctx, '4b. Other New Mortgage Loans on the Property You are Buying or Refinancing');
  text(ctx, 'Does not apply', MARGIN, ctx.y, {font:italic, size:7}); ctx.y -= 10;
  sectionBar(ctx, '4c. Rental Income on the Property You Want to Purchase');
  text(ctx, 'Does not apply', MARGIN, ctx.y, {font:italic, size:7}); ctx.y -= 10;
  sectionBar(ctx, '4d. Gifts or Grants You Have Been Given or Will Receive for this Loan');
  text(ctx, 'Does not apply', MARGIN, ctx.y, {font:italic, size:7}); ctx.y -= 12;

  footer(ctx, bName, 'Calyx Form - URLA_5.frm (04/2020). Effective 1/2021');

  // PAGE 5: DECLARATIONS
  newPage(ctx);

  text(ctx, 'Section 5: Declarations.', MARGIN, ctx.y, {font:bold, size:11});
  text(ctx, ' This section asks about specific questions about the property, your funding, and your past financial history.', MARGIN+115, ctx.y, {font:regular, size:7});
  ctx.y -= 14;

  const declW = CONTENT - 60;
  const declYNx = MARGIN + declW + 4;

  rect(ctx, MARGIN, ctx.y-11, CONTENT, 11, {fill:rgb(0,0,0)});
  text(ctx, '5a. About this Property and Your Money for this Loan', MARGIN+4, ctx.y-8, {font:bold, size:8, color:rgb(1,1,1)});
  ctx.y -= 11;

  const decls5a: [string,string,any][] = [
    ['A.','Will you occupy the property as your primary residence?', d.decl_primary_residence],
    ['B.','If this is a Purchase Transaction: Do you have a family relationship or business affiliation with the seller of the property?', null],
    ['C.','Are you borrowing any money for this real estate transaction (e.g., money for your closing costs or down payment) or obtaining any money from another party that you have not disclosed on this loan application?', d.decl_borrowed_funds],
    ['D.1','Have you or will you be applying for a mortgage loan on another property on or before closing this transaction that is not disclosed on this loan application?', d.decl_applying_other_mortgage],
    ['D.2','Have you or will you be applying for any new credit (e.g., installment loan, credit card) on or before closing this loan that is not disclosed on this application?', d.decl_new_credit],
    ['E.','Will this property be subject to a lien that could take priority over the first mortgage lien, such as a clean energy lien paid through your property taxes?', null],
  ];
  for (const [ltr,q,val] of decls5a) {
    ensureSpace(ctx, 20);
    const dh = q.length > 100 ? 22 : 14;
    rect(ctx, MARGIN, ctx.y-dh, declW, dh, {stroke:rgb(0,0,0)});
    rect(ctx, MARGIN+declW, ctx.y-dh, 60, dh, {stroke:rgb(0,0,0)});
    text(ctx, `${ltr}  ${q}`, MARGIN+2, ctx.y-6, {font:regular, size:7, maxWidth:declW-4});
    const yv = val===true||val==='true'||val==='Yes';
    const nv = val===false||val==='false'||val==='No';
    text(ctx, `${nv?'[X]':'[ ]'} NO   ${yv?'[X]':'[ ]'} YES`, declYNx, ctx.y-6, {font:regular, size:7});
    ctx.y -= dh;
  }

  ctx.y -= 4;
  rect(ctx, MARGIN, ctx.y-11, CONTENT, 11, {fill:rgb(0,0,0)});
  text(ctx, '5b. About Your Finances', MARGIN+4, ctx.y-8, {font:bold, size:8, color:rgb(1,1,1)});
  ctx.y -= 11;

  const decls5b: [string,string,any][] = [
    ['F.','Are you a co-signer or guarantor on any debt or loan that is not disclosed on this application?', d.decl_cosigner],
    ['G.','Are there any outstanding judgments against you?', d.decl_outstanding_judgments],
    ['H.','Are you currently delinquent or in default on a federal debt?', d.decl_delinquent_federal],
    ['I.','Are you a party to a lawsuit in which you potentially have any personal financial liability?', d.decl_lawsuit],
    ['J.','Have you conveyed title to any property in lieu of foreclosure in the past 7 years?', d.decl_deed_in_lieu],
    ['K.','Within the past 7 years, have you completed a pre-foreclosure sale or short sale, whereby the property was sold to a third party and the Lender agreed to accept less than the outstanding mortgage balance due?', d.decl_short_sale],
    ['L.','Have you had property foreclosed upon in the last 7 years?', d.decl_foreclosure],
    ['M.','Have you declared bankruptcy within the past 7 years?', d.decl_bankruptcy],
  ];
  for (const [ltr,q,val] of decls5b) {
    ensureSpace(ctx, 16);
    const dh = q.length > 120 ? 22 : 14;
    rect(ctx, MARGIN, ctx.y-dh, declW, dh, {stroke:rgb(0,0,0)});
    rect(ctx, MARGIN+declW, ctx.y-dh, 60, dh, {stroke:rgb(0,0,0)});
    text(ctx, `${ltr}  ${q}`, MARGIN+2, ctx.y-6, {font:regular, size:7, maxWidth:declW-4});
    const yv = val===true||val==='true'||val==='Yes';
    const nv = val===false||val==='false'||val==='No';
    text(ctx, `${nv?'[X]':'[ ]'} NO   ${yv?'[X]':'[ ]'} YES`, declYNx, ctx.y-6, {font:regular, size:7});
    if (ltr==='M.') {
      ctx.y -= dh;
      text(ctx, 'If YES, identify the type(s) of bankruptcy:', MARGIN+8, ctx.y, {font:regular, size:7});
      text(ctx, '[ ] Chapter 7   [ ] Chapter 11   [ ] Chapter 12   [ ] Chapter 13', MARGIN+185, ctx.y, {font:regular, size:7});
    }
    ctx.y -= dh;
  }
  ctx.y -= 8;

  text(ctx, 'Section 6: Acknowledgements and Agreements.', MARGIN, ctx.y, {font:bold, size:10});
  ctx.y -= 10;
  sectionBar(ctx, 'Acknowledgements and Agreements');

  const ackText = 'By signing below, in addition to the representations and agreements made above, I expressly authorize the Lender and Other Loan Participants to obtain, use, and share with each other (i) the loan application and related loan information and documentation, (ii) a consumer report on me, and (iii) my tax return information, as necessary to process and underwrite my loan.';
  text(ctx, ackText, MARGIN, ctx.y, {font:regular, size:6.5, maxWidth:CONTENT});
  ctx.y -= 28;

  text(ctx, 'Borrower Signature', MARGIN, ctx.y, {font:bold, size:8});
  hline(ctx, MARGIN+90, ctx.y-1, 260);
  text(ctx, 'Date (mm/dd/yyyy)', MARGIN+360, ctx.y, {font:regular, size:7});
  hline(ctx, MARGIN+438, ctx.y-1, 100);
  ctx.y -= 14;
  text(ctx, 'Borrower Signature', MARGIN, ctx.y, {font:bold, size:8});
  hline(ctx, MARGIN+90, ctx.y-1, 260);
  text(ctx, 'Date (mm/dd/yyyy)', MARGIN+360, ctx.y, {font:regular, size:7});
  hline(ctx, MARGIN+438, ctx.y-1, 100);
  ctx.y -= 14;

  footer(ctx, bName, 'Calyx Form - URLA_6.frm (04/2020). Effective 1/2021');

  // PAGE 6: SECTIONS 7-8
  newPage(ctx);

  text(ctx, 'Section 7: Military Service.', MARGIN, ctx.y, {font:bold, size:11});
  text(ctx, ' This section asks questions about your (or your deceased spouses) military service.', MARGIN+135, ctx.y, {font:regular, size:7});
  ctx.y -= 12;
  sectionBar(ctx, 'Military Service of Borrower');

  text(ctx, 'Military Service - Did you (or your deceased spouse) ever serve, or are you currently serving, in the United States Armed Forces?', MARGIN, ctx.y, {font:regular, size:7, maxWidth:CONTENT-80});
  text(ctx, '[ ] NO   [ ] YES', MARGIN+CONTENT-60, ctx.y, {font:regular, size:7});
  ctx.y -= LINE_H;
  text(ctx, 'If YES, check all that apply:', MARGIN+20, ctx.y, {font:italic, size:7});
  ctx.y -= LINE_H;
  checkbox(ctx, MARGIN+20, ctx.y, false, 'Currently serving on active duty with projected expiration date of service/tour');
  ctx.y -= LINE_H;
  checkbox(ctx, MARGIN+20, ctx.y, false, 'Currently retired, discharged, or separated from service');
  ctx.y -= LINE_H;
  checkbox(ctx, MARGIN+20, ctx.y, false, 'Only period of service was as a non-activated member of the Reserve or National Guard');
  ctx.y -= LINE_H;
  checkbox(ctx, MARGIN+20, ctx.y, false, 'Surviving spouse');
  ctx.y -= 14;

  text(ctx, 'Section 8: Demographic Information.', MARGIN, ctx.y, {font:bold, size:11});
  text(ctx, ' This section asks about your ethnicity, sex, and race.', MARGIN+168, ctx.y, {font:regular, size:7});
  ctx.y -= 12;
  sectionBar(ctx, 'Demographic Information of Borrower');

  text(ctx, 'The purpose of collecting this information is to help ensure that all applicants are treated fairly and that the housing needs of communities and neighborhoods are being fulfilled. Federal law requires that we ask applicants for their demographic information (ethnicity, sex, and race) in order to monitor our compliance with equal credit opportunity, fair housing, and home mortgage disclosure laws.',
    MARGIN, ctx.y, {font:regular, size:6.5, maxWidth:CONTENT});
  ctx.y -= 20;

  const demL = MARGIN;
  const demR = MARGIN + CONTENT/2 + 10;

  text(ctx, 'Ethnicity: Check one or more', demL, ctx.y, {font:bold, size:8});
  text(ctx, 'Race: Check one or more', demR, ctx.y, {font:bold, size:8});
  ctx.y -= LINE_H;

  const isHisp = d.ethnicity==='HispanicOrLatino'||d.ethnicity==='Hispanic or Latino';
  checkbox(ctx, demL, ctx.y, isHisp, 'Hispanic or Latino');
  checkbox(ctx, demR, ctx.y, false, 'American Indian or Alaskan Native');
  ctx.y -= LINE_H;
  checkbox(ctx, demL+10, ctx.y, false, 'Mexican');
  checkbox(ctx, demR, ctx.y, false, 'Asian');
  ctx.y -= LINE_H;
  checkbox(ctx, demL+10, ctx.y, false, 'Puerto Rican');
  checkbox(ctx, demR+10, ctx.y, false, 'Asian Indian');
  text(ctx, 'Chinese', demR+65, ctx.y, {font:regular, size:7});
  text(ctx, 'Filipino', demR+100, ctx.y, {font:regular, size:7});
  ctx.y -= LINE_H;
  checkbox(ctx, demL+10, ctx.y, false, 'Cuban');
  checkbox(ctx, demR+10, ctx.y, false, 'Japanese');
  text(ctx, 'Korean', demR+65, ctx.y, {font:regular, size:7});
  text(ctx, 'Vietnamese', demR+100, ctx.y, {font:regular, size:7});
  ctx.y -= LINE_H;
  checkbox(ctx, demL+10, ctx.y, false, 'Other Hispanic or Latino');
  checkbox(ctx, demR, ctx.y, d.race==='BlackOrAfricanAmerican', 'Black or African American');
  ctx.y -= LINE_H;
  checkbox(ctx, demL, ctx.y, d.ethnicity==='NotHispanicOrLatino', 'Not Hispanic or Latino');
  checkbox(ctx, demR, ctx.y, false, 'Native Hawaiian or Other Pacific Islander');
  ctx.y -= LINE_H;
  checkbox(ctx, demL, ctx.y, !d.ethnicity, 'I do not wish to provide this information');
  checkbox(ctx, demR, ctx.y, d.race==='White', 'White');
  ctx.y -= LINE_H;
  text(ctx, 'Sex', demL, ctx.y, {font:bold, size:8});
  checkbox(ctx, demR, ctx.y, !d.race, 'I do not wish to provide this information');
  ctx.y -= LINE_H;
  checkbox(ctx, demL, ctx.y, d.sex==='Female', 'Female');
  ctx.y -= LINE_H;
  checkbox(ctx, demL, ctx.y, d.sex==='Male', 'Male');
  ctx.y -= LINE_H;
  checkbox(ctx, demL, ctx.y, !d.sex, 'I do not wish to provide this information');
  ctx.y -= 14;

  grayBar(ctx, 'To Be Completed by Financial Institution (for application taken in person):');
  const instRows = [
    'Was the ethnicity of the Borrower collected on the basis of visual observation or surname?',
    'Was the sex of the Borrower collected on the basis of visual observation or surname?',
    'Was the race of the Borrower collected on the basis of visual observation or surname?',
  ];
  for (const r of instRows) {
    text(ctx, r, MARGIN, ctx.y, {font:regular, size:7, maxWidth:350});
    text(ctx, 'NO    YES', MARGIN+360, ctx.y, {font:regular, size:7});
    ctx.y -= 10;
  }
  grayBar(ctx, 'The Demographic Information was provided through:');
  text(ctx, 'Face-to-Face Interview (includes Electronic Media w/ Video Component)   Telephone Interview   Fax or Mail   Email or Internet',
    MARGIN, ctx.y, {font:regular, size:7, maxWidth:CONTENT});
  ctx.y -= 14;

  footer(ctx, bName, 'Calyx Form - URLA_8.frm (12/2020). Effective 1/2021');

  // PAGE 7: SECTION 9 + LENDER LOAN INFO
  newPage(ctx);

  text(ctx, 'Section 9: Loan Originator Information.', MARGIN, ctx.y, {font:bold, size:11});
  ctx.y -= 12;
  sectionBar(ctx, 'Loan Originator Information');

  text(ctx, 'Loan Originator Organization Name', MARGIN, ctx.y, {font:regular, size:8});
  hline(ctx, MARGIN+170, ctx.y-1, 180);
  text(ctx, 'Address', MARGIN+355, ctx.y, {font:regular, size:7});
  text(ctx, v(d.lo_org_address,'3750 S Susan Street, Santa Ana, CA 92704'), MARGIN+385, ctx.y, {font:bold, size:7});
  ctx.y -= LINE_H;
  text(ctx, 'Loan Originator Organization NMLSR ID#', MARGIN, ctx.y, {font:regular, size:8});
  text(ctx, v(d.lo_org_nmls,'1416824'), MARGIN+187, ctx.y, {font:bold, size:8});
  text(ctx, 'State License ID#', MARGIN+240, ctx.y, {font:regular, size:7});
  hline(ctx, MARGIN+310, ctx.y-1, 80);
  ctx.y -= LINE_H;
  text(ctx, 'Loan Originator Name', MARGIN, ctx.y, {font:regular, size:8});
  text(ctx, v(d.lo_name,'Rene Duarte'), MARGIN+100, ctx.y, {font:bold, size:8});
  ctx.y -= LINE_H;
  text(ctx, 'Loan Originator NMLSR ID#', MARGIN, ctx.y, {font:regular, size:8});
  text(ctx, v(d.lo_nmls,'1795044'), MARGIN+125, ctx.y, {font:bold, size:8});
  text(ctx, 'State License ID#', MARGIN+200, ctx.y, {font:regular, size:7});
  hline(ctx, MARGIN+270, ctx.y-1, 60);
  ctx.y -= LINE_H;
  text(ctx, 'Email', MARGIN, ctx.y, {font:regular, size:8});
  text(ctx, v(d.lo_email,'rene@ratesandrealty.com'), MARGIN+28, ctx.y, {font:bold, size:8});
  text(ctx, 'Phone', MARGIN+210, ctx.y, {font:regular, size:8});
  text(ctx, v(d.lo_phone,'(714) 472-8508'), MARGIN+240, ctx.y, {font:bold, size:8});
  ctx.y -= LINE_H;
  text(ctx, 'Signature', MARGIN, ctx.y, {font:regular, size:8});
  hline(ctx, MARGIN+45, ctx.y-1, 200);
  text(ctx, 'Date (mm/dd/yyyy)', MARGIN+255, ctx.y, {font:regular, size:7});
  hline(ctx, MARGIN+330, ctx.y-1, 80);
  ctx.y -= 14;

  footer(ctx, bName, 'Calyx Form - URLA_9.frm (12/2020). Effective 1/2021');

  grayBar(ctx, 'To be completed by the Lender:');
  text(ctx, 'Lender Loan No. / Universal Loan Identifier', MARGIN, ctx.y, {font:regular, size:7});
  hline(ctx, MARGIN+200, ctx.y-1, 180);
  text(ctx, 'Agency Case No.', MARGIN+390, ctx.y, {font:regular, size:7});
  hline(ctx, MARGIN+455, ctx.y-1, 85);
  ctx.y -= 10;

  text(ctx, 'Uniform Residential Loan Application - Lender Loan Information', MARGIN, ctx.y, {font:bold, size:11});
  ctx.y -= 10;
  text(ctx, 'This section is completed by your Lender.', MARGIN, ctx.y, {font:regular, size:8});
  ctx.y -= 14;

  sectionBar(ctx, 'L1. Property and Loan Information');
  text(ctx, 'Community Property State', MARGIN, ctx.y, {font:bold, size:8});
  ctx.y -= LINE_H;
  checkbox(ctx, MARGIN+10, ctx.y, false, 'At least one borrower lives in a community property state.');
  ctx.y -= LINE_H;
  checkbox(ctx, MARGIN+10, ctx.y, false, 'The property is in a community property state.');
  ctx.y -= 14;

  sectionBar(ctx, 'L3. Mortgage Loan Information');

  const l1rx = MARGIN + CONTENT/2 + 10;
  text(ctx, 'Mortgage Type Applied For', MARGIN, ctx.y, {font:bold, size:8});
  text(ctx, 'Terms of Loan', l1rx, ctx.y, {font:bold, size:8});
  ctx.y -= LINE_H;

  checkbox(ctx, MARGIN, ctx.y, loanType==='Conventional'||loanType==='Conforming', 'Conventional');
  checkbox(ctx, MARGIN+70, ctx.y, loanType==='USDA'||loanType==='USDA-RD', 'USDA-RD');
  text(ctx, 'Note Rate', l1rx, ctx.y, {font:bold, size:8});
  text(ctx, pct(d.current_interest_rate||d.interest_rate)||'_______', l1rx+55, ctx.y, {font:bold, size:8});
  text(ctx, '%   First Lien', l1rx+100, ctx.y, {font:regular, size:7});
  ctx.y -= LINE_H;

  checkbox(ctx, MARGIN, ctx.y, loanType==='FHA', 'FHA');
  checkbox(ctx, MARGIN+40, ctx.y, loanType==='VA', 'VA');
  text(ctx, 'Other:', MARGIN+70, ctx.y, {font:regular, size:7});
  hline(ctx, MARGIN+100, ctx.y-1, 80);
  text(ctx, 'Loan Term', l1rx, ctx.y, {font:bold, size:8});
  text(ctx, v(d.loan_term_months||d.loan_amortization_months,'______'), l1rx+55, ctx.y, {font:bold, size:8});
  text(ctx, 'months   Subordinate Lien', l1rx+88, ctx.y, {font:regular, size:7});
  ctx.y -= 14;

  text(ctx, 'Amortization Type', MARGIN, ctx.y, {font:bold, size:8});
  ctx.y -= LINE_H;
  checkbox(ctx, MARGIN, ctx.y, true, 'Fixed Rate');
  checkbox(ctx, MARGIN+70, ctx.y, false, 'Adjustable Rate');
  ctx.y -= 14;

  // Proposed Monthly Payment
  text(ctx, 'Proposed Monthly Payment for Property', l1rx, ctx.y+LINE_H, {font:bold, size:8});
  const pitia = [
    ['First Mortgage (P and I)', d.pi_payment],
    ["Homeowners Insurance", d.insurance_monthly],
    ['Property Taxes', d.taxes_monthly],
    ['Mortgage Insurance', d.mi_monthly],
    ['Association/Project Dues', d.hoa_monthly],
    ['Other', null],
  ];
  const pitiaTotal = pitia.reduce((s,[,v2])=>s+(parseFloat(String(v2||0))||0),0);
  for (const [lbl,val] of pitia) {
    text(ctx, lbl as string, l1rx, ctx.y, {font:regular, size:7});
    text(ctx, val ? $$(val)! : '$', l1rx+160, ctx.y, {font:val?bold:regular, size:7});
    ctx.y -= LINE_H;
  }
  text(ctx, 'TOTAL', l1rx, ctx.y, {font:bold, size:8});
  text(ctx, pitiaTotal ? $$(pitiaTotal)! : '$', l1rx+160, ctx.y, {font:bold, size:8});
  ctx.y -= 14;

  sectionBar(ctx, 'L4. Qualifying the Borrower - Minimum Required Funds or Cash Back');

  const l4rows: [string,string,any][] = [
    ['A.','Sales Contract Price', d.purchase_price||d.property_value],
    ['B.','Improvements, Renovations, and Repairs', null],
    ['C.','Land (if acquired separately)', null],
    ['D.','For Refinance: Balance of Mortgage Loans on the Property to be paid off', r0.lien_balance],
    ['E.','Credit Cards and Other Debts Paid Off', null],
    ['F.','Borrower Closing Costs (including Prepaid and Initial Escrow Payments)', null],
    ['G.','Discount Points', null],
  ];
  const l4vw = 100; const l4lw = CONTENT - l4vw;
  rect(ctx, MARGIN, ctx.y-12, CONTENT, 12, {fill:rgb(0.95,0.95,0.95), stroke:rgb(0,0,0)});
  text(ctx, 'DUE FROM BORROWER(S)', MARGIN+4, ctx.y-9, {font:bold, size:7});
  ctx.y -= 12;

  for (const [ltr,q,val] of l4rows) {
    ensureSpace(ctx, 13);
    rect(ctx, MARGIN, ctx.y-12, l4lw, 12, {stroke:rgb(0,0,0)});
    rect(ctx, MARGIN+l4lw, ctx.y-12, l4vw, 12, {stroke:rgb(0,0,0)});
    text(ctx, `${ltr}  ${q}`, MARGIN+2, ctx.y-9, {font:regular, size:7});
    text(ctx, val?$$(val)!:'$', MARGIN+l4lw+2, ctx.y-9, {font:regular, size:7});
    ctx.y -= 12;
  }

  rect(ctx, MARGIN, ctx.y-12, l4lw, 12, {stroke:rgb(0,0,0), thickness:1.5});
  rect(ctx, MARGIN+l4lw, ctx.y-12, l4vw, 12, {stroke:rgb(0,0,0), thickness:1.5});
  text(ctx, 'H.  TOTAL DUE FROM BORROWER(s) (Total of A thru G)', MARGIN+2, ctx.y-9, {font:bold, size:7});
  text(ctx, '$', MARGIN+l4lw+2, ctx.y-9, {font:bold, size:7});
  ctx.y -= 16;

  rect(ctx, MARGIN, ctx.y-12, l4lw, 12, {stroke:rgb(0,0,0)});
  rect(ctx, MARGIN+l4lw, ctx.y-12, l4vw, 12, {stroke:rgb(0,0,0)});
  text(ctx, `I.  Loan Amount: ${$$(d.loan_amount||d.requested_loan_amount)||''}`, MARGIN+2, ctx.y-9, {font:regular, size:7});
  text(ctx, $$(d.loan_amount||d.requested_loan_amount)||'$', MARGIN+l4lw+2, ctx.y-9, {font:bold, size:7});
  ctx.y -= 12;

  rect(ctx, MARGIN, ctx.y-12, l4lw, 12, {stroke:rgb(0,0,0), thickness:1.5});
  rect(ctx, MARGIN+l4lw, ctx.y-12, l4vw, 12, {stroke:rgb(0,0,0), thickness:1.5});
  text(ctx, 'K.  TOTAL MORTGAGE LOANS (Total of I and J)', MARGIN+2, ctx.y-9, {font:bold, size:7});
  text(ctx, $$(d.loan_amount||d.requested_loan_amount)||'$', MARGIN+l4lw+2, ctx.y-9, {font:bold, size:7});
  ctx.y -= 16;

  rect(ctx, MARGIN, ctx.y-12, l4lw, 12, {stroke:rgb(0,0,0)});
  rect(ctx, MARGIN+l4lw, ctx.y-12, l4vw, 12, {stroke:rgb(0,0,0)});
  text(ctx, 'L.  Seller Credits', MARGIN+2, ctx.y-9, {font:regular, size:7});
  text(ctx, '$', MARGIN+l4lw+2, ctx.y-9, {font:regular, size:7});
  ctx.y -= 12;

  rect(ctx, MARGIN, ctx.y-12, l4lw, 12, {stroke:rgb(0,0,0)});
  rect(ctx, MARGIN+l4lw, ctx.y-12, l4vw, 12, {stroke:rgb(0,0,0)});
  text(ctx, 'N.  TOTAL CREDITS (Total of L and M)', MARGIN+2, ctx.y-9, {font:bold, size:7});
  text(ctx, '$', MARGIN+l4lw+2, ctx.y-9, {font:regular, size:7});
  ctx.y -= 16;

  rect(ctx, MARGIN, ctx.y-12, l4lw, 12, {stroke:rgb(0,0,0), thickness:1.5});
  rect(ctx, MARGIN+l4lw, ctx.y-12, l4vw, 12, {stroke:rgb(0,0,0), thickness:1.5});
  text(ctx, 'Cash From/To the Borrower (Line H minus Line K and Line N)', MARGIN+2, ctx.y-9, {font:bold, size:7});
  text(ctx, '$', MARGIN+l4lw+2, ctx.y-9, {font:bold, size:7});
  ctx.y -= 14;

  footer(ctx, bName, 'Calyx Form - LenderLoan_2.frm (05/2020). Effective 1/2021');

  // Page numbers
  const totalPages = ctx.pages.length;
  for (let i=0;i<totalPages;i++) {
    const pg = ctx.pages[i];
    pg.drawText(`Page ${i+1} of ${totalPages}`, {x:LETTER_W-MARGIN-60, y:MARGIN+4, size:6, font:regular, color:rgb(0.5,0.5,0.5)});
  }

  return await doc.save();
}
