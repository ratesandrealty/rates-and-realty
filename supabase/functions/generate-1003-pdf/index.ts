import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { PDFDocument, rgb, StandardFonts } from 'https://esm.sh/pdf-lib@1.17.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TEMPLATE_URL = SUPABASE_URL + '/storage/v1/object/public/public-assets/templates/1003_template.pdf';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};
const hdrs = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

// Try to fill official 1003 template PDF form fields
async function tryTemplateFill(d: any): Promise<Uint8Array | null> {
  try {
    const templateRes = await fetch(TEMPLATE_URL);
    if (!templateRes.ok) { console.log('[1003] Template not found, using custom draw'); return null; }
    const templateBytes = await templateRes.arrayBuffer();
    const pdfDoc = await PDFDocument.load(templateBytes);
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    if (fields.length === 0) { console.log('[1003] Template has no form fields'); return null; }
    console.log('[1003] Template loaded with ' + fields.length + ' form fields');

    // Helper: safely set text field
    function setF(name: string, value: string) {
      try { form.getTextField(name).setText(value || ''); } catch {}
    }
    function setC(name: string, checked: boolean) {
      try { if (checked) form.getCheckBox(name).check(); else form.getCheckBox(name).uncheck(); } catch {}
    }

    // Map data to common 1003 field names (adjust after discovery)
    setF('First Name', d.first_name); setF('Middle Name', d.middle_name);
    setF('Last Name', d.last_name); setF('Suffix', d.suffix);
    setF('Social Security Number', fmtSSN(d.ssn));
    setF('Date of Birth', fmtDate(d.date_of_birth || d.dob));
    setF('Marital Status', d.marital_status || d.marital);
    setF('Number of Dependents', fmt(d.dependents_count || d.dep_count));
    setF('Cell Phone', d.cell_phone); setF('Home Phone', d.home_phone);
    setF('Work Phone', d.work_phone); setF('Email', d.email);
    setC('US Citizen', d.citizenship === 'U.S. Citizen');
    setC('Permanent Resident Alien', d.citizenship === 'Permanent Resident Alien');
    setF('Current Address Street', d.cur_street); setF('Current Address Unit', d.cur_unit);
    setF('Current Address City', d.cur_city); setF('Current Address State', d.cur_state);
    setF('Current Address ZIP', d.cur_zip);
    setF('Employer or Business Name', d.emp_name); setF('Employer Phone', d.emp_phone);
    setF('Position or Title', d.emp_title);
    setF('Base', fmtMoney(d.base_income)); setF('TOTAL', fmtMoney(d.total_income || d.total_inc));
    setF('Loan Amount', fmtMoney(d.loan_amount));
    setF('Property Address Street', d.prop_street); setF('Property Address City', d.prop_city);
    setF('Property Address State', d.prop_state); setF('Property Address ZIP', d.prop_zip);
    setF('County', d.prop_county); setF('Property Value', fmtMoney(d.prop_value));
    setC('Purchase', (d.loan_purpose || '') === 'Purchase');
    setC('Refinance', (d.loan_purpose || '') === 'Refinance');
    setC('Primary Residence', (d.occupancy || '') === 'Primary Residence');
    setF('Loan Originator Organization Name', 'E Mortgage Capital / Rates & Realty');
    setF('Loan Originator Name', 'Rene Duarte');
    setF('Loan Originator NMLSR ID', '1795044');

    return new Uint8Array(await pdfDoc.save());
  } catch (err: any) {
    console.log('[1003] Template fill failed:', err.message);
    return null;
  }
}

