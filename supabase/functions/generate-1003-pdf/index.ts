import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};
const hdrs = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

import { URLA_CSS, URLA_HTML, URLA_JS } from './urla/embed.ts';

const BODY_MATCH = URLA_HTML.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
const URLA_BODY = (BODY_MATCH ? BODY_MATCH[1] : URLA_HTML)
  .replace(/<script[^>]*src=["']script\.js["'][^>]*>\s*<\/script>/gi, '');

// v47 (restored v46 print button after v46 stub-embed regression):
// Floating print button injected by buildHtml(). Uses the existing `.no-print`
// class (already in URLA_CSS) so it auto-hides during browser print/PDF export.
// Works in modal iframe AND in downloaded .html file.
// v48: moved from top-right to BOTTOM-right so it never overlaps the in-app
// viewer's own gold Print/Save toolbar (which lives along the top of the page).
const PRINT_TOOLBAR = `<div class="no-print" style="position:fixed;bottom:16px;right:16px;z-index:9999;display:flex;gap:8px;">
<button onclick="window.print()" style="padding:9px 16px;background:#000;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-family:Arial,Helvetica,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,0.30);font-weight:600;">📄 Save as PDF / Print</button>
</div>`;

// v48: appended after URLA_CSS in buildHtml() so it wins on cascade order.
// Restyles the embedded template to match the official Fannie/Freddie URLA look
// WITHOUT editing the 11-page embed.ts template:
//  - Section description sentences (.subsection-bar without .light) -> plain text
//    (these were rendered as dark navy bars, which is backwards from the real form).
//    NOTE: the lender L1-L4 labels share this selector and will render as plain
//    bold text rather than black tabs -- an accepted trade-off to avoid template edits.
//  - Subsection labels 1a/1b/2a/... (.subsection-bar.light) -> solid black rounded tabs.
//  - Legacy navy (#1a1a2e) accents -> black, for a consistent official palette.
//  - Field cells -> white background (the real form is not shaded gray).
const CSS_OVERRIDE = `
/* ===== v48 official-URLA look overrides (after base URLA_CSS) ===== */

/* Section intro sentences: plain text, not dark bars */
.subsection-bar:not(.light){
  background:transparent !important;
  color:#000 !important;
  border:0 !important;
  padding:1px 0 4px !important;
  margin:1px 0 6px !important;
  font-weight:400 !important;
  font-size:8.5pt !important;
  letter-spacing:0 !important;
  line-height:1.3 !important;
}

/* Subsection labels (1a, 1b, 2a, ... and named tabs): solid black rounded tabs */
.subsection-bar.light{
  display:inline-block !important;
  background:#000 !important;
  color:#fff !important;
  border:0 !important;
  border-radius:7px 7px 0 0 !important;
  padding:4px 14px 5px !important;
  margin:9px 0 0 !important;
  font-size:8.5pt !important;
  font-weight:bold !important;
  letter-spacing:0.2px !important;
  line-height:1.15 !important;
}
.subsection-bar.light .cb{ color:#fff !important; }

/* Section headings: bold black, snug to their description */
.section-header{ font-size:12.5pt !important; font-weight:bold !important; margin:12px 0 1px !important; }
.form-title{ margin-top:2px !important; }

/* Field cells white like the official form (were gray) */
.form-table .lbl{ background:#fff !important; }
.form-table th{ background:#f0f0f0 !important; }

/* Recolor legacy navy accents (TOTAL boxes, total rows, cash row) to black */
[style*="1a1a2e"]{ background:#000 !important; }

/* ===== v49 print pagination: one section per physical Letter sheet (match official 1003) =====
   Root cause of the 11-logical -> 13-physical page spill: dense sections (esp. Section 1 =
   1a+1b) were taller than one sheet, so they overflowed onto a second sheet. Fix: in print,
   widen the usable area (8.5in page, was 7.5in on screen -> less wrapping -> shorter) and
   tighten spacing so each .page fits one sheet. page-break-inside:avoid + height:auto means
   if a section is still marginally too tall it SPLITS to a new sheet rather than clipping
   data -- form content is never lost. */
@media print {
  @page { size: letter; margin: 0; }
  html, body { width: 8.5in !important; margin: 0 !important; padding: 0 !important; }

  .page {
    width: 8.5in !important;
    min-height: 0 !important;
    height: auto !important;
    max-height: none !important;
    padding: 0.3in 0.35in 0.4in !important;
    margin: 0 !important;
    box-sizing: border-box !important;
    overflow: hidden !important;
    page-break-after: always !important;
    page-break-inside: avoid !important;
    break-inside: avoid-page !important;
  }
  .page:last-child { page-break-after: avoid !important; }

  /* Tighten so each section fits a single sheet */
  body { font-size: 8pt !important; line-height: 1.12 !important; }
  .form-title { font-size: 17pt !important; margin: 0 0 1px !important; }
  .form-subtitle { margin-bottom: 4px !important; }
  .instructions { margin-bottom: 4px !important; font-size: 7pt !important; line-height: 1.2 !important; }
  .lender-bar { margin-bottom: 5px !important; padding: 3px 8px !important; }
  .section-header { margin: 5px 0 1px !important; font-size: 11pt !important; }
  .subsection-bar.light { margin: 4px 0 0 !important; padding: 2px 11px 3px !important; font-size: 8pt !important; }
  .subsection-bar:not(.light) { margin: 1px 0 3px !important; font-size: 7.7pt !important; line-height: 1.2 !important; }
  .form-table td, .form-table th { padding: 1px 5px !important; font-size: 7.7pt !important; }
  .form-table .lbl { font-size: 6.5pt !important; }
  .form-table .val { min-height: 11px !important; font-size: 8pt !important; }
  .form-table .val.empty { min-height: 13px !important; }
  .opt, .opt-block { font-size: 7.7pt !important; }
  .opt-block { padding: 0 !important; line-height: 1.12 !important; }
  .cb { font-size: 8.5pt !important; }
  .decl { padding: 2px 8px !important; font-size: 7.3pt !important; }
  .ack { font-size: 6.2pt !important; line-height: 1.25 !important; padding: 5px 8px !important; }
  .sig-row { margin-top: 7px !important; }
  .page-footer { font-size: 6pt !important; bottom: 0.16in !important; }
}
`;

function buildUrlaData(app: any, c: any) {
  const firstName = app.first_name || c.first_name || '';
  const middleName = app.middle_name || '';
  const lastName = app.last_name || c.last_name || '';
  const suffix = app.suffix || '';
  const fullName = [firstName, middleName, lastName, suffix].filter(Boolean).join(' ');

  const coFirst = app.co_borrower_first_name || '';
  const coMiddle = app.co_borrower_middle_name || '';
  const coLast = app.co_borrower_last_name || '';
  const coSuffix = app.co_borrower_suffix || '';
  const coFullName = [coFirst, coMiddle, coLast, coSuffix].filter(Boolean).join(' ');

  const baseIncome = parseFloat(app.base_income) || 0;
  const overtime = parseFloat(app.overtime_income) || 0;
  const bonus = parseFloat(app.bonus_income) || 0;
  const commission = parseFloat(app.commission_income) || 0;
  const military = parseFloat(app.military_income) || 0;
  const other = parseFloat(app.other_income) || 0;
  const totalIncome = parseFloat(app.total_monthly_income) || (baseIncome + overtime + bonus + commission + military + other);

  return {
    lender: { loanNo: app.lender_loan_no || '', agencyCaseNo: app.agency_case_no || '' },
    borrower: {
      fullName, firstName, middleName, lastName, suffix,
      alternateNames: app.alternate_names || '',
      ssn: app.ssn || '',
      dob: app.date_of_birth || c.date_of_birth || '',
      citizenship: app.citizenship || 'us_citizen',
      maritalStatus: app.marital_status || '',
      dependentsCount: app.dependents_count || '',
      dependentsAges: app.dependents_ages || '',
      totalBorrowers: coFullName ? 2 : 1,
      homePhone: app.home_phone || c.secondary_phone || '',
      cellPhone: app.cell_phone || c.phone || '',
      workPhone: app.work_phone || '',
      email: app.email || c.email || '',
      currentAddress: {
        street: app.current_address_street || c.address || '',
        unit: app.current_address_unit || '',
        city: app.current_address_city || c.city || '',
        state: app.current_address_state || c.state || '',
        zip: app.current_address_zip || c.zip || '',
        country: app.current_address_country || 'USA',
        years: app.current_address_years || 0,
        months: app.current_address_months || 0,
        housing: app.current_housing || '',
        rent: app.current_rent_amount || '',
      },
      formerAddress: {
        street: app.former_address_street || '',
        unit: app.former_address_unit || '',
        city: app.former_address_city || '',
        state: app.former_address_state || '',
        zip: app.former_address_zip || '',
        years: app.former_address_years || 0,
        months: app.former_address_months || 0,
      },
      mailingAddress: app.mailing_address || '',
      militaryService: !!app.military_service,
      militaryStatus: app.military_status || '',
      ethnicity: app.demographic_ethnicity || '',
      race: app.demographic_race || '',
      sex: app.demographic_sex || '',
    },
    coBorrower: { fullName: coFullName, firstName: coFirst, lastName: coLast },
    employment: {
      current: {
        employerName: app.employer_name || c.employer_name || '',
        phone: app.employer_phone || '',
        street: app.employer_street || '',
        unit: app.employer_unit || '',
        city: app.employer_city || '',
        state: app.employer_state || '',
        zip: app.employer_zip || '',
        country: app.employer_country || 'USA',
        position: app.position_title || c.job_title || '',
        startDate: app.employment_start_date || '',
        years: app.years_in_line_of_work || c.years_employed || 0,
        months: app.months_in_line_of_work || 0,
        selfEmployed: !!app.is_self_employed,
        familyEmployer: !!app.family_member_employer,
        baseIncome, overtime, bonus, commission, military, other, total: totalIncome,
      },
    },
    loan: {
      amount: app.loan_amount || app.requested_loan_amount || c.loan_amount || 0,
      purpose: app.loan_purpose || '',
      type: app.loan_type || c.loan_type || '',
      interestRate: app.current_interest_rate || '',
      termMonths: app.loan_term_months || '',
      property: {
        street: app.property_address_street || '',
        unit: app.property_address_unit || '',
        city: app.property_address_city || '',
        state: app.property_address_state || '',
        zip: app.property_address_zip || '',
        county: app.property_address_county || c.county || '',
        country: app.property_address_country || 'USA',
        units: app.number_of_units || 1,
        value: app.property_value || 0,
        occupancy: app.occupancy_type || '',
        mixedUse: !!app.mixed_use_property,
        manufactured: !!app.manufactured_home,
      },
    },
    declarations: {
      a: !!app.declaration_primary_residence,
      b: !!app.declaration_family_seller,
      c: !!app.declaration_borrowed_funds,
      d1: !!app.declaration_other_mortgage,
      d2: !!app.declaration_new_credit,
      e: !!app.declaration_pace_lien,
      f: !!app.declaration_cosigner,
      g: !!app.declaration_judgments,
      h: !!app.declaration_delinquent,
      i: !!app.declaration_lawsuit,
      j: !!app.declaration_deed_in_lieu,
      k: !!app.declaration_short_sale,
      l: !!app.declaration_foreclosure,
      m: !!app.declaration_bankruptcy,
      bankruptcyType: app.bankruptcy_type || '',
    },
    lo: {
      orgName: 'E Mortgage Capital, Inc. / Rates & Realty',
      orgAddress: 'Huntington Beach, CA',
      orgNmls: '1416824',
      orgLicense: '',
      loName: 'Rene Duarte',
      loNmls: '1795044',
      loLicense: '',
      email: 'rene@ratesandrealty.com',
      phone: '(714) 472-8508',
    },
  };
}

function buildHtml(urlaData: any): string {
  const fullName = urlaData.borrower.fullName || 'Borrower';
  const dataJson = JSON.stringify(urlaData).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Uniform Residential Loan Application — ${fullName.replace(/[<>]/g, '')}</title>
<style>${URLA_CSS}
${CSS_OVERRIDE}</style>
</head>
<body>
${PRINT_TOOLBAR}
${URLA_BODY}
<script>
window.URLA_DATA = ${dataJson};
${URLA_JS}
</script>
</body>
</html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const contact_id = body.contact_id;
    if (!contact_id) return new Response(JSON.stringify({ error: 'contact_id required' }), { status: 400, headers: cors });

    const [appRes, cRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/mortgage_applications?contact_id=eq.${contact_id}&order=created_at.desc&limit=1`, { headers: hdrs }),
      fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${contact_id}&limit=1`, { headers: hdrs }),
    ]);
    const app = ((await appRes.json()) || [])[0] || {};
    const c = ((await cRes.json()) || [])[0] || {};

    const urlaData = buildUrlaData(app, c);
    const html = buildHtml(urlaData);

    const bytes = new TextEncoder().encode(html);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);

    const fileName = `1003_${(urlaData.borrower.lastName || 'Borrower').replace(/\s/g, '_')}_${new Date().toISOString().slice(0, 10)}.html`;
    const borrowerName = urlaData.borrower.fullName || 'Borrower';
    return new Response(JSON.stringify({ success: true, html: b64, file_name: fileName, borrower_name: borrowerName }), { headers: cors });
  } catch (err: any) {
    console.error('[generate-1003-pdf] Error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
});
