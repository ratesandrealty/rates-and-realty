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
  const fullName = [d.first_name, d.middle_name, d.last_name, d.suffix].filter(Boolean).join(' ') || '—';
  const coName = [d.co_borrower_first_name, d.co_borrower_last_name].filter(Boolean).join(' ');
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
    @page { size: letter; margin: 0.4in 0.35in 0.5in 0.35in; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 8.5pt; line-height: 1.25; background: #e8e8e8; }
    .page {
      background: #fff;
      width: 8.5in;
      min-height: 11in;
      padding: 0.45in 0.4in 0.55in 0.4in;
      margin: 12px auto;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      position: relative;
      page-break-after: always;
    }
    .page:last-child { page-break-after: auto; }
    .title-bar {
      border-bottom: 2pt solid #000;
      padding-bottom: 4pt;
      margin-bottom: 8pt;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .title-bar h1 { font-size: 13pt; margin: 0; font-weight: bold; letter-spacing: 0.3pt; }
    .title-bar .subttl { font-size: 7pt; color: #333; }
    .intro { font-size: 7.5pt; color: #444; margin-bottom: 8pt; font-style: italic; }
    .sect {
      background: #1f1f1f;
      color: #fff;
      padding: 4pt 7pt;
      font-weight: bold;
      font-size: 9pt;
      margin-top: 9pt;
      border: 0.75pt solid #000;
      text-transform: none;
    }
    .subsect {
      background: #4a4a4a;
      color: #fff;
      padding: 2pt 7pt;
      font-weight: bold;
      font-size: 8pt;
      border: 0.5pt solid #000;
      border-top: 0;
    }
    table { width: 100%; border-collapse: collapse; margin: 0; table-layout: fixed; }
    td {
      border: 0.5pt solid #000;
      padding: 3pt 5pt;
      vertical-align: top;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    td.lbl {
      background: #eaeaea;
      font-size: 6.5pt;
      font-weight: bold;
      color: #222;
      text-transform: uppercase;
      letter-spacing: 0.2pt;
      white-space: normal;
    }
    td.val {
      font-size: 8.5pt;
      min-height: 14pt;
      background: #fff;
    }
    td.val.empty::after { content: '\\00a0'; }
    .chk { font-family: 'Segoe UI Symbol', 'DejaVu Sans', 'Arial Unicode MS', sans-serif; font-size: 10pt; margin-right: 2pt; }
    .opt { display: inline-block; margin-right: 10pt; font-size: 8pt; white-space: nowrap; }
    .decl {
      border: 0.5pt solid #000;
      border-top: 0;
      padding: 3pt 7pt;
      font-size: 8pt;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10pt;
    }
    .decl:first-of-type { border-top: 0.5pt solid #000; }
    .decl > span:first-child { flex: 1; }
    .decl .yn { white-space: nowrap; }
    .ack {
      border: 0.5pt solid #000;
      padding: 6pt 8pt;
      font-size: 7pt;
      text-align: justify;
      line-height: 1.35;
    }
    .ack p { margin: 0 0 4pt 0; }
    .sig-row {
      display: flex;
      gap: 14pt;
      margin-top: 10pt;
    }
    .sig-box { flex: 1; }
    .sig-box .line { border-bottom: 0.75pt solid #000; height: 22pt; }
    .sig-box .lbl2 { font-size: 7pt; color: #333; margin-top: 2pt; }
    .page-footer {
      position: absolute;
      bottom: 0.22in;
      left: 0.4in;
      right: 0.4in;
      font-size: 6.5pt;
      color: #444;
      border-top: 0.5pt solid #888;
      padding-top: 3pt;
      display: flex;
      justify-content: space-between;
    }
    .print-btn {
      position: fixed;
      top: 12px;
      right: 12px;
      background: #C9A84C;
      color: #000;
      padding: 9px 18px;
      border: none;
      border-radius: 4px;
      font-weight: bold;
      cursor: pointer;
      font-size: 13px;
      z-index: 9999;
      box-shadow: 0 2px 6px rgba(0,0,0,0.25);
    }
    @media print {
      body { background: #fff; }
      .page {
        margin: 0;
        box-shadow: none;
        width: auto;
        min-height: auto;
        padding: 0;
      }
      .print-btn { display: none !important; }
    }
  `;

  // label/value cell pair builder
  const c = (lbl: string, val: string, colspan = 1) =>
    `<td class="lbl">${lbl}</td><td class="val"${colspan > 1 ? ` colspan="${colspan}"` : ''}>${val || '&nbsp;'}</td>`;

  // ─── Section 1a. Personal Information ───────────────────────────────────
  const section1a = `
    <div class="sect">Section 1a. Personal Information</div>
    <table>
      <colgroup><col style="width:18%"/><col style="width:15%"/><col style="width:18%"/><col style="width:15%"/><col style="width:16%"/><col style="width:18%"/></colgroup>
      <tr>
        <td class="lbl">Name (First, Middle, Last, Suffix)</td>
        <td class="val" colspan="5">${esc(fullName)}</td>
      </tr>
      <tr>
        <td class="lbl">Social Security Number</td>
        <td class="val">${esc(fmtSSN(d.ssn))}</td>
        <td class="lbl">Date of Birth (mm/dd/yyyy)</td>
        <td class="val">${esc(fmtDate(d.date_of_birth))}</td>
        <td class="lbl">Citizenship</td>
        <td class="val">
          <div><span class="chk">${chk(d.citizenship === 'U.S. Citizen')}</span>U.S. Citizen</div>
          <div><span class="chk">${chk(d.citizenship === 'Permanent Resident Alien')}</span>Permanent Resident Alien</div>
          <div><span class="chk">${chk(d.citizenship === 'Non-Permanent Resident Alien')}</span>Non-Permanent Resident</div>
        </td>
      </tr>
      <tr>
        <td class="lbl">Marital Status</td>
        <td class="val" colspan="3">
          <span class="opt"><span class="chk">${chk((d.marital_status || '').toLowerCase() === 'married')}</span>Married</span>
          <span class="opt"><span class="chk">${chk((d.marital_status || '').toLowerCase() === 'separated')}</span>Separated</span>
          <span class="opt"><span class="chk">${chk(['unmarried', 'single', 'divorced'].includes((d.marital_status || '').toLowerCase()))}</span>Unmarried</span>
        </td>
        <td class="lbl">Dependents (not listed by another Borrower)</td>
        <td class="val">Number: ${esc(d.dependents_count) || '&nbsp;'}<br/>Ages: ${esc(d.dependents_ages) || '&nbsp;'}</td>
      </tr>
      <tr>
        <td class="lbl">Contact — Home Phone</td>
        <td class="val">${esc(d.home_phone)}</td>
        <td class="lbl">Cell Phone</td>
        <td class="val">${esc(d.cell_phone)}</td>
        <td class="lbl">Work Phone</td>
        <td class="val">${esc(d.work_phone)}</td>
      </tr>
      <tr>
        <td class="lbl">Email</td>
        <td class="val" colspan="5">${esc(d.email)}</td>
      </tr>
      <tr>
        <td class="lbl">Current Address — Street</td>
        <td class="val" colspan="5">${esc([d.cur_street, d.cur_unit && 'Unit ' + d.cur_unit].filter(Boolean).join(' '))}</td>
      </tr>
      <tr>
        <td class="lbl">City</td>
        <td class="val">${esc(d.cur_city)}</td>
        <td class="lbl">State</td>
        <td class="val">${esc(d.cur_state)}</td>
        <td class="lbl">ZIP</td>
        <td class="val">${esc(d.cur_zip)}</td>
      </tr>
      <tr>
        <td class="lbl">How Long at Current Address</td>
        <td class="val">${esc(d.cur_years || 0)} Years&nbsp;&nbsp;${esc(d.cur_months || 0)} Months</td>
        <td class="lbl">Housing</td>
        <td class="val" colspan="3">
          <span class="opt"><span class="chk">${chk(d.cur_housing === 'No primary housing expense')}</span>No Primary Housing Expense</span>
          <span class="opt"><span class="chk">${chk(d.cur_housing === 'Own')}</span>Own</span>
          <span class="opt"><span class="chk">${chk(d.cur_housing === 'Rent')}</span>Rent (${esc(fmtMoney(d.cur_rent)) || '$___'}/mo)</span>
        </td>
      </tr>
      ${(d.fmr_street || d.fmr_city) ? `
      <tr>
        <td class="lbl">Former Address</td>
        <td class="val" colspan="3">${esc([d.fmr_street, d.fmr_city, d.fmr_state, d.fmr_zip].filter(Boolean).join(', '))}</td>
        <td class="lbl">How Long</td>
        <td class="val">${esc(d.fmr_years || 0)} Yrs&nbsp;&nbsp;${esc(d.fmr_months || 0)} Mos</td>
      </tr>` : ''}
    </table>
  `;

  // ─── Section 1b. Current Employment ─────────────────────────────────────
  const section1b = `
    <div class="sect">Section 1b. Current Employment/Self-Employment and Income</div>
    <table>
      <colgroup><col style="width:18%"/><col style="width:32%"/><col style="width:18%"/><col style="width:32%"/></colgroup>
      <tr>
        <td class="lbl">Employer or Business Name</td>
        <td class="val">${esc(d.emp_name)}</td>
        <td class="lbl">Phone</td>
        <td class="val">${esc(d.emp_phone)}</td>
      </tr>
      <tr>
        <td class="lbl">Employer Address</td>
        <td class="val" colspan="3">${esc([d.emp_street, d.emp_city, d.emp_state, d.emp_zip].filter(Boolean).join(', '))}</td>
      </tr>
      <tr>
        <td class="lbl">Position or Title</td>
        <td class="val">${esc(d.emp_title)}</td>
        <td class="lbl">Start Date (mm/dd/yyyy)</td>
        <td class="val">${esc(fmtDate(d.emp_start))}</td>
      </tr>
      <tr>
        <td class="lbl">How long in this line of work?</td>
        <td class="val">${esc(d.emp_years || 0)} Yrs&nbsp;&nbsp;${esc(d.emp_months || 0)} Mos</td>
        <td class="lbl">Employment Status</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk(!d.self_employed)}</span>Employed by a Company</span><br/>
          <span class="opt"><span class="chk">${chk(!!d.self_employed)}</span>Self-Employed (owner of 25%+)</span>
        </td>
      </tr>
    </table>
  `;

  // ─── Section 1e. Gross Monthly Income ──────────────────────────────────
  const section1e = `
    <div class="sect">Section 1e. Income from This Employment — Gross Monthly</div>
    <table>
      <colgroup><col style="width:55%"/><col style="width:45%"/></colgroup>
      <tr><td class="lbl">Base</td><td class="val">${esc(fmtMoney(d.base_income)) || '&nbsp;'} /month</td></tr>
      <tr><td class="lbl">Overtime</td><td class="val">${esc(fmtMoney(d.overtime_income)) || '&nbsp;'} /month</td></tr>
      <tr><td class="lbl">Bonus</td><td class="val">${esc(fmtMoney(d.bonus_income)) || '&nbsp;'} /month</td></tr>
      <tr><td class="lbl">Commission</td><td class="val">${esc(fmtMoney(d.commission_income)) || '&nbsp;'} /month</td></tr>
      <tr><td class="lbl">Military Entitlements</td><td class="val">${esc(fmtMoney(d.military_income)) || '&nbsp;'} /month</td></tr>
      <tr><td class="lbl">Other</td><td class="val">${esc(fmtMoney(d.other_income)) || '&nbsp;'} /month</td></tr>
      <tr>
        <td class="lbl" style="background:#1f1f1f;color:#fff;font-size:8pt">TOTAL</td>
        <td class="val" style="font-weight:bold;background:#f5f5f5;font-size:9pt">${esc(fmtMoney(totalIncome)) || '$0.00'} /month</td>
      </tr>
    </table>
  `;

  // ─── Section 2. Assets & Liabilities ───────────────────────────────────
  const assets = Array.isArray(d.assets) ? d.assets : [];
  const liabilities = Array.isArray(d.liabilities) ? d.liabilities : [];
  const section2 = `
    <div class="sect">Section 2. Financial Information — Assets and Liabilities</div>
    <div class="subsect">2a. Assets — Bank Accounts, Retirement, and Other Accounts You Have</div>
    <table>
      <colgroup><col style="width:30%"/><col style="width:40%"/><col style="width:30%"/></colgroup>
      <tr><td class="lbl">Account Type</td><td class="lbl">Financial Institution</td><td class="lbl">Cash or Market Value</td></tr>
      ${assets.length ? assets.map((a: any) => `
      <tr>
        <td class="val">${esc(a.type || a.account_type)}</td>
        <td class="val">${esc(a.institution || a.bank)}</td>
        <td class="val">${esc(fmtMoney(a.value || a.balance))}</td>
      </tr>`).join('') : `
      <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
      <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>`}
    </table>
    <div class="subsect">2c. Liabilities — Credit Cards, Other Debts, and Leases That You Owe</div>
    <table>
      <colgroup><col style="width:22%"/><col style="width:30%"/><col style="width:16%"/><col style="width:16%"/><col style="width:16%"/></colgroup>
      <tr>
        <td class="lbl">Account Type</td>
        <td class="lbl">Company Name</td>
        <td class="lbl">Unpaid Balance</td>
        <td class="lbl">Monthly Payment</td>
        <td class="lbl">To be paid off at/before closing</td>
      </tr>
      ${liabilities.length ? liabilities.map((l: any) => `
      <tr>
        <td class="val">${esc(l.type)}</td>
        <td class="val">${esc(l.creditor || l.company)}</td>
        <td class="val">${esc(fmtMoney(l.balance))}</td>
        <td class="val">${esc(fmtMoney(l.payment))}</td>
        <td class="val">${l.payoff ? chk(true) + ' Yes' : chk(false) + ' No'}</td>
      </tr>`).join('') : `
      <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
      <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>`}
    </table>
  `;

  // ─── Section 3. Real Estate Owned ──────────────────────────────────────
  const reo = Array.isArray(d.reo) ? d.reo : [];
  const section3 = `
    <div class="sect">Section 3. Financial Information — Real Estate</div>
    <div class="subsect">3a. Property You Own</div>
    <table>
      <colgroup><col style="width:28%"/><col style="width:14%"/><col style="width:14%"/><col style="width:14%"/><col style="width:15%"/><col style="width:15%"/></colgroup>
      <tr>
        <td class="lbl">Address</td>
        <td class="lbl">Status (Sold/Retained/Pending Sale)</td>
        <td class="lbl">Intended Occupancy</td>
        <td class="lbl">Monthly Insurance, Taxes, HOA</td>
        <td class="lbl">Property Value</td>
        <td class="lbl">Monthly Rental Income</td>
      </tr>
      ${reo.length ? reo.map((r: any) => `
      <tr>
        <td class="val">${esc(r.address)}</td>
        <td class="val">${esc(r.status)}</td>
        <td class="val">${esc(r.occupancy)}</td>
        <td class="val">${esc(fmtMoney(r.monthly_expenses))}</td>
        <td class="val">${esc(fmtMoney(r.value))}</td>
        <td class="val">${esc(fmtMoney(r.rental_income))}</td>
      </tr>`).join('') : `
      <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>`}
    </table>
  `;

  // ─── Section 4. Loan and Property ──────────────────────────────────────
  const section4a = `
    <div class="sect">Section 4a. Loan and Property Information</div>
    <table>
      <colgroup><col style="width:18%"/><col style="width:32%"/><col style="width:18%"/><col style="width:32%"/></colgroup>
      <tr>
        <td class="lbl">Loan Amount</td>
        <td class="val">${esc(fmtMoney(d.loan_amount))}</td>
        <td class="lbl">Loan Purpose</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk((d.loan_purpose || '').toLowerCase() === 'purchase')}</span>Purchase</span>
          <span class="opt"><span class="chk">${chk((d.loan_purpose || '').toLowerCase() === 'refinance')}</span>Refinance</span>
          <span class="opt"><span class="chk">${chk((d.loan_purpose || '').toLowerCase() === 'other')}</span>Other</span>
        </td>
      </tr>
      <tr>
        <td class="lbl">Property Address — Street</td>
        <td class="val" colspan="3">${esc(d.prop_street)}</td>
      </tr>
      <tr>
        <td class="lbl">City</td>
        <td class="val">${esc(d.prop_city)}</td>
        <td class="lbl">State / ZIP</td>
        <td class="val">${esc([d.prop_state, d.prop_zip].filter(Boolean).join(' '))}</td>
      </tr>
      <tr>
        <td class="lbl">County</td>
        <td class="val">${esc(d.prop_county)}</td>
        <td class="lbl"># Units</td>
        <td class="val">${esc(d.num_units || 1)}</td>
      </tr>
      <tr>
        <td class="lbl">Property Value</td>
        <td class="val">${esc(fmtMoney(d.prop_value))}</td>
        <td class="lbl">Occupancy</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk(d.occupancy === 'Primary Residence')}</span>Primary Residence</span>
          <span class="opt"><span class="chk">${chk(d.occupancy === 'Second Home')}</span>Second Home</span>
          <span class="opt"><span class="chk">${chk(d.occupancy === 'Investment')}</span>Investment Property</span>
        </td>
      </tr>
    </table>
  `;

  // ─── Section L3. Mortgage Loan Information ─────────────────────────────
  const sectionL3 = `
    <div class="sect">Section L3. Mortgage Loan Information</div>
    <table>
      <colgroup><col style="width:18%"/><col style="width:82%"/></colgroup>
      <tr>
        <td class="lbl">Loan Type</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk(d.loan_type === 'Conventional')}</span>Conventional</span>
          <span class="opt"><span class="chk">${chk(d.loan_type === 'FHA')}</span>FHA</span>
          <span class="opt"><span class="chk">${chk(d.loan_type === 'VA')}</span>VA</span>
          <span class="opt"><span class="chk">${chk(d.loan_type === 'USDA-RD')}</span>USDA-RD</span>
          <span class="opt"><span class="chk">${chk(d.loan_type && !['Conventional','FHA','VA','USDA-RD'].includes(d.loan_type))}</span>Other</span>
        </td>
      </tr>
      <tr>
        <td class="lbl">Note Rate</td>
        <td class="val">${esc(d.current_interest_rate ? d.current_interest_rate + '%' : '')}&nbsp;&nbsp;&nbsp;<b>Loan Term:</b> ${esc(d.loan_term_months) || '&nbsp;'} months</td>
      </tr>
    </table>
  `;

  // ─── Section 5. Declarations ───────────────────────────────────────────
  const section5 = (() => {
    const q: Array<[string, any]> = [
      ['A. Will you occupy the property as your primary residence?', d.decl_primary],
      ['B. Have you had an ownership interest in another property in the last three years?', d.decl_prior_ownership],
      ['C. Are you borrowing any money for this transaction (not deposited) or obtaining money from another party (not the seller)?', d.decl_borrowed_funds],
      ['D. Have you or will you be applying for another mortgage loan on this property before closing?', d.decl_other_mortgage],
      ['E. Have you or will you be applying for new credit before closing?', d.decl_new_credit],
      ['F. Are you a co-signer or guarantor on any debt or loan that is not disclosed on this application?', d.decl_cosigner],
      ['G. Are there any outstanding judgments against you?', d.decl_judgments],
      ['H. Are you currently delinquent or in default on a Federal debt?', d.decl_delinquent],
      ['I. Are you a party to a lawsuit in which you may be personally liable?', d.decl_lawsuit],
      ['J. Have you conveyed title to any property in lieu of foreclosure in the past 7 years?', d.decl_deed_in_lieu],
      ['K. Within the past 7 years, have you completed a pre-foreclosure sale or short sale?', d.decl_short_sale],
      ['L. Have you had property foreclosed upon in the last 7 years?', d.decl_foreclosure],
      ['M. Have you declared bankruptcy within the past 7 years?', d.decl_bankruptcy],
    ];
    return `
      <div class="sect">Section 5. Declarations</div>
      ${q.map(([label, ans]) => `
        <div class="decl">
          <span>${esc(label)}</span>
          <span class="yn">
            <span class="opt"><span class="chk">${chk(!!ans)}</span>YES</span>
            <span class="opt"><span class="chk">${chk(!ans)}</span>NO</span>
          </span>
        </div>
      `).join('')}
      ${d.decl_bankruptcy ? `
      <div class="decl">
        <span>Identify the type(s) of bankruptcy:</span>
        <span class="yn">
          ${['Chapter 7', 'Chapter 11', 'Chapter 12', 'Chapter 13'].map(t => `<span class="opt"><span class="chk">${chk(d.bankruptcy_type === t)}</span>${t}</span>`).join('')}
        </span>
      </div>` : ''}
    `;
  })();

  // ─── Section 6. Acknowledgements and Agreements ────────────────────────
  const section6 = `
    <div class="sect">Section 6. Acknowledgements and Agreements</div>
    <div class="ack">
      <p><b>Definitions:</b> "Lender" includes the Lender's agents, service providers, and any of their successors and assigns. "Other Loan Participants" includes any actual or potential owners of a loan resulting from this application (the "Loan"), acquirers of any beneficial or other interest in the Loan, any mortgage insurer, guarantor, any servicers or service providers for these parties, and any of their successors and assigns.</p>
      <p><b>I agree to, acknowledge, and represent the following:</b></p>
      <p><b>(1) The Complete Information for this Application</b> — The information I have provided in this application is true, accurate, and complete as of the date I signed this application.</p>
      <p><b>(2) The Property's Security</b> — The Loan I have applied for in this application will be secured by a mortgage or deed of trust which provides the Lender a security interest in the property described in this application.</p>
      <p><b>(3) The Property's Appraisal, Value, and Condition</b> — Any appraisal or value of the property obtained by the Lender is for use by the Lender and Other Loan Participants. The Lender and Other Loan Participants have not made any representation or warranty, express or implied, regarding the property, its condition, or its value.</p>
      <p><b>(4) Electronic Records and Signatures</b> — The Lender and Other Loan Participants may keep any paper record and/or electronic record of this application, whether or not the Loan is approved. If this application is created as (or converted into) an "electronic application," I consent to the use of "electronic records" and "electronic signatures" as those terms are defined in applicable Federal and/or state laws.</p>
      <p><b>(5) Delinquency</b> — The Lender and Other Loan Participants may report information about my account to credit bureaus. Late payments, missed payments, or other defaults on my account may be reflected in my credit report and will likely affect my credit score.</p>
      <p><b>(6) Authorization for Use and Sharing of Information</b> — By signing below, I authorize the Lender and Other Loan Participants to: (a) process and underwrite this Loan application; (b) verify any information contained in this application and to obtain additional information necessary to evaluate this application; (c) share my information and the Loan with investors, servicers, third-party service providers, and their affiliates.</p>
    </div>
    <div class="sig-row">
      <div class="sig-box">
        <div class="line"></div>
        <div class="lbl2">Borrower Signature &nbsp;&nbsp;&nbsp; ${esc(fullName)}</div>
      </div>
      <div class="sig-box" style="flex:0 0 30%">
        <div class="line"></div>
        <div class="lbl2">Date</div>
      </div>
    </div>
  `;

  // ─── Section 7. Military Service ───────────────────────────────────────
  const section7 = `
    <div class="sect">Section 7. Military Service</div>
    <div class="decl">
      <span>Did you (or your deceased spouse) ever serve, or are you currently serving, in the United States Armed Forces?</span>
      <span class="yn">
        <span class="opt"><span class="chk">${chk(!!d.military_service)}</span>YES</span>
        <span class="opt"><span class="chk">${chk(!d.military_service)}</span>NO</span>
      </span>
    </div>
    ${d.military_service ? `
    <table style="border-top:0">
      <tr>
        <td class="lbl">Status</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk(d.military_status === 'Currently serving')}</span>Currently Serving on Active Duty</span>
          <span class="opt"><span class="chk">${chk(d.military_status === 'Veteran')}</span>Retired, Discharged, or Separated</span>
          <span class="opt"><span class="chk">${chk(d.military_status === 'Reserve/National Guard')}</span>Non-Activated Reserve/National Guard</span>
          <span class="opt"><span class="chk">${chk(d.military_status === 'Surviving spouse')}</span>Surviving Spouse</span>
        </td>
      </tr>
    </table>` : ''}
  `;

  // ─── Section 8. Demographics ───────────────────────────────────────────
  const section8 = `
    <div class="sect">Section 8. Demographic Information</div>
    <div class="ack" style="border-bottom:0">
      <p>The purpose of collecting this information is to help ensure that all applicants are treated fairly and that the housing needs of communities and neighborhoods are being fulfilled. For residential mortgage lending, Federal law requires that we ask applicants for their demographic information (ethnicity, sex, and race) in order to monitor our compliance with equal credit opportunity, fair housing, and home mortgage disclosure laws. You are not required to provide this information, but are encouraged to do so.</p>
    </div>
    <table>
      <colgroup><col style="width:33%"/><col style="width:34%"/><col style="width:33%"/></colgroup>
      <tr>
        <td class="lbl">Ethnicity — Check one or more</td>
        <td class="lbl">Race — Check one or more</td>
        <td class="lbl">Sex</td>
      </tr>
      <tr>
        <td class="val">
          <div><span class="chk">${chk(d.ethnicity === 'Hispanic or Latino')}</span>Hispanic or Latino</div>
          <div><span class="chk">${chk(d.ethnicity === 'Not Hispanic or Latino')}</span>Not Hispanic or Latino</div>
          <div><span class="chk">${chk(d.ethnicity === 'Do not wish to provide' || !d.ethnicity)}</span>I do not wish to provide this information</div>
        </td>
        <td class="val">
          <div><span class="chk">${chk(d.race === 'American Indian or Alaska Native')}</span>American Indian or Alaska Native</div>
          <div><span class="chk">${chk(d.race === 'Asian')}</span>Asian</div>
          <div><span class="chk">${chk(d.race === 'Black or African American')}</span>Black or African American</div>
          <div><span class="chk">${chk(d.race === 'Native Hawaiian or Other Pacific Islander')}</span>Native Hawaiian or Other Pacific Islander</div>
          <div><span class="chk">${chk(d.race === 'White')}</span>White</div>
          <div><span class="chk">${chk(d.race === 'Do not wish to provide' || !d.race)}</span>I do not wish to provide this information</div>
        </td>
        <td class="val">
          <div><span class="chk">${chk(d.sex === 'Female')}</span>Female</div>
          <div><span class="chk">${chk(d.sex === 'Male')}</span>Male</div>
          <div><span class="chk">${chk(d.sex === 'Do not wish to provide' || !d.sex)}</span>I do not wish to provide this information</div>
        </td>
      </tr>
    </table>
  `;

  // ─── Section 9. Loan Originator Information ────────────────────────────
  const section9 = `
    <div class="sect">Section 9. Loan Originator Information</div>
    <table>
      <colgroup><col style="width:25%"/><col style="width:25%"/><col style="width:25%"/><col style="width:25%"/></colgroup>
      <tr>
        <td class="lbl">Loan Originator Organization Name</td>
        <td class="val" colspan="3">E Mortgage Capital, Inc. / Rates &amp; Realty</td>
      </tr>
      <tr>
        <td class="lbl">Address</td>
        <td class="val" colspan="3">Huntington Beach, CA</td>
      </tr>
      <tr>
        <td class="lbl">Organization NMLSR ID#</td>
        <td class="val">1416824</td>
        <td class="lbl">State License ID#</td>
        <td class="val">&mdash;</td>
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
      <tr>
        <td class="lbl">Signature</td>
        <td class="val" colspan="2"><div style="height:22pt;border-bottom:0.5pt solid #000"></div></td>
        <td class="lbl">Date</td>
      </tr>
    </table>
  `;

  const pageFooter = (pg: number, total: number) => `
    <div class="page-footer">
      <span>Borrower Name: ${esc(fullName)}</span>
      <span>Uniform Residential Loan Application &mdash; Freddie Mac Form 65 / Fannie Mae Form 1003</span>
      <span>Page ${pg} of ${total}</span>
    </div>
  `;

  const titleBar = `
    <div class="title-bar">
      <h1>Uniform Residential Loan Application</h1>
      <div class="subttl">Freddie Mac Form 65 &bull; Fannie Mae Form 1003<br/>Effective 1/2021</div>
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
  ${titleBar}
  <div class="intro">Verify and complete the information on this application. If you are applying for this loan with others, each additional Borrower must provide information as directed by your Lender.</div>
  ${section1a}
  ${section1b}
  ${section1e}
  ${pageFooter(1, 4)}
</div>

<div class="page">
  ${section2}
  ${section3}
  ${pageFooter(2, 4)}
</div>

<div class="page">
  ${section4a}
  ${sectionL3}
  ${section5}
  ${pageFooter(3, 4)}
</div>

<div class="page">
  ${section6}
  ${section7}
  ${section8}
  ${section9}
  ${pageFooter(4, 4)}
</div>

<script>
  window.addEventListener('load', function() { setTimeout(function(){ try { window.print(); } catch(e){} }, 700); });
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
      assets: app.assets || [],
      liabilities: app.liabilities || [],
      reo: app.real_estate_owned || [],
      decl_primary: app.declaration_primary_residence || false,
      decl_prior_ownership: app.declaration_prior_ownership || false,
      decl_borrowed_funds: app.declaration_borrowed_funds || false,
      decl_other_mortgage: app.declaration_other_mortgage || false,
      decl_new_credit: app.declaration_new_credit || false,
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
      ethnicity: app.demographic_ethnicity || '',
      race: app.demographic_race || '',
      sex: app.demographic_sex || '',
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
