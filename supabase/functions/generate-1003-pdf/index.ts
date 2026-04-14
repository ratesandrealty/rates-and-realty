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

// ─── formatters ────────────────────────────────────────────────────────────
const fmt = (v: any) => v == null ? '' : String(v);
const esc = (v: any) => fmt(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmtDate = (v: any) => { if (!v) return ''; try { return new Date(v).toLocaleDateString('en-US'); } catch { return fmt(v); } };
const fmtMoney = (v: any) => { if (v == null || v === '') return ''; const n = parseFloat(String(v).replace(/[$,]/g, '')); return isNaN(n) ? fmt(v) : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const fmtSSN = (v: any) => { if (!v) return ''; const s = String(v).replace(/\D/g, ''); return s.length === 9 ? 'XXX-XX-' + s.slice(5) : fmt(v); };
const chk = (on: any) => on ? '&#9746;' : '&#9744;'; // ☑ / ☐

// ─── HTML builder ──────────────────────────────────────────────────────────
function buildHtml(d: any): string {
  const fullName = [d.first_name, d.middle_name, d.last_name, d.suffix].filter(Boolean).join(' ');
  const coName = [d.co_borrower_first_name, d.co_borrower_last_name].filter(Boolean).join(' ');
  const propAddr = [d.prop_street, d.prop_city, d.prop_state, d.prop_zip].filter(Boolean).join(', ');
  const curAddr = [d.cur_street, d.cur_unit && '#' + d.cur_unit, d.cur_city, d.cur_state, d.cur_zip].filter(Boolean).join(', ');
  const totalIncome = d.total_income || (
    (parseFloat(d.base_income) || 0) +
    (parseFloat(d.overtime_income) || 0) +
    (parseFloat(d.bonus_income) || 0) +
    (parseFloat(d.commission_income) || 0) +
    (parseFloat(d.military_income) || 0) +
    (parseFloat(d.other_income) || 0)
  );

  const css = `
    @page { size: letter; margin: 0.5in; }
    * { box-sizing: border-box; font-family: Arial, Helvetica, sans-serif; }
    body { margin: 0; padding: 0; color: #000; font-size: 9pt; }
    .page { page-break-after: always; padding: 0; }
    .page:last-child { page-break-after: auto; }
    h1 { font-size: 13pt; margin: 0 0 4pt 0; text-align: center; }
    .sub { text-align: center; font-size: 8pt; color: #444; margin-bottom: 8pt; }
    .sect { background: #333; color: #fff; padding: 4pt 8pt; font-weight: bold; font-size: 9pt; margin-top: 10pt; }
    table { width: 100%; border-collapse: collapse; margin: 0; }
    td { border: 0.5pt solid #888; padding: 4pt 5pt; vertical-align: top; }
    td.lbl { background: #fff7cc; font-size: 6.5pt; font-weight: bold; width: 1%; white-space: nowrap; color: #333; text-transform: uppercase; }
    td.val { font-size: 9pt; min-height: 14pt; }
    .chk { font-size: 10pt; font-family: 'Segoe UI Symbol', 'DejaVu Sans', sans-serif; margin-right: 2pt; }
    .opt { display: inline-block; margin-right: 10pt; font-size: 8pt; }
    .footer { position: running(footer); font-size: 7pt; color: #666; border-top: 0.5pt solid #999; padding-top: 2pt; margin-top: 10pt; display: flex; justify-content: space-between; }
    .twocol { display: table; width: 100%; }
    .twocol > div { display: table-cell; width: 50%; padding-right: 6pt; }
    .decl { border: 0.5pt solid #888; padding: 3pt 6pt; font-size: 8pt; display: flex; justify-content: space-between; }
    .decl > span:first-child { flex: 1; }
    .print-btn { position: fixed; top: 10px; right: 10px; background: #C9A84C; color: #000; padding: 8px 16px; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 14px; }
    @media print { .print-btn { display: none; } }
  `;

  const row = (cells: Array<{ l: string; v: string; w?: string }>) => `<tr>${cells.map(c => `<td class="lbl" style="${c.w ? 'width:' + c.w : ''}">${c.l}</td><td class="val">${c.v || '&nbsp;'}</td>`).join('')}</tr>`;

  // ─── Sections ────────────────────────────────────────────────────────────
  const section1a = `
    <div class="sect">Section 1a. Personal Information</div>
    <table>
      <tr>
        <td class="lbl">Name (First, Middle, Last, Suffix)</td>
        <td class="val" colspan="5">${esc(fullName)}</td>
      </tr>
      <tr>
        <td class="lbl">Social Security Number</td>
        <td class="val">${esc(fmtSSN(d.ssn))}</td>
        <td class="lbl">Date of Birth</td>
        <td class="val">${esc(fmtDate(d.date_of_birth))}</td>
        <td class="lbl">Citizenship</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk(d.citizenship === 'U.S. Citizen')}</span>U.S. Citizen</span>
          <span class="opt"><span class="chk">${chk(d.citizenship === 'Permanent Resident Alien')}</span>Perm. Resident Alien</span>
          <span class="opt"><span class="chk">${chk(d.citizenship === 'Non-Permanent Resident Alien')}</span>Non-Perm. Resident</span>
        </td>
      </tr>
      <tr>
        <td class="lbl">Marital Status</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk((d.marital_status || '').toLowerCase() === 'married')}</span>Married</span>
          <span class="opt"><span class="chk">${chk((d.marital_status || '').toLowerCase() === 'separated')}</span>Separated</span>
          <span class="opt"><span class="chk">${chk(['unmarried', 'single', 'divorced'].includes((d.marital_status || '').toLowerCase()))}</span>Unmarried</span>
        </td>
        <td class="lbl">Dependents #</td>
        <td class="val">${esc(d.dependents_count)}</td>
        <td class="lbl">Ages</td>
        <td class="val">${esc(d.dependents_ages)}</td>
      </tr>
      <tr>
        <td class="lbl">Cell Phone</td>
        <td class="val">${esc(d.cell_phone)}</td>
        <td class="lbl">Home Phone</td>
        <td class="val">${esc(d.home_phone)}</td>
        <td class="lbl">Email</td>
        <td class="val">${esc(d.email)}</td>
      </tr>
      <tr>
        <td class="lbl">Current Address</td>
        <td class="val" colspan="5">${esc(curAddr)}</td>
      </tr>
      <tr>
        <td class="lbl">How Long at Current Address</td>
        <td class="val">${esc(d.cur_years)} yrs ${esc(d.cur_months)} mos</td>
        <td class="lbl">Housing</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk(d.cur_housing === 'Own')}</span>Own</span>
          <span class="opt"><span class="chk">${chk(d.cur_housing === 'Rent')}</span>Rent</span>
          <span class="opt"><span class="chk">${chk(d.cur_housing === 'No primary housing expense')}</span>No Primary</span>
        </td>
        <td class="lbl">Rent $/mo</td>
        <td class="val">${esc(fmtMoney(d.cur_rent))}</td>
      </tr>
      ${(d.fmr_street || d.fmr_city) ? `
      <tr>
        <td class="lbl">Former Address</td>
        <td class="val" colspan="3">${esc([d.fmr_street, d.fmr_city, d.fmr_state, d.fmr_zip].filter(Boolean).join(', '))}</td>
        <td class="lbl">How Long</td>
        <td class="val">${esc(d.fmr_years)} yrs ${esc(d.fmr_months)} mos</td>
      </tr>` : ''}
    </table>
  `;

  const section1b = `
    <div class="sect">Section 1b. Current Employment/Self-Employment and Income</div>
    <table>
      <tr>
        <td class="lbl">Employer or Business Name</td>
        <td class="val" colspan="3">${esc(d.emp_name)}</td>
        <td class="lbl">Phone</td>
        <td class="val">${esc(d.emp_phone)}</td>
      </tr>
      <tr>
        <td class="lbl">Employer Address</td>
        <td class="val" colspan="5">${esc([d.emp_street, d.emp_city, d.emp_state, d.emp_zip].filter(Boolean).join(', '))}</td>
      </tr>
      <tr>
        <td class="lbl">Position or Title</td>
        <td class="val">${esc(d.emp_title)}</td>
        <td class="lbl">Start Date</td>
        <td class="val">${esc(fmtDate(d.emp_start))}</td>
        <td class="lbl">Time in Line of Work</td>
        <td class="val">${esc(d.emp_years)} yrs ${esc(d.emp_months)} mos</td>
      </tr>
      <tr>
        <td class="lbl">Employment Status</td>
        <td class="val" colspan="5">
          <span class="opt"><span class="chk">${chk(!d.self_employed)}</span>Employed by Company</span>
          <span class="opt"><span class="chk">${chk(!!d.self_employed)}</span>Self-Employed / Owns 25%+ of Business</span>
        </td>
      </tr>
    </table>
  `;

  const section1e = `
    <div class="sect">Section 1e. Gross Monthly Income</div>
    <table>
      <tr><td class="lbl" style="width:60%">Base</td><td class="val">${esc(fmtMoney(d.base_income))} /month</td></tr>
      <tr><td class="lbl">Overtime</td><td class="val">${esc(fmtMoney(d.overtime_income))} /month</td></tr>
      <tr><td class="lbl">Bonus</td><td class="val">${esc(fmtMoney(d.bonus_income))} /month</td></tr>
      <tr><td class="lbl">Commission</td><td class="val">${esc(fmtMoney(d.commission_income))} /month</td></tr>
      <tr><td class="lbl">Military Entitlements</td><td class="val">${esc(fmtMoney(d.military_income))} /month</td></tr>
      <tr><td class="lbl">Other</td><td class="val">${esc(fmtMoney(d.other_income))} /month</td></tr>
      <tr><td class="lbl" style="background:#333;color:#fff">TOTAL</td><td class="val" style="font-weight:bold;background:#f5f5f5">${esc(fmtMoney(totalIncome))} /month</td></tr>
    </table>
  `;

  const section4a = `
    <div class="sect">Section 4a. Loan and Property Information</div>
    <table>
      <tr>
        <td class="lbl">Loan Amount</td>
        <td class="val">${esc(fmtMoney(d.loan_amount))}</td>
        <td class="lbl">Loan Purpose</td>
        <td class="val" colspan="3">
          <span class="opt"><span class="chk">${chk((d.loan_purpose || '').toLowerCase() === 'purchase')}</span>Purchase</span>
          <span class="opt"><span class="chk">${chk((d.loan_purpose || '').toLowerCase() === 'refinance')}</span>Refinance</span>
          <span class="opt"><span class="chk">${chk((d.loan_purpose || '').toLowerCase() === 'other')}</span>Other</span>
        </td>
      </tr>
      <tr>
        <td class="lbl">Property Address Street</td>
        <td class="val" colspan="5">${esc(d.prop_street)}</td>
      </tr>
      <tr>
        <td class="lbl">City</td>
        <td class="val">${esc(d.prop_city)}</td>
        <td class="lbl">State</td>
        <td class="val">${esc(d.prop_state)}</td>
        <td class="lbl">ZIP</td>
        <td class="val">${esc(d.prop_zip)}</td>
      </tr>
      <tr>
        <td class="lbl">County</td>
        <td class="val">${esc(d.prop_county)}</td>
        <td class="lbl"># Units</td>
        <td class="val">${esc(d.num_units || 1)}</td>
        <td class="lbl">Property Value</td>
        <td class="val">${esc(fmtMoney(d.prop_value))}</td>
      </tr>
      <tr>
        <td class="lbl">Occupancy</td>
        <td class="val" colspan="5">
          <span class="opt"><span class="chk">${chk(d.occupancy === 'Primary Residence')}</span>Primary Residence</span>
          <span class="opt"><span class="chk">${chk(d.occupancy === 'Second Home')}</span>Second Home</span>
          <span class="opt"><span class="chk">${chk(d.occupancy === 'Investment')}</span>Investment Property</span>
        </td>
      </tr>
    </table>
  `;

  const sectionL3 = `
    <div class="sect">Section L3. Mortgage Loan Information</div>
    <table>
      <tr>
        <td class="lbl">Loan Type</td>
        <td class="val" colspan="3">
          <span class="opt"><span class="chk">${chk(d.loan_type === 'Conventional')}</span>Conventional</span>
          <span class="opt"><span class="chk">${chk(d.loan_type === 'FHA')}</span>FHA</span>
          <span class="opt"><span class="chk">${chk(d.loan_type === 'VA')}</span>VA</span>
          <span class="opt"><span class="chk">${chk(d.loan_type === 'USDA-RD')}</span>USDA-RD</span>
        </td>
      </tr>
      <tr>
        <td class="lbl">Note Rate</td>
        <td class="val">${esc(d.current_interest_rate ? d.current_interest_rate + '%' : '')}</td>
        <td class="lbl">Loan Term</td>
        <td class="val">${esc(d.loan_term_months)} months</td>
      </tr>
    </table>
  `;

  const section5 = (() => {
    const q: Array<[string, any]> = [
      ['A. Will you occupy the property as your primary residence?', d.decl_primary],
      ['B. Have you had an ownership interest in another property in the last three years?', d.decl_prior_ownership],
      ['F. Are you a co-signer or guarantor on any debt or loan that is not disclosed?', d.decl_cosigner],
      ['G. Are there any outstanding judgments against you?', d.decl_judgments],
      ['H. Are you currently delinquent or in default on a federal debt?', d.decl_delinquent],
      ['I. Are you a party to a lawsuit in which you may be liable?', d.decl_lawsuit],
      ['J. Have you conveyed title to any property in lieu of foreclosure in the past 7 years?', d.decl_deed_in_lieu],
      ['K. Within the past 7 years, have you completed a pre-foreclosure sale / short sale?', d.decl_short_sale],
      ['L. Have you had property foreclosed upon in the last 7 years?', d.decl_foreclosure],
      ['M. Have you declared bankruptcy within the past 7 years?', d.decl_bankruptcy],
    ];
    return `
      <div class="sect">Section 5. Declarations — About this Property and Your Money for this Loan</div>
      ${q.map(([label, ans]) => `
        <div class="decl">
          <span>${esc(label)}</span>
          <span>
            <span class="opt"><span class="chk">${chk(!!ans)}</span>YES</span>
            <span class="opt"><span class="chk">${chk(!ans)}</span>NO</span>
          </span>
        </div>
      `).join('')}
      ${d.decl_bankruptcy ? `
      <div class="decl">
        <span>Bankruptcy Type:</span>
        <span>
          ${['Chapter 7', 'Chapter 11', 'Chapter 12', 'Chapter 13'].map(t => `<span class="opt"><span class="chk">${chk(d.bankruptcy_type === t)}</span>${t}</span>`).join('')}
        </span>
      </div>` : ''}
    `;
  })();

  const section7 = `
    <div class="sect">Section 7. Military Service</div>
    <div class="decl">
      <span>Did you (or your deceased spouse) serve, or are you currently serving, in the U.S. Armed Forces?</span>
      <span>
        <span class="opt"><span class="chk">${chk(!!d.military_service)}</span>YES</span>
        <span class="opt"><span class="chk">${chk(!d.military_service)}</span>NO</span>
      </span>
    </div>
    ${d.military_service ? `
    <table>
      <tr>
        <td class="lbl">Status</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk(d.military_status === 'Currently serving')}</span>Currently Serving</span>
          <span class="opt"><span class="chk">${chk(d.military_status === 'Veteran')}</span>Retired/Discharged</span>
          <span class="opt"><span class="chk">${chk(d.military_status === 'Reserve/National Guard')}</span>Non-Activated Reserve</span>
          <span class="opt"><span class="chk">${chk(d.military_status === 'Surviving spouse')}</span>Surviving Spouse</span>
        </td>
      </tr>
    </table>` : ''}
  `;

  const section9 = `
    <div class="sect">Section 9. Loan Originator Information</div>
    <table>
      <tr>
        <td class="lbl">Loan Originator Organization Name</td>
        <td class="val" colspan="3">E Mortgage Capital / Rates &amp; Realty</td>
      </tr>
      <tr>
        <td class="lbl">Organization Address</td>
        <td class="val" colspan="3">Huntington Beach, CA</td>
      </tr>
      <tr>
        <td class="lbl">Organization NMLSR ID#</td>
        <td class="val">1416824</td>
        <td class="lbl">State License ID#</td>
        <td class="val">—</td>
      </tr>
      <tr>
        <td class="lbl">Loan Originator Name</td>
        <td class="val">Rene Duarte</td>
        <td class="lbl">Loan Originator NMLSR ID#</td>
        <td class="val">1795044</td>
      </tr>
      <tr>
        <td class="lbl">Email</td>
        <td class="val">rene@ratesandrealty.com</td>
        <td class="lbl">Phone</td>
        <td class="val">(714) 472-8508</td>
      </tr>
    </table>

    <div style="margin-top:30pt">
      <div style="font-size:8pt;color:#333;margin-bottom:4pt">Signature of Borrower</div>
      <div style="border-bottom:0.5pt solid #000;height:30pt;width:60%"></div>
      <div style="font-size:8pt;margin-top:4pt">Date: ________________</div>
    </div>
  `;

  const footer = (pg: number, total: number) => `
    <div class="footer">
      <span>Uniform Residential Loan Application — Borrower: ${esc(fullName)}</span>
      <span>Page ${pg} of ${total}</span>
    </div>
  `;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>Uniform Residential Loan Application — ${esc(fullName)}</title>
<style>${css}</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">&#128424; Print / Save as PDF</button>

<div class="page">
  <h1>Uniform Residential Loan Application</h1>
  <div class="sub">Verify and complete the information on this application.</div>
  ${section1a}
  ${section1b}
  ${footer(1, 3)}
</div>

<div class="page">
  ${section1e}
  ${section4a}
  ${sectionL3}
  ${footer(2, 3)}
</div>

<div class="page">
  ${section5}
  ${section7}
  ${section9}
  ${footer(3, 3)}
</div>

<script>
  // Auto-open print dialog on load (client also triggers it via timeout)
  window.addEventListener('load', function() { setTimeout(function(){ try { window.print(); } catch(e){} }, 600); });
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

    // Merge into a flat view for the HTML builder
    const d: any = {
      first_name: app.first_name || c.first_name || '',
      middle_name: app.middle_name || '',
      last_name: app.last_name || c.last_name || '',
      suffix: app.suffix || '',
      ssn: app.ssn || '',
      date_of_birth: app.date_of_birth || c.date_of_birth || '',
      citizenship: app.citizenship || 'U.S. Citizen',
      marital_status: app.marital_status || '',
      dependents_count: app.dependents_count || '',
      dependents_ages: app.dependents_ages || '',
      cell_phone: app.cell_phone || c.phone || '',
      home_phone: app.home_phone || c.secondary_phone || '',
      work_phone: app.work_phone || '',
      email: app.email || c.email || '',
      cur_street: app.current_address_street || c.address || '',
      cur_unit: app.current_address_unit || '',
      cur_city: app.current_address_city || c.city || '',
      cur_state: app.current_address_state || c.state || '',
      cur_zip: app.current_address_zip || c.zip || '',
      cur_years: app.current_address_years || '',
      cur_months: app.current_address_months || '',
      cur_housing: app.current_housing || '',
      cur_rent: app.current_rent_amount || '',
      fmr_street: app.former_address_street || '',
      fmr_city: app.former_address_city || '',
      fmr_state: app.former_address_state || '',
      fmr_zip: app.former_address_zip || '',
      fmr_years: app.former_address_years || '',
      fmr_months: app.former_address_months || '',
      emp_name: app.employer_name || c.employer_name || '',
      emp_phone: app.employer_phone || '',
      emp_street: app.employer_street || '',
      emp_city: app.employer_city || '',
      emp_state: app.employer_state || '',
      emp_zip: app.employer_zip || '',
      emp_title: app.position_title || c.job_title || '',
      emp_start: app.employment_start_date || '',
      emp_years: app.years_in_line_of_work || c.years_employed || '',
      emp_months: app.months_in_line_of_work || '',
      self_employed: app.is_self_employed || false,
      base_income: app.base_income || '',
      overtime_income: app.overtime_income || '',
      bonus_income: app.bonus_income || '',
      commission_income: app.commission_income || '',
      military_income: app.military_income || '',
      other_income: app.other_income || '',
      total_income: app.total_monthly_income || c.monthly_income || '',
      loan_amount: app.loan_amount || c.loan_amount || '',
      loan_purpose: app.loan_purpose || '',
      loan_type: app.loan_type || c.loan_type || '',
      current_interest_rate: app.current_interest_rate || '',
      loan_term_months: app.loan_term_months || '',
      prop_street: app.property_address_street || '',
      prop_city: app.property_address_city || '',
      prop_state: app.property_address_state || '',
      prop_zip: app.property_address_zip || '',
      prop_county: app.property_address_county || c.county || '',
      num_units: app.number_of_units || '',
      prop_value: app.property_value || '',
      occupancy: app.occupancy_type || '',
      decl_primary: app.declaration_primary_residence || false,
      decl_prior_ownership: app.declaration_prior_ownership || false,
      decl_cosigner: app.declaration_cosigner || false,
      decl_judgments: app.declaration_judgments || false,
      decl_bankruptcy: app.declaration_bankruptcy || false,
      bankruptcy_type: app.bankruptcy_type || '',
      decl_foreclosure: app.declaration_foreclosure || false,
      decl_short_sale: app.declaration_short_sale || false,
      decl_deed_in_lieu: app.declaration_deed_in_lieu || false,
      decl_delinquent: app.declaration_delinquent || false,
      decl_lawsuit: app.declaration_lawsuit || false,
      military_service: app.military_service || false,
      military_status: app.military_status || '',
      co_borrower_first_name: app.co_borrower_first_name || '',
      co_borrower_last_name: app.co_borrower_last_name || '',
    };

    const html = buildHtml(d);
    // btoa only handles latin-1; encode utf-8 → bytes → base64
    const bytes = new TextEncoder().encode(html);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);

    const fileName = `1003_${(d.last_name || 'Borrower').replace(/\s/g, '_')}_${new Date().toISOString().slice(0, 10)}.html`;
    return new Response(JSON.stringify({ success: true, html: b64, file_name: fileName }), { headers: cors });
  } catch (err: any) {
    console.error('[generate-1003-pdf] Error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
});
