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

// ─── URLA template assets ──────────────────────────────────────────────
// urla/embed.ts is auto-generated from urla/{style.css,index.html,script.js}
// (the human-editable canonical sources). Regenerate with:
//   cd supabase/functions/generate-1003-pdf && {
//     printf 'export const URLA_CSS = String.raw\x60';  cat urla/style.css;  printf '\x60;\n';
//     printf 'export const URLA_HTML = String.raw\x60'; cat urla/index.html; printf '\x60;\n';
//     printf 'export const URLA_JS = String.raw\x60';   cat urla/script.js;  printf '\x60;\n';
//   } > urla/embed.ts
import { URLA_CSS, URLA_HTML, URLA_JS } from './urla/embed.ts';

// Extract just the <body> contents of urla/index.html (drop <html>/<head>/<link>/external script tag)
const BODY_MATCH = URLA_HTML.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
const URLA_BODY = (BODY_MATCH ? BODY_MATCH[1] : URLA_HTML)
  .replace(/<script[^>]*src=["']script\.js["'][^>]*>\s*<\/script>/gi, '');

// ─── Build the URLA_DATA JSON structure from the DB row ────────────────
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
    lender: {
      loanNo: app.lender_loan_no || '',
      agencyCaseNo: app.agency_case_no || '',
    },
    borrower: {
      fullName,
      firstName,
      middleName,
      lastName,
      suffix,
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
    coBorrower: {
      fullName: coFullName,
      firstName: coFirst,
      lastName: coLast,
    },
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
        baseIncome,
        overtime,
        bonus,
        commission,
        military,
        other,
        total: totalIncome,
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
<style>${URLA_CSS}</style>
</head>
<body>
${URLA_BODY}
<script>
window.URLA_DATA = ${dataJson};
${URLA_JS}
</script>
</body>
</html>`;
}

// ─── Request handler ───────────────────────────────────────────────────────
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

    // btoa only handles latin-1; encode utf-8 → bytes → base64
    const bytes = new TextEncoder().encode(html);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);

    const fileName = `1003_${(urlaData.borrower.lastName || 'Borrower').replace(/\s/g, '_')}_${new Date().toISOString().slice(0, 10)}.html`;
    return new Response(JSON.stringify({ success: true, html: b64, file_name: fileName }), { headers: cors });
  } catch (err: any) {
    console.error('[generate-1003-pdf] Error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
});
