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
  const coName = [d.co_borrower_first_name, d.co_borrower_middle_name, d.co_borrower_last_name, d.co_borrower_suffix].filter(Boolean).join(' ');

  // Normalize citizenship — DB stores snake_case
  const citRaw = String(d.citizenship || '').toLowerCase().replace(/[^a-z]/g, '');
  const isCitizen = citRaw === 'uscitizen' || citRaw === 'usacitizen';
  const isPermRes = citRaw === 'permanentresidentalien' || citRaw === 'permanentresident';
  const isNonPermRes = citRaw === 'nonpermanentresidentalien' || citRaw === 'nonpermanentresident';

  const totalIncome = d.total_income || (
    (parseFloat(d.base_income) || 0) +
    (parseFloat(d.overtime_income) || 0) +
    (parseFloat(d.bonus_income) || 0) +
    (parseFloat(d.commission_income) || 0) +
    (parseFloat(d.military_income) || 0) +
    (parseFloat(d.other_income) || 0)
  );

  const css = `
    @page { size: letter; margin: 0.4in 0.35in 0.55in 0.35in; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 8.5pt; line-height: 1.25; background: #e8e8e8; }
    .page {
      background: #fff;
      width: 8.5in;
      min-height: 11in;
      padding: 0.45in 0.4in 0.6in 0.4in;
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
    .title-bar .subttl { font-size: 7pt; color: #333; text-align: right; }
    .intro { font-size: 7.5pt; color: #444; margin-bottom: 8pt; font-style: italic; }
    .sect {
      background: #1a1a2e;
      color: #fff;
      padding: 5pt 8pt;
      font-weight: bold;
      font-size: 9pt;
      margin-top: 9pt;
      border: 0.75pt solid #000;
      font-variant: small-caps;
      letter-spacing: 0.4pt;
    }
    .subsect {
      background: #3a3a52;
      color: #fff;
      padding: 2pt 8pt;
      font-weight: bold;
      font-size: 8pt;
      border: 0.5pt solid #000;
      border-top: 0;
      font-variant: small-caps;
    }
    .lender-bar {
      background: #d8d8d8;
      border: 0.75pt solid #000;
      padding: 5pt 8pt;
      font-size: 7.5pt;
      display: flex;
      gap: 14pt;
      margin-bottom: 6pt;
    }
    .lender-bar .fld { flex: 1; }
    .lender-bar .fld b { text-transform: uppercase; font-size: 6.5pt; letter-spacing: 0.2pt; }
    .lender-bar .fld .v { border-bottom: 0.5pt solid #000; min-height: 12pt; padding-top: 1pt; }
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
      font-size: 6.8pt;
      text-align: justify;
      line-height: 1.35;
    }
    .ack p { margin: 0 0 4pt 0; }
    .ack .cols { column-count: 2; column-gap: 14pt; }
    .sig-row { display: flex; gap: 14pt; margin-top: 10pt; }
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
      top: 10px;
      right: 14px;
      background: #C9A84C;
      color: #1a1a1a;
      padding: 6px 12px;
      border: 0.5pt solid #a88a3a;
      border-radius: 3px;
      font-weight: 600;
      cursor: pointer;
      font-size: 11px;
      z-index: 9999;
      box-shadow: 0 1px 3px rgba(0,0,0,0.18);
      opacity: 0.92;
      font-family: Arial, Helvetica, sans-serif;
    }
    .print-btn:hover { opacity: 1; }
    @media print {
      body { background: #fff; }
      .page { margin: 0; box-shadow: none; width: auto; min-height: auto; padding: 0.3in; }
      .no-print { display: none !important; }
    }
  `;

  const titleBar = `
    <div class="title-bar">
      <h1>Uniform Residential Loan Application</h1>
      <div class="subttl">Freddie Mac Form 65 &bull; Fannie Mae Form 1003<br/>Effective 1/2021</div>
    </div>
  `;

  const pageFooter = (pg: number, total: number) => `
    <div class="page-footer">
      <span>Borrower Name: ${esc(fullName)}</span>
      <span>Uniform Residential Loan Application &mdash; Freddie Mac Form 65 &bull; Fannie Mae Form 1003</span>
      <span>Page ${pg} of ${total}</span>
    </div>
  `;

  // ─── Lender Loan Bar (top of page 1) ───────────────────────────────────
  const lenderBar = `
    <div class="lender-bar">
      <div class="fld"><b>To be completed by the Lender:</b></div>
      <div class="fld"><b>Lender Loan No./Universal Loan Identifier</b><div class="v">&nbsp;</div></div>
      <div class="fld"><b>Agency Case No.</b><div class="v">&nbsp;</div></div>
    </div>
  `;

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
        <td class="lbl">Type of Credit</td>
        <td class="val" colspan="3">
          <span class="opt"><span class="chk">${chk(!coName)}</span>I am applying for individual credit</span>
          <span class="opt"><span class="chk">${chk(!!coName)}</span>I am applying for joint credit. Total Number of Borrowers: ${coName ? 2 : 1}</span>
        </td>
        <td class="lbl">Initials (each Borrower)</td>
        <td class="val">&nbsp;</td>
      </tr>
      <tr>
        <td class="lbl">List Name(s) of Other Borrower(s) on this Application</td>
        <td class="val" colspan="5">${esc(coName) || '&nbsp;'}</td>
      </tr>
      <tr>
        <td class="lbl">Social Security Number</td>
        <td class="val">${esc(fmtSSN(d.ssn))}</td>
        <td class="lbl">Date of Birth (mm/dd/yyyy)</td>
        <td class="val">${esc(fmtDate(d.date_of_birth))}</td>
        <td class="lbl">Citizenship</td>
        <td class="val">
          <div><span class="chk">${chk(isCitizen)}</span>U.S. Citizen</div>
          <div><span class="chk">${chk(isPermRes)}</span>Permanent Resident Alien</div>
          <div><span class="chk">${chk(isNonPermRes)}</span>Non-Permanent Resident</div>
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
      <tr>
        <td class="lbl">Mailing Address — if different from Current</td>
        <td class="val" colspan="5">${esc(d.mailing_address) || '&nbsp;'}</td>
      </tr>
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
          <div><span class="chk">${chk(!d.self_employed)}</span>Employed by a Company</div>
          <div><span class="chk">${chk(!!d.self_employed)}</span>Self-Employed (owner of 25%+)</div>
        </td>
      </tr>
      <tr>
        <td class="lbl">Gross Monthly Income — Base</td>
        <td class="val">${esc(fmtMoney(d.base_income)) || '&nbsp;'}</td>
        <td class="lbl">Overtime / Bonus / Commission</td>
        <td class="val">
          OT: ${esc(fmtMoney(d.overtime_income)) || '—'}&nbsp;&nbsp;
          Bonus: ${esc(fmtMoney(d.bonus_income)) || '—'}&nbsp;&nbsp;
          Comm: ${esc(fmtMoney(d.commission_income)) || '—'}
        </td>
      </tr>
      <tr>
        <td class="lbl">Military Entitlements</td>
        <td class="val">${esc(fmtMoney(d.military_income)) || '&nbsp;'}</td>
        <td class="lbl">Other</td>
        <td class="val">${esc(fmtMoney(d.other_income)) || '&nbsp;'}</td>
      </tr>
      <tr>
        <td class="lbl" style="background:#1a1a2e;color:#fff;font-size:8pt">TOTAL GROSS MONTHLY INCOME</td>
        <td class="val" colspan="3" style="font-weight:bold;background:#f5f5f5;font-size:9pt">${esc(fmtMoney(totalIncome)) || '$0.00'} /month</td>
      </tr>
    </table>
  `;

  // ─── Section 1c. Additional Employment ──────────────────────────────────
  const section1c = `
    <div class="sect">Section 1c. IF APPLICABLE, Complete Information for Additional Employment/Self-Employment and Income</div>
    <table>
      <colgroup><col style="width:18%"/><col style="width:32%"/><col style="width:18%"/><col style="width:32%"/></colgroup>
      <tr><td class="lbl">Employer or Business Name</td><td class="val empty"></td><td class="lbl">Phone</td><td class="val empty"></td></tr>
      <tr><td class="lbl">Employer Address</td><td class="val empty" colspan="3"></td></tr>
      <tr><td class="lbl">Position or Title</td><td class="val empty"></td><td class="lbl">Start Date</td><td class="val empty"></td></tr>
      <tr><td class="lbl">How long in this line of work?</td><td class="val empty"></td><td class="lbl">Employment Status</td>
        <td class="val"><div><span class="chk">${chk(false)}</span>Employed by a Company</div><div><span class="chk">${chk(false)}</span>Self-Employed</div></td></tr>
      <tr><td class="lbl">Gross Monthly Income — Base</td><td class="val empty"></td><td class="lbl">Other</td><td class="val empty"></td></tr>
    </table>
  `;

  // ─── Section 1d. Previous Employment ────────────────────────────────────
  const section1d = `
    <div class="sect">Section 1d. IF APPLICABLE, Complete Information for Previous Employment/Self-Employment and Income</div>
    <table>
      <colgroup><col style="width:18%"/><col style="width:32%"/><col style="width:18%"/><col style="width:32%"/></colgroup>
      <tr><td class="lbl">Previous Employer or Business Name</td><td class="val empty"></td><td class="lbl">End Date</td><td class="val empty"></td></tr>
      <tr><td class="lbl">Employer Address</td><td class="val empty" colspan="3"></td></tr>
      <tr><td class="lbl">Position or Title</td><td class="val empty"></td><td class="lbl">Start Date</td><td class="val empty"></td></tr>
      <tr><td class="lbl">Employment Status</td><td class="val" colspan="3">
        <span class="opt"><span class="chk">${chk(false)}</span>Employed by a Company</span>
        <span class="opt"><span class="chk">${chk(false)}</span>Self-Employed</span>
      </td></tr>
      <tr><td class="lbl">Previous Gross Monthly Income</td><td class="val empty" colspan="3"></td></tr>
    </table>
  `;

  // ─── Section 1e. Income from Other Sources ──────────────────────────────
  const otherIncomeSources = [
    'Alimony', 'Automobile Allowance', 'Boarder Income', 'Capital Gains',
    'Child Support', 'Disability', 'Foster Care', 'Housing or Parsonage',
    'Interest and Dividends', 'Mortgage Credit Certificate', 'Mortgage Differential Payments',
    'Notes Receivable', 'Public Assistance', 'Retirement (e.g., Pension, IRA)',
    'Royalty Payments', 'Separate Maintenance', 'Social Security', 'Trust',
    'Unemployment Benefits', 'VA Compensation', 'Other'
  ];
  const section1e = `
    <div class="sect">Section 1e. Income from Other Sources</div>
    <div class="subsect">Do not include the income from Section 1b or 1c. NOTE: Reveal alimony, child support, separate maintenance, or other income ONLY IF you want it considered in repaying this loan.</div>
    <table>
      <colgroup><col style="width:60%"/><col style="width:40%"/></colgroup>
      <tr><td class="lbl">Income Source — Use List Below</td><td class="lbl">Monthly Income</td></tr>
      <tr><td class="val empty"></td><td class="val empty"></td></tr>
      <tr><td class="val empty"></td><td class="val empty"></td></tr>
      <tr><td class="val empty"></td><td class="val empty"></td></tr>
      <tr><td class="lbl" style="background:#1a1a2e;color:#fff;font-size:8pt">Provide TOTAL Amount Here</td><td class="val" style="font-weight:bold;background:#f5f5f5">&nbsp;</td></tr>
    </table>
    <div style="font-size:6.5pt;color:#333;padding:4pt 7pt;border:0.5pt solid #000;border-top:0">
      <b>Income Sources:</b> ${otherIncomeSources.join(' &bull; ')}
    </div>
  `;

  // ─── Section 2. Assets & Liabilities ───────────────────────────────────
  const assets = Array.isArray(d.assets) ? d.assets : [];
  const liabilities = Array.isArray(d.liabilities) ? d.liabilities : [];
  const section2a = `
    <div class="sect">Section 2a. Assets — Bank Accounts, Retirement, and Other Accounts You Have</div>
    <table>
      <colgroup><col style="width:30%"/><col style="width:40%"/><col style="width:30%"/></colgroup>
      <tr><td class="lbl">Account Type — Use List Below</td><td class="lbl">Financial Institution</td><td class="lbl">Cash or Market Value</td></tr>
      ${assets.length ? assets.map((a: any) => `
      <tr>
        <td class="val">${esc(a.type || a.account_type)}</td>
        <td class="val">${esc(a.institution || a.bank)}</td>
        <td class="val">${esc(fmtMoney(a.value || a.balance))}</td>
      </tr>`).join('') : `
      <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
      <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
      <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>`}
      <tr><td class="lbl" colspan="2" style="background:#1a1a2e;color:#fff;font-size:8pt">Provide TOTAL Amount Here</td>
          <td class="val" style="font-weight:bold;background:#f5f5f5">${esc(fmtMoney(assets.reduce((s: number, a: any) => s + (parseFloat(a.value || a.balance) || 0), 0))) || '&nbsp;'}</td></tr>
    </table>
    <div style="font-size:6.5pt;color:#333;padding:4pt 7pt;border:0.5pt solid #000;border-top:0">
      <b>Account Types:</b> Checking &bull; Savings &bull; Money Market &bull; Certificate of Deposit &bull; Mutual Fund &bull; Stocks &bull; Stock Options &bull; Bonds &bull; Retirement (401k, IRA) &bull; Bridge Loan Proceeds &bull; Individual Development Account &bull; Trust Account &bull; Cash Value of Life Insurance &bull; Other
    </div>
  `;

  const section2b = `
    <div class="sect">Section 2b. Other Assets and Credits You Have</div>
    <table>
      <colgroup><col style="width:60%"/><col style="width:40%"/></colgroup>
      <tr><td class="lbl">Asset or Credit Type — Use List Below</td><td class="lbl">Cash or Market Value</td></tr>
      <tr><td class="val empty"></td><td class="val empty"></td></tr>
      <tr><td class="val empty"></td><td class="val empty"></td></tr>
    </table>
    <div style="font-size:6.5pt;color:#333;padding:4pt 7pt;border:0.5pt solid #000;border-top:0">
      <b>Assets:</b> Proceeds from Real Estate Property to be sold on or before closing &bull; Proceeds from Sale of Non-Real Estate Asset &bull; Secured Borrowed Funds &bull; Unsecured Borrowed Funds &bull; Other
      <br/><b>Credits:</b> Earnest Money &bull; Employer Assistance &bull; Lot Equity &bull; Relocation Funds &bull; Rent Credit &bull; Sweat Equity &bull; Trade Equity &bull; Other
    </div>
  `;

  const section2c = `
    <div class="sect">Section 2c. Liabilities — Credit Cards, Other Debts, and Leases That You Owe</div>
    <table>
      <colgroup><col style="width:22%"/><col style="width:28%"/><col style="width:15%"/><col style="width:15%"/><col style="width:10%"/><col style="width:10%"/></colgroup>
      <tr>
        <td class="lbl">Account Type — Use List Below</td>
        <td class="lbl">Company Name</td>
        <td class="lbl">Account Number</td>
        <td class="lbl">Unpaid Balance</td>
        <td class="lbl">To be paid off at/before closing</td>
        <td class="lbl">Monthly Payment</td>
      </tr>
      ${liabilities.length ? liabilities.map((l: any) => `
      <tr>
        <td class="val">${esc(l.type)}</td>
        <td class="val">${esc(l.creditor || l.company)}</td>
        <td class="val">${esc(l.account_number)}</td>
        <td class="val">${esc(fmtMoney(l.balance))}</td>
        <td class="val">${l.payoff ? chk(true) + ' Yes' : chk(false) + ' No'}</td>
        <td class="val">${esc(fmtMoney(l.payment))}</td>
      </tr>`).join('') : `
      <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
      <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
      <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>`}
    </table>
    <div style="font-size:6.5pt;color:#333;padding:4pt 7pt;border:0.5pt solid #000;border-top:0">
      <b>Account Types:</b> Revolving (e.g., Credit Cards) &bull; Installment (e.g., Car, Student, Personal Loans) &bull; Open 30-Day (balance paid monthly) &bull; Lease (not real estate) &bull; Other
    </div>
  `;

  const section2d = `
    <div class="sect">Section 2d. Other Liabilities and Expenses</div>
    <table>
      <colgroup><col style="width:60%"/><col style="width:40%"/></colgroup>
      <tr><td class="lbl">Type — Use List Below</td><td class="lbl">Monthly Payment</td></tr>
      <tr><td class="val empty"></td><td class="val empty"></td></tr>
      <tr><td class="val empty"></td><td class="val empty"></td></tr>
    </table>
    <div style="font-size:6.5pt;color:#333;padding:4pt 7pt;border:0.5pt solid #000;border-top:0">
      <b>Types:</b> Alimony &bull; Child Support &bull; Separate Maintenance &bull; Job-Related Expenses &bull; Other
    </div>
  `;

  // ─── Section 3. Real Estate ────────────────────────────────────────────
  const reo = Array.isArray(d.reo) ? d.reo : [];
  const section3a = `
    <div class="sect">Section 3a. Property You Own — If you are refinancing, list the property you are refinancing FIRST</div>
    <table>
      <colgroup><col style="width:40%"/><col style="width:20%"/><col style="width:20%"/><col style="width:20%"/></colgroup>
      <tr>
        <td class="lbl">Address (Street, Unit #, City, State, ZIP)</td>
        <td class="lbl">Status (Sold, Pending Sale, or Retained)</td>
        <td class="lbl">Intended Occupancy (Investment, Primary, Second Home, Other)</td>
        <td class="lbl">Monthly Insurance, Taxes, Association Dues, etc. (if not included in Monthly Mortgage Payment)</td>
      </tr>
      <tr>
        <td class="val">${reo[0] ? esc(reo[0].address) : '&nbsp;'}</td>
        <td class="val">${reo[0] ? esc(reo[0].status) : '&nbsp;'}</td>
        <td class="val">${reo[0] ? esc(reo[0].occupancy) : '&nbsp;'}</td>
        <td class="val">${reo[0] ? esc(fmtMoney(reo[0].monthly_expenses)) : '&nbsp;'}</td>
      </tr>
      <tr>
        <td class="lbl">Property Value</td>
        <td class="lbl">For 2-4 Unit Primary or Investment Property — Monthly Rental Income</td>
        <td class="lbl">Monthly Rental Income — Net</td>
        <td class="lbl">For LENDER to calculate: Net Monthly Rental Income</td>
      </tr>
      <tr>
        <td class="val">${reo[0] ? esc(fmtMoney(reo[0].value)) : '&nbsp;'}</td>
        <td class="val">${reo[0] ? esc(fmtMoney(reo[0].rental_income)) : '&nbsp;'}</td>
        <td class="val">&nbsp;</td>
        <td class="val">&nbsp;</td>
      </tr>
    </table>
  `;

  const section3b = `
    <div class="sect">Section 3b. IF APPLICABLE, Complete Information for Additional Property</div>
    <table>
      <colgroup><col style="width:40%"/><col style="width:20%"/><col style="width:20%"/><col style="width:20%"/></colgroup>
      <tr><td class="lbl">Address</td><td class="lbl">Status</td><td class="lbl">Intended Occupancy</td><td class="lbl">Monthly Insurance/Taxes/HOA</td></tr>
      <tr>
        <td class="val">${reo[1] ? esc(reo[1].address) : '&nbsp;'}</td>
        <td class="val">${reo[1] ? esc(reo[1].status) : '&nbsp;'}</td>
        <td class="val">${reo[1] ? esc(reo[1].occupancy) : '&nbsp;'}</td>
        <td class="val">${reo[1] ? esc(fmtMoney(reo[1].monthly_expenses)) : '&nbsp;'}</td>
      </tr>
    </table>
  `;

  const section3c = `
    <div class="sect">Section 3c. IF APPLICABLE, Complete Information for Additional Property</div>
    <table>
      <colgroup><col style="width:40%"/><col style="width:20%"/><col style="width:20%"/><col style="width:20%"/></colgroup>
      <tr><td class="lbl">Address</td><td class="lbl">Status</td><td class="lbl">Intended Occupancy</td><td class="lbl">Monthly Insurance/Taxes/HOA</td></tr>
      <tr>
        <td class="val">${reo[2] ? esc(reo[2].address) : '&nbsp;'}</td>
        <td class="val">${reo[2] ? esc(reo[2].status) : '&nbsp;'}</td>
        <td class="val">${reo[2] ? esc(reo[2].occupancy) : '&nbsp;'}</td>
        <td class="val">${reo[2] ? esc(fmtMoney(reo[2].monthly_expenses)) : '&nbsp;'}</td>
      </tr>
    </table>
  `;

  // ─── Section 4. Loan and Property Information ──────────────────────────
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
        <td class="lbl">Number of Units</td>
        <td class="val">${esc(d.num_units || 1)}</td>
      </tr>
      <tr>
        <td class="lbl">Property Value</td>
        <td class="val">${esc(fmtMoney(d.prop_value))}</td>
        <td class="lbl">Occupancy</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk(d.occupancy === 'Primary Residence')}</span>Primary</span>
          <span class="opt"><span class="chk">${chk(d.occupancy === 'Second Home')}</span>Second Home</span>
          <span class="opt"><span class="chk">${chk(d.occupancy === 'Investment')}</span>Investment</span>
        </td>
      </tr>
      <tr>
        <td class="lbl">Mixed-Use Property</td>
        <td class="val" colspan="3">
          <span class="opt"><span class="chk">${chk(false)}</span>Yes — If you will occupy the property, will you set aside space within the property to operate your own business?</span>
          <span class="opt"><span class="chk">${chk(true)}</span>No</span>
        </td>
      </tr>
      <tr>
        <td class="lbl">Manufactured Home</td>
        <td class="val" colspan="3">
          <span class="opt"><span class="chk">${chk(false)}</span>Yes — Is the property a manufactured home?</span>
          <span class="opt"><span class="chk">${chk(true)}</span>No</span>
        </td>
      </tr>
    </table>
  `;

  const section4b = `
    <div class="sect">Section 4b. Other New Mortgage Loans on the Property You are Buying or Refinancing</div>
    <table>
      <colgroup><col style="width:25%"/><col style="width:20%"/><col style="width:15%"/><col style="width:15%"/><col style="width:10%"/><col style="width:15%"/></colgroup>
      <tr>
        <td class="lbl">Creditor Name</td>
        <td class="lbl">Lien Type</td>
        <td class="lbl">Monthly Payment</td>
        <td class="lbl">Loan Amount/Amount to be Drawn</td>
        <td class="lbl">Credit Limit (if applicable)</td>
        <td class="lbl">&nbsp;</td>
      </tr>
      <tr>
        <td class="val empty"></td>
        <td class="val">
          <div><span class="chk">${chk(false)}</span>First Lien</div>
          <div><span class="chk">${chk(false)}</span>Subordinate Lien</div>
        </td>
        <td class="val empty"></td>
        <td class="val empty"></td>
        <td class="val empty"></td>
        <td class="val empty"></td>
      </tr>
    </table>
  `;

  const section4c = `
    <div class="sect">Section 4c. Rental Income on the Property You Want to Purchase</div>
    <div class="subsect">For Purchase Only</div>
    <table>
      <colgroup><col style="width:60%"/><col style="width:40%"/></colgroup>
      <tr><td class="lbl">Expected Monthly Rental Income</td><td class="val empty"></td></tr>
      <tr><td class="lbl">Expected Net Monthly Rental Income (for LENDER to calculate)</td><td class="val empty"></td></tr>
    </table>
  `;

  const section4d = `
    <div class="sect">Section 4d. Gifts or Grants You Have Been Given or Will Receive for this Loan</div>
    <table>
      <colgroup><col style="width:22%"/><col style="width:18%"/><col style="width:40%"/><col style="width:20%"/></colgroup>
      <tr>
        <td class="lbl">Asset Type — Use List Below</td>
        <td class="lbl">Deposited / Not Deposited</td>
        <td class="lbl">Source — Use List Below</td>
        <td class="lbl">Cash or Market Value</td>
      </tr>
      <tr>
        <td class="val empty"></td>
        <td class="val"><span class="opt"><span class="chk">${chk(false)}</span>Deposited</span><span class="opt"><span class="chk">${chk(false)}</span>Not Deposited</span></td>
        <td class="val empty"></td>
        <td class="val empty"></td>
      </tr>
    </table>
    <div style="font-size:6.5pt;color:#333;padding:4pt 7pt;border:0.5pt solid #000;border-top:0">
      <b>Asset Types:</b> Cash Gift &bull; Gift of Equity &bull; Grant
      <br/><b>Sources:</b> Community Nonprofit &bull; Employer &bull; Federal Agency &bull; Local Agency &bull; Relative &bull; Religious Nonprofit &bull; State Agency &bull; Unmarried Partner &bull; Other
    </div>
  `;

  // ─── Section 5. Declarations ───────────────────────────────────────────
  const section5 = (() => {
    const q: Array<[string, any]> = [
      ['A. Will you occupy the property as your primary residence?', d.decl_primary],
      ['   If YES, have you had an ownership interest in another property in the last three years?', d.decl_prior_ownership],
      ['      If YES, complete (1) and (2) below:\u00A0\u00A0(1) What type of property did you own: Primary Residence (PR), FHA Secondary Residence (SR), Second Home (SH), or Investment Property (IP)?\u00A0\u00A0(2) How did you hold title to the property: by yourself (S), jointly with your spouse (SP), or jointly with another person (O)?', null],
      ['B. If this is a Purchase Transaction: Do you have a family relationship or business affiliation with the seller of the property?', d.decl_family_seller],
      ['C. Are you borrowing any money for this real estate transaction (e.g., money for your closing costs or down payment) or obtaining any money from another party (such as the seller or realtor) that you have not disclosed on this loan application?', d.decl_borrowed_funds],
      ['   If YES, what is the amount of this money?', null],
      ['D.1. Have you or will you be applying for a mortgage loan on another property (not the property securing this loan) on or before closing this transaction that is not disclosed on this loan application?', d.decl_other_mortgage],
      ['D.2. Have you or will you be applying for any new credit (e.g., installment loan, credit card, etc.) on or before closing this loan that is not disclosed on this application?', d.decl_new_credit],
      ['E. Will this property be subject to a lien that could take priority over the first mortgage lien, such as a clean energy lien paid through your property taxes (e.g., the Property Assessed Clean Energy Program)?', d.decl_pace_lien],
      ['F. Are you a co-signer or guarantor on any debt or loan that is not disclosed on this application?', d.decl_cosigner],
      ['G. Are there any outstanding judgments against you?', d.decl_judgments],
      ['H. Are you currently delinquent or in default on a Federal debt?', d.decl_delinquent],
      ['I. Are you a party to a lawsuit in which you potentially have any personal financial liability?', d.decl_lawsuit],
      ['J. Have you conveyed title to any property in lieu of foreclosure in the past 7 years?', d.decl_deed_in_lieu],
      ['K. Within the past 7 years, have you completed a pre-foreclosure sale or short sale, whereby the property was sold to a third party and the Lender agreed to accept less than the outstanding mortgage balance due?', d.decl_short_sale],
      ['L. Have you had property foreclosed upon in the last 7 years?', d.decl_foreclosure],
      ['M. Have you declared bankruptcy within the past 7 years?', d.decl_bankruptcy],
    ];
    return `
      <div class="sect">Section 5. Declarations</div>
      <div class="subsect">About this Property and Your Money for this Loan</div>
      ${q.slice(0, 6).map(([label, ans]) => `
        <div class="decl">
          <span>${esc(label)}</span>
          <span class="yn">${ans !== null ? `<span class="opt"><span class="chk">${chk(!!ans)}</span>YES</span><span class="opt"><span class="chk">${chk(!ans)}</span>NO</span>` : '&nbsp;'}</span>
        </div>
      `).join('')}
      <div class="sect">Section 5b. About Your Finances</div>
      ${q.slice(6).map(([label, ans]) => `
        <div class="decl">
          <span>${esc(label)}</span>
          <span class="yn"><span class="opt"><span class="chk">${chk(!!ans)}</span>YES</span><span class="opt"><span class="chk">${chk(!ans)}</span>NO</span></span>
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
      <p>The undersigned acknowledges and agrees to the following in connection with the mortgage loan ("Loan") this application is requesting. "I" and "my" refers to the undersigned. "Lender" refers to the Lender, its agents, service providers, and any of their successors and assigns. "Other Loan Participants" includes any actual or potential owners of the Loan, acquirers of any beneficial or other interest in the Loan, any mortgage insurer, guarantor, any servicers or service providers for these parties, and any of their successors and assigns.</p>
      <div class="cols">
      <p><b>(1) The Complete Information for this Application</b> — The information I have provided in this application is true, accurate, and complete as of the date I signed this application. If the information I provided changes or is inaccurate on or before the closing date of the Loan, I will inform the Lender. I understand that: (a) the Lender and Other Loan Participants may take any action permitted by law and the Loan documents, and (b) I may be liable for monetary damages to the Lender and any Other Loan Participants due to my providing false or misleading information.</p>
      <p><b>(2) The Property's Security</b> — The Loan I have applied for in this application will be secured by a mortgage or deed of trust which provides the Lender a security interest in the property described in this application.</p>
      <p><b>(3) The Property's Appraisal, Value, and Condition</b> — Any appraisal or value of the property obtained by the Lender is for use by the Lender and Other Loan Participants. The Lender and Other Loan Participants have not made any representation or warranty, express or implied, regarding the property, its condition, or its value.</p>
      <p><b>(4) Electronic Records and Signatures</b> — The Lender and Other Loan Participants may keep any paper record and/or electronic record of this application, whether or not the Loan is approved. If this application is created as (or converted into) an "electronic application," I consent to the use of "electronic records" and "electronic signatures" as those terms are defined in applicable Federal and/or state laws (excluding audio and video recordings), or as otherwise provided by applicable law.</p>
      <p><b>(5) Delinquency</b> — The Lender and Other Loan Participants may report information about my account to credit bureaus. Late payments, missed payments, or other defaults on my account may be reflected in my credit report and will likely affect my credit score.</p>
      <p><b>(6) Authorization for Use and Sharing of Information</b> — By signing below, I authorize the Lender and Other Loan Participants, without any further notice or consent, to any or all of the following actions: (a) process and underwrite my application for the Loan; (b) verify any information contained in my application and in any other documents or information I provide, or that the Lender or Other Loan Participants use, in connection with my application; (c) obtain any information or data relating to the Loan or me, including but not limited to, my employment, income, assets, credit, and debt, including from a credit reporting agency and any other third party; (d) share my information and the Loan with investors, servicers, insurers, guarantors, appraisers, settlement agents, third-party service providers, and their affiliates; (e) perform required loan quality control reviews including ordering new appraisals, credit reports, title reports, and verifications; and (f) market my application to others who may have an interest in the Loan.</p>
      <p><b>(7) The Borrower's Right to Receive a Copy of the Appraisal</b> — I have the right to receive a copy of any written appraisal prepared in connection with this application for the Loan at least three (3) business days before my Loan closes.</p>
      <p><b>(8) Other Acknowledgements</b> — I agree that the Lender may provide information about the Loan to Other Loan Participants, and that any Loan disclosures sent to me may be delivered electronically. I consent to being contacted by the Lender or its representatives regarding my application, by telephone (including cellular), text, or e-mail.</p>
      </div>
    </div>
    <div class="sig-row">
      <div class="sig-box">
        <div class="line"></div>
        <div class="lbl2">Borrower Signature &nbsp;&nbsp;&nbsp; ${esc(fullName)}</div>
      </div>
      <div class="sig-box" style="flex:0 0 25%">
        <div class="line"></div>
        <div class="lbl2">Date (mm/dd/yyyy)</div>
      </div>
    </div>
    ${coName ? `
    <div class="sig-row">
      <div class="sig-box">
        <div class="line"></div>
        <div class="lbl2">Co-Borrower Signature &nbsp;&nbsp;&nbsp; ${esc(coName)}</div>
      </div>
      <div class="sig-box" style="flex:0 0 25%">
        <div class="line"></div>
        <div class="lbl2">Date (mm/dd/yyyy)</div>
      </div>
    </div>` : ''}
  `;

  // ─── Section 7. Military Service ───────────────────────────────────────
  const section7 = `
    <div class="sect">Section 7. Military Service</div>
    <div class="decl">
      <span>Military Service — Did you (or your deceased spouse) ever serve, or are you currently serving, in the United States Armed Forces?</span>
      <span class="yn">
        <span class="opt"><span class="chk">${chk(!!d.military_service)}</span>YES</span>
        <span class="opt"><span class="chk">${chk(!d.military_service)}</span>NO</span>
      </span>
    </div>
    <table>
      <tr>
        <td class="lbl" style="width:30%">If YES, check all that apply</td>
        <td class="val">
          <div><span class="chk">${chk(d.military_status === 'Currently serving')}</span>Currently serving on active duty with projected expiration date of service/tour <span style="border-bottom:0.5pt solid #000;display:inline-block;min-width:140pt">&nbsp;</span></div>
          <div><span class="chk">${chk(d.military_status === 'Veteran')}</span>Currently retired, discharged, or separated from service</div>
          <div><span class="chk">${chk(d.military_status === 'Reserve/National Guard')}</span>Only period of service was as a non-activated member of the Reserve or National Guard</div>
          <div><span class="chk">${chk(d.military_status === 'Surviving spouse')}</span>Surviving spouse</div>
        </td>
      </tr>
    </table>
  `;

  // ─── Section 8. Demographics ───────────────────────────────────────────
  const section8 = `
    <div class="sect">Section 8. Demographic Information</div>
    <div class="ack" style="border-bottom:0">
      <p>This section asks about your ethnicity, sex, and race. The purpose of collecting this information is to help ensure that all applicants are treated fairly and that the housing needs of communities and neighborhoods are being fulfilled. For residential mortgage lending, Federal law requires that we ask applicants for their demographic information (ethnicity, sex, and race) in order to monitor our compliance with equal credit opportunity, fair housing, and home mortgage disclosure laws. You are not required to provide this information, but are encouraged to do so. You may select one or more designations for "Ethnicity" and one or more designations for "Race." The law provides that we may not discriminate on the basis of this information, or on whether you choose to provide it. However, if you choose not to provide the information and you have made this application in person, Federal regulations require us to note your ethnicity, sex, and race on the basis of visual observation or surname. The law also provides that we may not discriminate on the basis of age or marital status information you provide in this application.</p>
    </div>
    <table>
      <colgroup><col style="width:50%"/><col style="width:50%"/></colgroup>
      <tr>
        <td class="lbl">Ethnicity — Check one or more</td>
        <td class="lbl">Race — Check one or more</td>
      </tr>
      <tr>
        <td class="val">
          <div><span class="chk">${chk(d.ethnicity === 'Hispanic or Latino')}</span>Hispanic or Latino</div>
          <div style="padding-left:14pt">
            <span class="opt"><span class="chk">${chk(false)}</span>Mexican</span>
            <span class="opt"><span class="chk">${chk(false)}</span>Puerto Rican</span>
            <span class="opt"><span class="chk">${chk(false)}</span>Cuban</span>
          </div>
          <div style="padding-left:14pt"><span class="chk">${chk(false)}</span>Other Hispanic or Latino — Print origin:</div>
          <div><span class="chk">${chk(d.ethnicity === 'Not Hispanic or Latino')}</span>Not Hispanic or Latino</div>
          <div><span class="chk">${chk(d.ethnicity === 'Do not wish to provide' || !d.ethnicity)}</span>I do not wish to provide this information</div>
        </td>
        <td class="val">
          <div><span class="chk">${chk(d.race === 'American Indian or Alaska Native')}</span>American Indian or Alaska Native</div>
          <div><span class="chk">${chk(d.race === 'Asian')}</span>Asian</div>
          <div style="padding-left:14pt">
            <span class="opt"><span class="chk">${chk(false)}</span>Asian Indian</span>
            <span class="opt"><span class="chk">${chk(false)}</span>Chinese</span>
            <span class="opt"><span class="chk">${chk(false)}</span>Filipino</span>
            <span class="opt"><span class="chk">${chk(false)}</span>Japanese</span>
            <span class="opt"><span class="chk">${chk(false)}</span>Korean</span>
            <span class="opt"><span class="chk">${chk(false)}</span>Vietnamese</span>
          </div>
          <div><span class="chk">${chk(d.race === 'Black or African American')}</span>Black or African American</div>
          <div><span class="chk">${chk(d.race === 'Native Hawaiian or Other Pacific Islander')}</span>Native Hawaiian or Other Pacific Islander</div>
          <div><span class="chk">${chk(d.race === 'White')}</span>White</div>
          <div><span class="chk">${chk(d.race === 'Do not wish to provide' || !d.race)}</span>I do not wish to provide this information</div>
        </td>
      </tr>
      <tr>
        <td class="lbl" colspan="2">Sex</td>
      </tr>
      <tr>
        <td class="val" colspan="2">
          <span class="opt"><span class="chk">${chk(d.sex === 'Female')}</span>Female</span>
          <span class="opt"><span class="chk">${chk(d.sex === 'Male')}</span>Male</span>
          <span class="opt"><span class="chk">${chk(d.sex === 'Do not wish to provide' || !d.sex)}</span>I do not wish to provide this information</span>
        </td>
      </tr>
      <tr>
        <td class="lbl" colspan="2">To Be Completed by Financial Institution (for application taken in person)</td>
      </tr>
      <tr>
        <td class="val" colspan="2">
          <div>Was the ethnicity of the Borrower collected on the basis of visual observation or surname?
            <span class="opt"><span class="chk">${chk(false)}</span>NO</span>
            <span class="opt"><span class="chk">${chk(false)}</span>YES</span>
          </div>
          <div>Was the sex of the Borrower collected on the basis of visual observation or surname?
            <span class="opt"><span class="chk">${chk(false)}</span>NO</span>
            <span class="opt"><span class="chk">${chk(false)}</span>YES</span>
          </div>
          <div>Was the race of the Borrower collected on the basis of visual observation or surname?
            <span class="opt"><span class="chk">${chk(false)}</span>NO</span>
            <span class="opt"><span class="chk">${chk(false)}</span>YES</span>
          </div>
          <div>The Demographic Information was provided through:
            <span class="opt"><span class="chk">${chk(false)}</span>Face-to-Face Interview</span>
            <span class="opt"><span class="chk">${chk(false)}</span>Telephone Interview</span>
            <span class="opt"><span class="chk">${chk(true)}</span>Fax or Mail</span>
            <span class="opt"><span class="chk">${chk(false)}</span>Email or Internet</span>
          </div>
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
        <td class="lbl">Loan Originator Signature</td>
        <td class="val" colspan="2"><div style="height:22pt;border-bottom:0.5pt solid #000"></div></td>
        <td class="lbl">Date</td>
      </tr>
    </table>
  `;

  // ─── Lender Loan Information (L1–L4) ───────────────────────────────────
  const sectionLHeader = `
    <div class="title-bar" style="margin-top:4pt">
      <h1 style="font-size:11pt">Lender Loan Information</h1>
      <div class="subttl">To be completed by your Lender</div>
    </div>
  `;

  const sectionL1 = `
    <div class="sect">L1. Property and Loan Information</div>
    <table>
      <colgroup><col style="width:25%"/><col style="width:25%"/><col style="width:25%"/><col style="width:25%"/></colgroup>
      <tr>
        <td class="lbl">Community Property State</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk(false)}</span>At least one borrower lives in a community property state</span><br/>
          <span class="opt"><span class="chk">${chk(false)}</span>The property is in a community property state</span>
        </td>
        <td class="lbl">Refinance Type</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk(false)}</span>No Cash Out</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Limited Cash Out</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Cash Out</span>
        </td>
      </tr>
      <tr>
        <td class="lbl">Refinance Program</td>
        <td class="val" colspan="3">
          <span class="opt"><span class="chk">${chk(false)}</span>Full Documentation</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Interest Rate Reduction</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Streamlined without Appraisal</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Other</span>
        </td>
      </tr>
      <tr>
        <td class="lbl">Energy Improvement</td>
        <td class="val" colspan="3">
          <span class="opt"><span class="chk">${chk(false)}</span>Mortgage loan will finance energy-related improvements</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Property is currently subject to a lien that could take priority over the first mortgage lien for energy-related improvements</span>
        </td>
      </tr>
      <tr>
        <td class="lbl">Project Type</td>
        <td class="val" colspan="3">
          <span class="opt"><span class="chk">${chk(false)}</span>Condominium</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Cooperative</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Planned Unit Development (PUD)</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Property is not located in a project</span>
        </td>
      </tr>
    </table>
  `;

  const sectionL2 = `
    <div class="sect">L2. Title Information</div>
    <table>
      <colgroup><col style="width:25%"/><col style="width:25%"/><col style="width:25%"/><col style="width:25%"/></colgroup>
      <tr>
        <td class="lbl">Title to the Property Will be Held In What Name(s)</td>
        <td class="val" colspan="3">${esc(fullName)}${coName ? ' &amp; ' + esc(coName) : ''}</td>
      </tr>
      <tr>
        <td class="lbl">Estate Will be Held In</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk(true)}</span>Fee Simple</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Leasehold — Expiration Date: &nbsp;</span>
        </td>
        <td class="lbl">Manner in Which Title Will be Held</td>
        <td class="val">&nbsp;</td>
      </tr>
      <tr>
        <td class="lbl">Indian Country Land Tenure</td>
        <td class="val" colspan="3">
          <span class="opt"><span class="chk">${chk(false)}</span>Fee Simple On a Reservation</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Individual Trust Land (Allotted/Restricted)</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Tribal Trust Land On a Reservation</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Tribal Trust Land Off Reservation</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Alaska Native Corporation Land</span>
        </td>
      </tr>
    </table>
  `;

  const sectionL3 = `
    <div class="sect">L3. Mortgage Loan Information</div>
    <table>
      <colgroup><col style="width:22%"/><col style="width:28%"/><col style="width:22%"/><col style="width:28%"/></colgroup>
      <tr>
        <td class="lbl">Mortgage Type Applied For</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk(d.loan_type === 'Conventional')}</span>Conventional</span>
          <span class="opt"><span class="chk">${chk(d.loan_type === 'FHA')}</span>FHA</span>
          <span class="opt"><span class="chk">${chk(d.loan_type === 'VA')}</span>VA</span>
          <span class="opt"><span class="chk">${chk(d.loan_type === 'USDA-RD')}</span>USDA-RD</span>
          <span class="opt"><span class="chk">${chk(d.loan_type && !['Conventional','FHA','VA','USDA-RD'].includes(d.loan_type))}</span>Other</span>
        </td>
        <td class="lbl">Terms of Loan</td>
        <td class="val">
          <div>Note Rate: ${esc(d.current_interest_rate ? d.current_interest_rate + '%' : '&nbsp;')}</div>
          <div>Loan Term (months): ${esc(d.loan_term_months) || '&nbsp;'}</div>
        </td>
      </tr>
      <tr>
        <td class="lbl">Mortgage Lien Type</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk(true)}</span>First Lien</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Subordinate Lien</span>
        </td>
        <td class="lbl">Amortization Type</td>
        <td class="val">
          <span class="opt"><span class="chk">${chk(true)}</span>Fixed Rate</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Adjustable Rate</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Other</span>
        </td>
      </tr>
      <tr>
        <td class="lbl">Loan Features</td>
        <td class="val" colspan="3">
          <span class="opt"><span class="chk">${chk(false)}</span>Balloon / Term:</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Interest Only / Term:</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Negative Amortization</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Prepayment Penalty / Term:</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Temporary Interest Rate Buydown / Initial Rate:</span>
          <span class="opt"><span class="chk">${chk(false)}</span>Other (explain):</span>
        </td>
      </tr>
    </table>
  `;

  const sectionL4 = `
    <div class="sect">L4. Qualifying the Borrower — Minimum Required Funds or Cash Back</div>
    <table>
      <colgroup><col style="width:6%"/><col style="width:62%"/><col style="width:32%"/></colgroup>
      <tr><td class="lbl">DUE FROM BORROWER(S)</td><td class="lbl"></td><td class="lbl">Amount</td></tr>
      <tr><td class="val">A.</td><td class="val">Sales Contract Price</td><td class="val">${esc(fmtMoney(d.prop_value))}</td></tr>
      <tr><td class="val">B.</td><td class="val">Improvements, Renovations, and Repairs</td><td class="val empty"></td></tr>
      <tr><td class="val">C.</td><td class="val">Land (if acquired separately)</td><td class="val empty"></td></tr>
      <tr><td class="val">D.</td><td class="val">For Refinance: Balance of Mortgage Loans on the Property to be paid off in the Transaction</td><td class="val empty"></td></tr>
      <tr><td class="val">E.</td><td class="val">Credit Cards and Other Debts Paid Off</td><td class="val empty"></td></tr>
      <tr><td class="val">F.</td><td class="val">Borrower Closing Costs (including Prepaid Items)</td><td class="val empty"></td></tr>
      <tr><td class="val">G.</td><td class="val">Discount Points</td><td class="val empty"></td></tr>
      <tr><td class="val" style="background:#eaeaea;font-weight:bold">H.</td><td class="val" style="background:#eaeaea;font-weight:bold">TOTAL DUE FROM BORROWER(s) (Total of A thru G)</td><td class="val" style="background:#eaeaea;font-weight:bold">&nbsp;</td></tr>
      <tr><td class="lbl" colspan="3">TOTAL MORTGAGE LOANS</td></tr>
      <tr><td class="val">I.</td><td class="val">Loan Amount excluding financed mortgage insurance (or mortgage insurance equivalent)</td><td class="val">${esc(fmtMoney(d.loan_amount))}</td></tr>
      <tr><td class="val">J.</td><td class="val">Loan Amount including financed mortgage insurance (or mortgage insurance equivalent)</td><td class="val">${esc(fmtMoney(d.loan_amount))}</td></tr>
      <tr><td class="val">K.</td><td class="val">Other New Mortgage Loans on the Property the Borrower(s) is Buying or Refinancing</td><td class="val empty"></td></tr>
      <tr><td class="val" style="background:#eaeaea;font-weight:bold">L.</td><td class="val" style="background:#eaeaea;font-weight:bold">TOTAL MORTGAGE LOANS (Total of I, K)</td><td class="val" style="background:#eaeaea;font-weight:bold">${esc(fmtMoney(d.loan_amount))}</td></tr>
      <tr><td class="lbl" colspan="3">TOTAL CREDITS</td></tr>
      <tr><td class="val">M.</td><td class="val">Seller Credits</td><td class="val empty"></td></tr>
      <tr><td class="val">N.</td><td class="val">Other Credits</td><td class="val empty"></td></tr>
      <tr><td class="val" style="background:#eaeaea;font-weight:bold">O.</td><td class="val" style="background:#eaeaea;font-weight:bold">TOTAL CREDITS (Total of M, N)</td><td class="val" style="background:#eaeaea;font-weight:bold">&nbsp;</td></tr>
      <tr><td class="lbl" colspan="3">CALCULATION</td></tr>
      <tr><td class="val">&nbsp;</td><td class="val">TOTAL DUE FROM BORROWER(s) (Line H)</td><td class="val empty"></td></tr>
      <tr><td class="val">&nbsp;</td><td class="val">LESS TOTAL MORTGAGE LOANS (Line L) and TOTAL CREDITS (Line O)</td><td class="val">${esc(fmtMoney(d.loan_amount))}</td></tr>
      <tr><td class="val" style="background:#1a1a2e;color:#fff;font-weight:bold">P.</td><td class="val" style="background:#1a1a2e;color:#fff;font-weight:bold">Cash From/To the Borrower (Line H minus Line L and Line O)</td><td class="val" style="background:#f5f5f5;font-weight:bold">&nbsp;</td></tr>
    </table>
  `;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>Uniform Residential Loan Application — ${esc(fullName)}</title>
<style>${css}</style>
</head>
<body>
<button class="print-btn no-print" onclick="window.print()">Print / Save as PDF</button>

<div class="page">
  ${titleBar}
  <div class="intro">This application is designed to be completed by the applicant(s) with the Lender's assistance. Applicants should complete this form as "Borrower" or "Co-Borrower," as applicable. Co-Borrower information must also be provided (and the appropriate box checked) when the income or assets of a person other than the Borrower (including the Borrower's spouse) will be used as a basis for loan qualification.</div>
  ${lenderBar}
  ${section1a}
  ${section1b}
  ${pageFooter(1, 11)}
</div>

<div class="page">
  ${section1c}
  ${section1d}
  ${section1e}
  ${pageFooter(2, 11)}
</div>

<div class="page">
  ${section2a}
  ${section2b}
  ${section2c}
  ${section2d}
  ${pageFooter(3, 11)}
</div>

<div class="page">
  ${section3a}
  ${section3b}
  ${section3c}
  ${pageFooter(4, 11)}
</div>

<div class="page">
  ${section4a}
  ${section4b}
  ${section4c}
  ${section4d}
  ${pageFooter(5, 11)}
</div>

<div class="page">
  ${section5}
  ${pageFooter(6, 11)}
</div>

<div class="page">
  ${section6}
  ${pageFooter(7, 11)}
</div>

<div class="page">
  ${section7}
  ${section8}
  ${pageFooter(8, 11)}
</div>

<div class="page">
  ${section9}
  ${pageFooter(9, 11)}
</div>

<div class="page">
  ${sectionLHeader}
  ${sectionL1}
  ${sectionL2}
  ${sectionL3}
  ${pageFooter(10, 11)}
</div>

<div class="page">
  ${sectionL4}
  ${pageFooter(11, 11)}
</div>
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
      mailing_address: app.mailing_address || '',
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
      loan_amount: app.loan_amount || app.requested_loan_amount || c.loan_amount || '',
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
      decl_family_seller: app.declaration_family_seller || false,
      decl_borrowed_funds: app.declaration_borrowed_funds || false,
      decl_other_mortgage: app.declaration_other_mortgage || false,
      decl_new_credit: app.declaration_new_credit || false,
      decl_pace_lien: app.declaration_pace_lien || false,
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
      co_borrower_middle_name: app.co_borrower_middle_name || '',
      co_borrower_last_name: app.co_borrower_last_name || '',
      co_borrower_suffix: app.co_borrower_suffix || '',
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
