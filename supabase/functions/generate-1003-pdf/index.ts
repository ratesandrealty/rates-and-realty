import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { PDFDocument, rgb, StandardFonts } from 'https://esm.sh/pdf-lib@1.17.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};
const hdrs = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

const fmt = (v: any) => v == null ? '' : String(v);
const fmtDate = (v: any) => { if (!v) return ''; try { return new Date(v).toLocaleDateString('en-US'); } catch { return fmt(v); } };
const fmtMoney = (v: any) => { if (!v) return ''; const n = parseFloat(String(v)); return isNaN(n) ? fmt(v) : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2 }); };
const fmtSSN = (v: any) => { if (!v) return ''; const s = String(v).replace(/\D/g, ''); return s.length === 9 ? s.slice(0,3)+'-'+s.slice(3,5)+'-'+s.slice(5) : fmt(v); };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { contact_id } = await req.json();
    if (!contact_id) return new Response(JSON.stringify({ error: 'contact_id required' }), { status: 400, headers: cors });

    // Fetch data
    const [appRes, cRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/mortgage_applications?contact_id=eq.${contact_id}&limit=1`, { headers: hdrs }),
      fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${contact_id}&limit=1`, { headers: hdrs }),
    ]);
    const app = ((await appRes.json()) || [])[0] || {};
    const c = ((await cRes.json()) || [])[0] || {};

    // Merge fields
    const d: any = {
      first_name: app.first_name || c.first_name || '', middle_name: app.middle_name || c.middle_name || '',
      last_name: app.last_name || c.last_name || '', suffix: app.suffix || '',
      ssn: app.ssn || '', date_of_birth: app.date_of_birth || c.date_of_birth || '',
      citizenship: app.citizenship || 'U.S. Citizen', marital_status: app.marital_status || '',
      dependents_count: app.dependents_count || '', dependents_ages: app.dependents_ages || '',
      cell_phone: app.cell_phone || c.phone || '', home_phone: app.home_phone || c.secondary_phone || '',
      work_phone: app.work_phone || '', email: app.email || c.email || '',
      cur_street: app.current_address_street || c.address || '', cur_unit: app.current_address_unit || '',
      cur_city: app.current_address_city || c.city || '', cur_state: app.current_address_state || c.state || '',
      cur_zip: app.current_address_zip || c.zip || '', cur_years: app.current_address_years || '',
      cur_months: app.current_address_months || '', cur_housing: app.current_housing || '', cur_rent: app.current_rent_amount || '',
      fmr_street: app.former_address_street || '', fmr_city: app.former_address_city || '',
      fmr_state: app.former_address_state || '', fmr_zip: app.former_address_zip || '',
      fmr_years: app.former_address_years || '', fmr_months: app.former_address_months || '',
      emp_name: app.employer_name || c.employer_name || '', emp_phone: app.employer_phone || '',
      emp_street: app.employer_street || '', emp_city: app.employer_city || '',
      emp_state: app.employer_state || '', emp_zip: app.employer_zip || '',
      emp_title: app.position_title || c.job_title || '', emp_start: app.employment_start_date || '',
      emp_years: app.years_in_line_of_work || c.years_employed || '', emp_months: app.months_in_line_of_work || '',
      self_employed: app.is_self_employed || false,
      base_income: app.base_income || '', overtime_income: app.overtime_income || '',
      bonus_income: app.bonus_income || '', commission_income: app.commission_income || '',
      military_income: app.military_income || '', other_income: app.other_income || '',
      total_income: app.total_monthly_income || c.monthly_income || '',
      loan_amount: app.loan_amount || c.loan_amount || '', loan_purpose: app.loan_purpose || '',
      prop_street: app.property_address_street || '', prop_city: app.property_address_city || '',
      prop_state: app.property_address_state || '', prop_zip: app.property_address_zip || '',
      prop_county: app.property_address_county || c.county || '', num_units: app.number_of_units || '',
      prop_value: app.property_value || '', occupancy: app.occupancy_type || '',
      loan_type: app.loan_type || c.loan_type || '',
      decl_primary: app.declaration_primary_residence || false, decl_cosigner: app.declaration_cosigner || false,
      decl_judgments: app.declaration_judgments || false, decl_bankruptcy: app.declaration_bankruptcy || false,
      bankruptcy_type: app.bankruptcy_type || '', decl_foreclosure: app.declaration_foreclosure || false,
      decl_delinquent: app.declaration_delinquent || false,
      military_service: app.military_service || false, military_status: app.military_status || '',
      dl_number: app.dl_number || '', dl_state: app.dl_state || '', dl_expiry: app.dl_expiry || '',
      ...app,
    };

    // Build PDF
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const BLACK = rgb(0, 0, 0);
    const GOLD = rgb(0.788, 0.659, 0.298);
    const GRAY = rgb(0.4, 0.4, 0.4);
    const LGRAY = rgb(0.85, 0.85, 0.85);
    const W = 612, H = 792;

    function addPage() {
      const page = pdfDoc.addPage([W, H]);
      const drawText = (text: string, x: number, y: number, opts: any = {}) => {
        page.drawText(fmt(text), { x, y: H - y, size: opts.size || 8, font: opts.bold ? fontB : font, color: opts.color || BLACK });
      };
      const drawLine = (x1: number, y1: number, x2: number, y2: number, opts: any = {}) => {
        page.drawLine({ start: { x: x1, y: H - y1 }, end: { x: x2, y: H - y2 }, thickness: opts.thickness || 0.5, color: opts.color || LGRAY });
      };
      const drawBox = (x: number, y: number, w: number, h: number, opts: any = {}) => {
        page.drawRectangle({ x, y: H - y - h, width: w, height: h, borderColor: LGRAY, borderWidth: 0.5, color: opts.fill });
      };
      const drawCheck = (checked: boolean, x: number, y: number) => {
        drawBox(x, y, 8, 8);
        if (checked) page.drawText('X', { x: x + 1.5, y: H - y - 6.5, size: 6.5, font: fontB, color: BLACK });
      };
      const fieldLine = (label: string, value: string, x: number, y: number, w: number) => {
        drawText(label, x, y - 9, { size: 6, color: GRAY });
        drawLine(x, y, x + w, y);
        drawText(fmt(value), x + 2, y - 2, { size: 8.5 });
      };
      return { page, drawText, drawLine, drawBox, drawCheck, fieldLine };
    }

    // ── PAGE 1: Section 1a + 1b ──
    {
      const { drawText, drawLine, drawBox, drawCheck, fieldLine } = addPage();
      drawText('Uniform Residential Loan Application', 170, 38, { size: 14, bold: true });
      drawText('Verify and complete the information on this application.', 165, 54, { size: 8, color: GRAY });

      drawBox(50, 72, 512, 15, { fill: rgb(0.15, 0.15, 0.15) });
      drawText('Section 1a. Personal Information', 54, 71, { size: 8.5, bold: true, color: rgb(1,1,1) });

      const r1 = 108; fieldLine('FIRST NAME', d.first_name, 50, r1, 130); fieldLine('MIDDLE', d.middle_name, 190, r1, 90); fieldLine('LAST NAME', d.last_name, 290, r1, 180); fieldLine('SUFFIX', d.suffix, 480, r1, 80);
      const r2 = 143; fieldLine('SSN', fmtSSN(d.ssn), 50, r2, 120); fieldLine('DOB', fmtDate(d.date_of_birth), 180, r2, 90); fieldLine('MARITAL STATUS', d.marital_status, 280, r2, 110);
      drawText('CITIZENSHIP', 400, r2 - 9, { size: 6, color: GRAY });
      drawCheck(d.citizenship === 'U.S. Citizen', 400, r2 - 1); drawText('U.S. Citizen', 412, r2 - 1, { size: 7 });
      drawCheck(d.citizenship === 'Permanent Resident Alien', 400, r2 + 10); drawText('Perm. Resident', 412, r2 + 10, { size: 7 });

      const r3 = 178; fieldLine('DEPENDENTS #', fmt(d.dependents_count), 50, r3, 90); fieldLine('AGES', d.dependents_ages, 150, r3, 120);
      fieldLine('CELL PHONE', d.cell_phone, 280, r3, 130); fieldLine('HOME PHONE', d.home_phone, 420, r3, 140);

      const r4 = 210; drawText('CURRENT ADDRESS', 50, r4 - 12, { size: 7, bold: true, color: GRAY });
      fieldLine('STREET', d.cur_street, 50, r4, 230); fieldLine('UNIT', d.cur_unit, 290, r4, 60);
      fieldLine('CITY', d.cur_city, 360, r4, 100); fieldLine('STATE', d.cur_state, 470, r4, 40); fieldLine('ZIP', d.cur_zip, 520, r4, 40);
      const r5 = 240; fieldLine('YEARS', fmt(d.cur_years), 50, r5, 50); fieldLine('MO', fmt(d.cur_months), 110, r5, 40);
      drawCheck(d.cur_housing==='Own', 160, r5); drawText('Own', 172, r5, { size: 7 });
      drawCheck(d.cur_housing==='Rent', 200, r5); drawText('Rent', 212, r5, { size: 7 });
      fieldLine('RENT $/MO', fmtMoney(d.cur_rent), 250, r5, 100);

      const r6 = 270; drawText('FORMER ADDRESS', 50, r6 - 12, { size: 7, bold: true, color: GRAY });
      fieldLine('STREET', d.fmr_street, 50, r6, 230); fieldLine('CITY', d.fmr_city, 290, r6, 100);
      fieldLine('STATE', d.fmr_state, 400, r6, 40); fieldLine('ZIP', d.fmr_zip, 450, r6, 60); fieldLine('YRS', fmt(d.fmr_years), 520, r6, 40);

      fieldLine('EMAIL', d.email, 50, 305, 280); fieldLine('WORK PHONE', d.work_phone, 340, 305, 130);

      // 1b: Employment
      drawBox(50, 330, 512, 15, { fill: rgb(0.15, 0.15, 0.15) });
      drawText('Section 1b. Current Employment / Self-Employment and Income', 54, 329, { size: 8.5, bold: true, color: rgb(1,1,1) });

      const e1 = 366; fieldLine('EMPLOYER NAME', d.emp_name, 50, e1, 260); fieldLine('PHONE', d.emp_phone, 320, e1, 130);
      const e2 = 396; fieldLine('STREET', d.emp_street, 50, e2, 220); fieldLine('CITY', d.emp_city, 280, e2, 100); fieldLine('STATE', d.emp_state, 390, e2, 40); fieldLine('ZIP', d.emp_zip, 440, e2, 60);
      const e3 = 426; fieldLine('TITLE', d.emp_title, 50, e3, 180); fieldLine('START DATE', fmtDate(d.emp_start), 240, e3, 100);
      fieldLine('YRS IN LINE', fmt(d.emp_years), 350, e3, 60); fieldLine('MO', fmt(d.emp_months), 420, e3, 40);
      drawCheck(d.self_employed, 470, e3); drawText('Self-Employed', 482, e3, { size: 7 });

      // Income
      drawText('GROSS MONTHLY INCOME', 50, 458, { size: 7, bold: true, color: GRAY });
      const inc = [['Base', d.base_income], ['Overtime', d.overtime_income], ['Bonus', d.bonus_income],
        ['Commission', d.commission_income], ['Military', d.military_income], ['Other', d.other_income], ['TOTAL', d.total_income]];
      inc.forEach(([label, val], i) => {
        const iy = 478 + i * 20;
        drawText(String(label), 50, iy, { size: 7.5, bold: label === 'TOTAL' });
        drawLine(110, iy, 220, iy);
        drawText(fmtMoney(val), 112, iy - 2, { size: 8.5 });
      });

      drawLine(50, 770, 562, 770); drawText('Uniform Residential Loan Application — Page 1 of 3', 50, 780, { size: 7, color: GRAY });
      drawText('Borrower: ' + d.first_name + ' ' + d.last_name, 350, 780, { size: 7, color: GRAY });
    }

    // ── PAGE 2: Loan/Property + Declarations ──
    {
      const { drawText, drawLine, drawBox, drawCheck, fieldLine } = addPage();
      drawBox(50, 40, 512, 15, { fill: rgb(0.15, 0.15, 0.15) });
      drawText('Section 4. Loan and Property Information', 54, 39, { size: 8.5, bold: true, color: rgb(1,1,1) });

      const l1 = 78; fieldLine('LOAN AMOUNT', fmtMoney(d.loan_amount), 50, l1, 140);
      drawText('LOAN PURPOSE', 210, l1 - 9, { size: 6, color: GRAY });
      drawCheck(d.loan_purpose === 'Purchase', 210, l1); drawText('Purchase', 222, l1, { size: 7 });
      drawCheck(d.loan_purpose === 'Refinance', 280, l1); drawText('Refinance', 292, l1, { size: 7 });

      const p1 = 113; fieldLine('PROPERTY STREET', d.prop_street, 50, p1, 280);
      const p2 = 143; fieldLine('CITY', d.prop_city, 50, p2, 140); fieldLine('STATE', d.prop_state, 200, p2, 50);
      fieldLine('ZIP', d.prop_zip, 260, p2, 80); fieldLine('COUNTY', d.prop_county, 350, p2, 120); fieldLine('UNITS', fmt(d.num_units), 480, p2, 80);
      const p3 = 173; fieldLine('PROPERTY VALUE', fmtMoney(d.prop_value), 50, p3, 160);
      drawText('OCCUPANCY', 230, p3 - 9, { size: 6, color: GRAY });
      ['Primary Residence','Second Home','Investment'].forEach((o, i) => {
        drawCheck(d.occupancy === o, 230 + i * 115, p3); drawText(o, 242 + i * 115, p3, { size: 7 });
      });
      const p4 = 203; drawText('LOAN TYPE', 50, p4 - 9, { size: 6, color: GRAY });
      ['Conventional','FHA','VA','USDA-RD'].forEach((lt, i) => {
        drawCheck(d.loan_type === lt, 50 + i * 100, p4); drawText(lt, 62 + i * 100, p4, { size: 7 });
      });

      // Declarations
      const s5 = 240; drawBox(50, s5, 512, 15, { fill: rgb(0.15, 0.15, 0.15) });
      drawText('Section 5. Declarations', 54, s5 - 1, { size: 8.5, bold: true, color: rgb(1,1,1) });
      const decls: [string, boolean][] = [
        ['A. Will you occupy this property as your primary residence?', d.decl_primary],
        ['F. Are you a co-signer or guarantor on any debt?', d.decl_cosigner],
        ['G. Are there any outstanding judgments against you?', d.decl_judgments],
        ['H. Are you currently delinquent on a federal debt?', d.decl_delinquent],
        ['L. Have you had property foreclosed in the last 7 years?', d.decl_foreclosure],
        ['M. Have you declared bankruptcy in the past 7 years?', d.decl_bankruptcy],
      ];
      decls.forEach(([q, ans], i) => {
        const dy = s5 + 28 + i * 26;
        drawText(q, 54, dy, { size: 7.5 }); drawText('NO', 488, dy, { size: 7 }); drawText('YES', 518, dy, { size: 7 });
        drawCheck(!ans, 484, dy + 3); drawCheck(!!ans, 514, dy + 3);
        drawLine(50, dy + 14, 562, dy + 14, { color: LGRAY });
      });

      if (d.decl_bankruptcy) {
        const btY = s5 + 28 + decls.length * 26 + 8;
        drawText('Bankruptcy type:', 70, btY, { size: 7.5 });
        ['Chapter 7','Chapter 11','Chapter 12','Chapter 13'].forEach((t, i) => {
          drawCheck(d.bankruptcy_type === t, 170 + i * 90, btY + 2); drawText(t, 182 + i * 90, btY + 2, { size: 7 });
        });
      }

      // Military
      const milY = s5 + 210; drawBox(50, milY, 512, 15, { fill: rgb(0.15, 0.15, 0.15) });
      drawText('Section 7. Military Service', 54, milY - 1, { size: 8.5, bold: true, color: rgb(1,1,1) });
      drawText('Did you serve in the U.S. Armed Forces?', 54, milY + 22, { size: 7.5 });
      drawText('NO', 488, milY + 22, { size: 7 }); drawText('YES', 518, milY + 22, { size: 7 });
      drawCheck(!d.military_service, 484, milY + 26); drawCheck(!!d.military_service, 514, milY + 26);

      drawLine(50, 770, 562, 770); drawText('Uniform Residential Loan Application — Page 2 of 3', 50, 780, { size: 7, color: GRAY });
      drawText('Borrower: ' + d.first_name + ' ' + d.last_name, 350, 780, { size: 7, color: GRAY });
    }

    // ── PAGE 3: LO Info + Signature ──
    {
      const { drawText, drawLine, drawBox, fieldLine } = addPage();
      drawBox(50, 40, 512, 15, { fill: rgb(0.15, 0.15, 0.15) });
      drawText('Section 9. Loan Originator Information', 54, 39, { size: 8.5, bold: true, color: rgb(1,1,1) });

      const y = 78;
      fieldLine('ORGANIZATION', 'E Mortgage Capital / Rates & Realty', 50, y, 350);
      fieldLine('ADDRESS', 'Huntington Beach, CA', 50, y + 30, 350);
      fieldLine('ORG NMLS ID', '1795044', 50, y + 60, 180);
      fieldLine('LOAN ORIGINATOR', 'Rene Duarte', 50, y + 90, 220);
      fieldLine('ORIGINATOR NMLS', '1795044', 50, y + 120, 150); fieldLine('DRE LICENSE', '02035220', 220, y + 120, 120);
      fieldLine('EMAIL', 'rene@ratesandrealty.com', 50, y + 150, 250); fieldLine('PHONE', '714-472-8508', 310, y + 150, 150);

      const sigY = y + 200;
      drawText('BORROWER SIGNATURE', 50, sigY, { size: 8, bold: true });
      drawLine(50, sigY + 28, 340, sigY + 28); drawText('Date:', 360, sigY + 28, { size: 7.5 }); drawLine(390, sigY + 28, 500, sigY + 28);
      drawText('By signing, I certify the information in this application is true and correct.', 50, sigY + 48, { size: 7, color: GRAY });

      // Branding
      drawLine(50, 720, 562, 720, { color: GOLD }); drawText('Rates & Realty | E Mortgage Capital', 50, 732, { size: 8.5, bold: true, color: GOLD });
      drawText('Rene Duarte NMLS #1795044 · DRE #02035220 · 714-472-8508 · rene@ratesandrealty.com', 50, 744, { size: 7, color: GRAY });
      drawLine(50, 770, 562, 770); drawText('Uniform Residential Loan Application — Page 3 of 3', 50, 780, { size: 7, color: GRAY });
    }

    // Serialize
    const pdfBytes = await pdfDoc.save();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(pdfBytes)));
    const fileName = `1003_${(d.last_name || 'Borrower').replace(/\s/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;

    return new Response(JSON.stringify({ pdf_base64: base64, file_name: fileName }), { headers: cors });
  } catch (err: any) {
    console.error('[generate-1003-pdf] Error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
});