const fmt = (v: any) => v == null ? '' : String(v);
const fmtDate = (v: any) => { if (!v) return ''; try { return new Date(v).toLocaleDateString('en-US'); } catch { return fmt(v); } };
const fmtMoney = (v: any) => { if (!v) return ''; const n = parseFloat(String(v)); return isNaN(n) ? fmt(v) : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2 }); };
const fmtSSN = (v: any) => { if (!v) return ''; const s = String(v).replace(/\D/g, ''); return s.length === 9 ? s.slice(0,3)+'-'+s.slice(3,5)+'-'+s.slice(5) : fmt(v); };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const body = await req.json();
    const { contact_id } = body;

    // Discovery mode: list all form field names in the template
    if (body.action === 'discover_fields') {
      try {
        const tRes = await fetch(TEMPLATE_URL);
        if (!tRes.ok) return new Response(JSON.stringify({ error: 'Template not found at ' + TEMPLATE_URL }), { headers: cors });
        const tBytes = await tRes.arrayBuffer();
        const tDoc = await PDFDocument.load(tBytes);
        const fields = tDoc.getForm().getFields().map((f: any) => ({ name: f.getName(), type: f.constructor.name }));
        return new Response(JSON.stringify({ fields, count: fields.length }), { headers: cors });
      } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors }); }
    }
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

    // Try official template fill first
    const templatePdf = await tryTemplateFill(d);
    if (templatePdf) {
      const base64 = btoa(String.fromCharCode(...templatePdf));
      const fileName = `1003_${(d.last_name || 'Borrower').replace(/\s/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;
      // Return both `pdf` and `pdf_base64` so legacy + new clients both work.
      return new Response(JSON.stringify({ success: true, pdf: base64, pdf_base64: base64, file_name: fileName, source: 'template' }), { headers: cors });
    }

    // Fallback: build custom PDF from scratch
    console.log('[1003] Using custom draw fallback');
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const BLACK = rgb(0, 0, 0);
    const GOLD = rgb(0.788, 0.659, 0.298);
    const GRAY = rgb(0.4, 0.4, 0.4);
    const LGRAY = rgb(0.85, 0.85, 0.85);
    const W = 612, H = 792;

    // Row spacing: tight rows (30-35pt) caused field labels to overlap the
    // values from the previous row. ROW=50pt gives every fieldLine a clean
    // band: label at y-14 (top), underline at y, value at y-4 (mid-band).
    const ROW = 50;

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
      // Each field row gets:
      //   label at y - 14  (small gray cap above)
      //   underline at y
      //   value at y - 4   (sits just above the underline)
      // Caller is responsible for spacing y values at least ROW apart.
      const fieldLine = (label: string, value: string, x: number, y: number, w: number) => {
        drawText(label, x, y - 14, { size: 6, color: GRAY });
        drawLine(x, y, x + w, y);
        drawText(fmt(value), x + 2, y - 4, { size: 8.5 });
      };
      return { page, drawText, drawLine, drawBox, drawCheck, fieldLine };
    }

    // ── PAGE 1: Section 1a (Personal) + Section 1b (Employment) ──
    // Income table moved to top of Page 2 to give every row 50pt of clearance
    // without spilling past the 770pt footer.
    {
      const { drawText, drawLine, drawBox, drawCheck, fieldLine } = addPage();
      drawText('Uniform Residential Loan Application', 170, 38, { size: 14, bold: true });
      drawText('Verify and complete the information on this application.', 165, 54, { size: 8, color: GRAY });

      // Section 1a header
      drawBox(50, 72, 512, 16, { fill: rgb(0.15, 0.15, 0.15) });
      drawText('Section 1a. Personal Information', 54, 73, { size: 8.5, bold: true, color: rgb(1,1,1) });

      let y = 110;
      // Row 1: Name parts
      fieldLine('FIRST NAME', d.first_name, 50, y, 130);
      fieldLine('MIDDLE', d.middle_name, 190, y, 90);
      fieldLine('LAST NAME', d.last_name, 290, y, 180);
      fieldLine('SUFFIX', d.suffix, 480, y, 80);

      // Row 2: SSN / DOB / Marital + Citizenship checkboxes
      y += ROW;
      fieldLine('SSN', fmtSSN(d.ssn), 50, y, 120);
      fieldLine('DOB', fmtDate(d.date_of_birth), 180, y, 90);
      fieldLine('MARITAL STATUS', d.marital_status, 280, y, 110);
      drawText('CITIZENSHIP', 400, y - 14, { size: 6, color: GRAY });
      drawCheck(d.citizenship === 'U.S. Citizen', 400, y - 6); drawText('U.S. Citizen', 412, y - 6, { size: 7 });
      drawCheck(d.citizenship === 'Permanent Resident Alien', 400, y + 8); drawText('Perm. Resident', 412, y + 8, { size: 7 });

      // Row 3: Dependents + phones
      y += ROW;
      fieldLine('DEPENDENTS #', fmt(d.dependents_count), 50, y, 90);
      fieldLine('AGES', d.dependents_ages, 150, y, 120);
      fieldLine('CELL PHONE', d.cell_phone, 280, y, 130);
      fieldLine('HOME PHONE', d.home_phone, 420, y, 140);

      // Row 4: Current address row 1
      y += ROW;
      drawText('CURRENT ADDRESS', 50, y - 28, { size: 7, bold: true, color: GRAY });
      fieldLine('STREET', d.cur_street, 50, y, 230);
      fieldLine('UNIT', d.cur_unit, 290, y, 60);
      fieldLine('CITY', d.cur_city, 360, y, 100);
      fieldLine('STATE', d.cur_state, 470, y, 40);
      fieldLine('ZIP', d.cur_zip, 520, y, 40);

      // Row 5: Years / Own/Rent / Rent amount
      y += ROW;
      fieldLine('YEARS', fmt(d.cur_years), 50, y, 50);
      fieldLine('MO', fmt(d.cur_months), 110, y, 40);
      drawCheck(d.cur_housing === 'Own', 160, y - 4); drawText('Own', 172, y - 4, { size: 7 });
      drawCheck(d.cur_housing === 'Rent', 200, y - 4); drawText('Rent', 212, y - 4, { size: 7 });
      fieldLine('RENT $/MO', fmtMoney(d.cur_rent), 250, y, 100);

      // Row 6: Former address
      y += ROW;
      drawText('FORMER ADDRESS', 50, y - 28, { size: 7, bold: true, color: GRAY });
      fieldLine('STREET', d.fmr_street, 50, y, 230);
      fieldLine('CITY', d.fmr_city, 290, y, 100);
      fieldLine('STATE', d.fmr_state, 400, y, 40);
      fieldLine('ZIP', d.fmr_zip, 450, y, 60);
      fieldLine('YRS', fmt(d.fmr_years), 520, y, 40);

      // Row 7: Email + work phone
      y += ROW;
      fieldLine('EMAIL', d.email, 50, y, 280);
      fieldLine('WORK PHONE', d.work_phone, 340, y, 130);

      // Section 1b header
      y += 32;
      drawBox(50, y, 512, 16, { fill: rgb(0.15, 0.15, 0.15) });
      drawText('Section 1b. Current Employment / Self-Employment', 54, y + 1, { size: 8.5, bold: true, color: rgb(1,1,1) });

      // Employer rows
      y += ROW - 12;
      fieldLine('EMPLOYER NAME', d.emp_name, 50, y, 260);
      fieldLine('PHONE', d.emp_phone, 320, y, 130);
      y += ROW;
      fieldLine('STREET', d.emp_street, 50, y, 220);
      fieldLine('CITY', d.emp_city, 280, y, 100);
      fieldLine('STATE', d.emp_state, 390, y, 40);
      fieldLine('ZIP', d.emp_zip, 440, y, 60);
      y += ROW;
      fieldLine('TITLE', d.emp_title, 50, y, 180);
      fieldLine('START DATE', fmtDate(d.emp_start), 240, y, 100);
      fieldLine('YRS', fmt(d.emp_years), 350, y, 50);
      fieldLine('MO', fmt(d.emp_months), 410, y, 40);
      drawCheck(d.self_employed, 470, y - 4); drawText('Self-Employed', 482, y - 4, { size: 7 });

      drawLine(50, 770, 562, 770);
      drawText('Uniform Residential Loan Application — Page 1 of 3', 50, 780, { size: 7, color: GRAY });
      drawText('Borrower: ' + d.first_name + ' ' + d.last_name, 350, 780, { size: 7, color: GRAY });
    }

    // ── PAGE 2: Income + Loan/Property + Declarations + Military ──
    {
      const { drawText, drawLine, drawBox, drawCheck, fieldLine } = addPage();

      // Section 1b continued — Income table (moved here from Page 1).
      drawBox(50, 40, 512, 16, { fill: rgb(0.15, 0.15, 0.15) });
      drawText('Section 1b. Gross Monthly Income', 54, 41, { size: 8.5, bold: true, color: rgb(1,1,1) });

      const inc: Array<[string, any]> = [
        ['Base', d.base_income],
        ['Overtime', d.overtime_income],
        ['Bonus', d.bonus_income],
        ['Commission', d.commission_income],
        ['Military', d.military_income],
        ['Other', d.other_income],
        ['TOTAL', d.total_income],
      ];
      // Two-column layout: labels in col 1, values in col 2, 22pt rows.
      inc.forEach(([label, val], i) => {
        const iy = 78 + i * 22;
        drawText(String(label), 60, iy - 3, { size: 8, bold: label === 'TOTAL' });
        drawLine(140, iy, 280, iy);
        drawText(fmtMoney(val), 144, iy - 4, { size: 9, bold: label === 'TOTAL' });
      });

      // Section 4 header — anchored below the income table.
      let y = 250;
      drawBox(50, y, 512, 16, { fill: rgb(0.15, 0.15, 0.15) });
      drawText('Section 4. Loan and Property Information', 54, y + 1, { size: 8.5, bold: true, color: rgb(1,1,1) });

      // Loan amount + purpose
      y += ROW - 12;
      fieldLine('LOAN AMOUNT', fmtMoney(d.loan_amount), 50, y, 140);
      drawText('LOAN PURPOSE', 210, y - 14, { size: 6, color: GRAY });
      drawCheck(d.loan_purpose === 'Purchase', 210, y - 4); drawText('Purchase', 222, y - 4, { size: 7 });
      drawCheck(d.loan_purpose === 'Refinance', 280, y - 4); drawText('Refinance', 292, y - 4, { size: 7 });

      // Property street
      y += ROW;
      fieldLine('PROPERTY STREET', d.prop_street, 50, y, 280);

      // Property city/state/zip/county/units
      y += ROW;
      fieldLine('CITY', d.prop_city, 50, y, 140);
      fieldLine('STATE', d.prop_state, 200, y, 50);
      fieldLine('ZIP', d.prop_zip, 260, y, 80);
      fieldLine('COUNTY', d.prop_county, 350, y, 120);
      fieldLine('UNITS', fmt(d.num_units), 480, y, 80);

      // Property value + occupancy
      y += ROW;
      fieldLine('PROPERTY VALUE', fmtMoney(d.prop_value), 50, y, 160);
      drawText('OCCUPANCY', 230, y - 14, { size: 6, color: GRAY });
      ['Primary Residence', 'Second Home', 'Investment'].forEach((o, i) => {
        drawCheck(d.occupancy === o, 230 + i * 115, y - 4); drawText(o, 242 + i * 115, y - 4, { size: 7 });
      });

      // Loan type
      y += ROW - 10;
      drawText('LOAN TYPE', 50, y - 14, { size: 6, color: GRAY });
      ['Conventional', 'FHA', 'VA', 'USDA-RD'].forEach((lt, i) => {
        drawCheck(d.loan_type === lt, 50 + i * 100, y - 4); drawText(lt, 62 + i * 100, y - 4, { size: 7 });
      });

      // Section 5 — Declarations
      y += 30;
      drawBox(50, y, 512, 16, { fill: rgb(0.15, 0.15, 0.15) });
      drawText('Section 5. Declarations', 54, y + 1, { size: 8.5, bold: true, color: rgb(1,1,1) });
      const decls: [string, boolean][] = [
        ['A. Will you occupy this property as your primary residence?', d.decl_primary],
        ['F. Are you a co-signer or guarantor on any debt?', d.decl_cosigner],
        ['G. Are there any outstanding judgments against you?', d.decl_judgments],
        ['H. Are you currently delinquent on a federal debt?', d.decl_delinquent],
        ['L. Have you had property foreclosed in the last 7 years?', d.decl_foreclosure],
        ['M. Have you declared bankruptcy in the past 7 years?', d.decl_bankruptcy],
      ];
      const declStart = y + 28;
      decls.forEach(([q, ans], i) => {
        const dy = declStart + i * 22;
        drawText(q, 54, dy, { size: 7.5 });
        drawText('NO', 488, dy, { size: 7 });
        drawText('YES', 518, dy, { size: 7 });
        drawCheck(!ans, 484, dy + 3);
        drawCheck(!!ans, 514, dy + 3);
        drawLine(50, dy + 12, 562, dy + 12, { color: LGRAY });
      });

      let postDecl = declStart + decls.length * 22 + 8;
      if (d.decl_bankruptcy) {
        drawText('Bankruptcy type:', 70, postDecl, { size: 7.5 });
        ['Chapter 7', 'Chapter 11', 'Chapter 12', 'Chapter 13'].forEach((t, i) => {
          drawCheck(d.bankruptcy_type === t, 170 + i * 90, postDecl - 2); drawText(t, 182 + i * 90, postDecl - 2, { size: 7 });
        });
        postDecl += 18;
      }

      // Section 7 — Military Service
      const milY = postDecl + 14;
      drawBox(50, milY, 512, 16, { fill: rgb(0.15, 0.15, 0.15) });
      drawText('Section 7. Military Service', 54, milY + 1, { size: 8.5, bold: true, color: rgb(1,1,1) });
      drawText('Did you serve in the U.S. Armed Forces?', 54, milY + 32, { size: 7.5 });
      drawText('NO', 488, milY + 32, { size: 7 });
      drawText('YES', 518, milY + 32, { size: 7 });
      drawCheck(!d.military_service, 484, milY + 36);
      drawCheck(!!d.military_service, 514, milY + 36);

      drawLine(50, 770, 562, 770);
      drawText('Uniform Residential Loan Application — Page 2 of 3', 50, 780, { size: 7, color: GRAY });
      drawText('Borrower: ' + d.first_name + ' ' + d.last_name, 350, 780, { size: 7, color: GRAY });
    }

    // ── PAGE 3: LO Info + Signature ──
    {
      const { drawText, drawLine, drawBox, fieldLine } = addPage();
      drawBox(50, 40, 512, 16, { fill: rgb(0.15, 0.15, 0.15) });
      drawText('Section 9. Loan Originator Information', 54, 41, { size: 8.5, bold: true, color: rgb(1,1,1) });

      let y = 90;
      fieldLine('ORGANIZATION', 'E Mortgage Capital / Rates & Realty', 50, y, 350);
      y += ROW;
      fieldLine('ADDRESS', 'Huntington Beach, CA', 50, y, 350);
      y += ROW;
      fieldLine('ORG NMLS ID', '1795044', 50, y, 180);
      y += ROW;
      fieldLine('LOAN ORIGINATOR', 'Rene Duarte', 50, y, 220);
      y += ROW;
      fieldLine('ORIGINATOR NMLS', '1795044', 50, y, 150);
      fieldLine('DRE LICENSE', '02035220', 220, y, 120);
      y += ROW;
      fieldLine('EMAIL', 'rene@ratesandrealty.com', 50, y, 250);
      fieldLine('PHONE', '714-472-8508', 310, y, 150);

      const sigY = y + 60;
      drawText('BORROWER SIGNATURE', 50, sigY, { size: 8, bold: true });
      drawLine(50, sigY + 28, 340, sigY + 28);
      drawText('Date:', 360, sigY + 28, { size: 7.5 });
      drawLine(390, sigY + 28, 500, sigY + 28);
      drawText('By signing, I certify the information in this application is true and correct.', 50, sigY + 48, { size: 7, color: GRAY });

      // Branding footer
      drawLine(50, 720, 562, 720, { color: GOLD });
      drawText('Rates & Realty | E Mortgage Capital', 50, 732, { size: 8.5, bold: true, color: GOLD });
      drawText('Rene Duarte NMLS #1795044 · DRE #02035220 · 714-472-8508 · rene@ratesandrealty.com', 50, 744, { size: 7, color: GRAY });
      drawLine(50, 770, 562, 770);
      drawText('Uniform Residential Loan Application — Page 3 of 3', 50, 780, { size: 7, color: GRAY });
    }

    // Serialize
    const pdfBytes = await pdfDoc.save();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(pdfBytes)));
    const fileName = `1003_${(d.last_name || 'Borrower').replace(/\s/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;

    // Return both `pdf` and `pdf_base64` so legacy + new clients both work.
    return new Response(JSON.stringify({ success: true, pdf: base64, pdf_base64: base64, file_name: fileName, source: 'custom' }), { headers: cors });
  } catch (err: any) {
    console.error('[generate-1003-pdf] Error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
});
