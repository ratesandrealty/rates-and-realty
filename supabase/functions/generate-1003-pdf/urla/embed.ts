// Auto-generated from urla/style.css, urla/index.html, urla/script.js
// Regenerate by running the shell command in the parent index.ts comment.

export const URLA_CSS = String.raw`/* URLA 1003 — Freddie Mac Form 65 / Fannie Mae Form 1003 (Effective 1/2021) */

@page { size: letter; margin: 0.5in; }

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, sans-serif; color: #000; background: #e8e8e8; font-size: 9pt; line-height: 1.3; }

.page {
  width: 8.5in;
  min-height: 11in;
  padding: 0.45in 0.5in 0.6in 0.5in;
  margin: 12px auto;
  background: #fff;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  position: relative;
  page-break-after: always;
}
.page:last-child { page-break-after: auto; }

/* ── Header blocks ─────────────────────────────────────────────────── */
.lender-bar { background: #f0f0f0; border: 1px solid #999; padding: 5px 10px; font-size: 8pt; display: flex; gap: 20px; margin-bottom: 8px; }
.lender-bar .fld { flex: 1; }
.lender-bar .fld b { display: block; font-size: 7pt; text-transform: uppercase; letter-spacing: 0.2px; color: #333; }
.lender-bar .fld .v { border-bottom: 1px solid #000; min-height: 14px; padding-top: 2px; }

.form-title { font-size: 20pt; font-weight: bold; margin: 4px 0 2px; letter-spacing: -0.3px; }
.form-subtitle { font-size: 8pt; color: #555; font-style: italic; margin-bottom: 8px; }
.instructions { font-size: 7.5pt; color: #444; margin-bottom: 10px; font-style: italic; line-height: 1.35; }

.section-header { font-size: 13pt; font-weight: bold; margin: 10px 0 4px; }

.subsection-bar {
  background: #1a1a2e; color: #fff;
  font-size: 9pt; font-weight: bold;
  padding: 5px 10px;
  margin: 0;
  text-transform: none;
  letter-spacing: 0.3px;
  border: 1px solid #000;
}
.subsection-bar.light { background: #3a3a52; }

/* ── Generic form-table (used everywhere for label/value grids) ────── */
.form-table { width: 100%; border-collapse: collapse; margin: 0; table-layout: fixed; }
.form-table td, .form-table th {
  border: 0.5pt solid #000;
  padding: 3px 6px;
  vertical-align: top;
  word-wrap: break-word;
  overflow-wrap: break-word;
  font-size: 8.5pt;
}
.form-table th { background: #eaeaea; font-weight: bold; font-size: 7pt; text-transform: uppercase; letter-spacing: 0.2px; text-align: left; }
.form-table .lbl { background: #eaeaea; font-size: 7pt; font-weight: bold; text-transform: uppercase; letter-spacing: 0.2px; color: #222; }
.form-table .val { font-size: 9pt; min-height: 16px; }
.form-table .val.empty::after { content: '\00a0'; }

/* ── Checkboxes ────────────────────────────────────────────────────── */
.cb { font-family: 'Segoe UI Symbol', 'DejaVu Sans', 'Arial Unicode MS', sans-serif; font-size: 10pt; margin-right: 3px; }
.opt { display: inline-block; margin-right: 12px; font-size: 8.5pt; white-space: nowrap; }
.opt-block { display: block; font-size: 8.5pt; padding: 1px 0; }

/* ── NO/YES declaration rows ───────────────────────────────────────── */
.decl {
  border: 0.5pt solid #000;
  border-top: 0;
  padding: 4px 8px;
  font-size: 8pt;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.decl:first-of-type { border-top: 0.5pt solid #000; }
.decl > span:first-child { flex: 1; }
.decl .yn { white-space: nowrap; min-width: 90px; text-align: right; }

/* ── Acknowledgements (2-col legal text) ───────────────────────────── */
.ack { border: 0.5pt solid #000; padding: 7px 10px; font-size: 6.8pt; text-align: justify; line-height: 1.4; }
.ack p { margin: 0 0 4px 0; }
.ack .cols { column-count: 2; column-gap: 16px; }

/* ── Signatures ────────────────────────────────────────────────────── */
.sig-row { display: flex; gap: 16px; margin-top: 10px; }
.sig-box { flex: 1; }
.sig-box .line { border-bottom: 1px solid #000; height: 24px; }
.sig-box .lbl2 { font-size: 7pt; color: #333; margin-top: 2px; }
.sig-line { border-bottom: 1px solid #000; min-width: 280px; display: inline-block; min-height: 14px; }

/* ── 2-column / grid helpers ───────────────────────────────────────── */
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
.two-col > * { border: 0.5pt solid #000; padding: 5px 8px; }
.two-col > *:first-child { border-right: 0; }

.gray-box { background: #f5f5f5; border: 0.5pt solid #999; padding: 6px 8px; }

/* ── Page footer ───────────────────────────────────────────────────── */
.page-footer {
  position: absolute;
  bottom: 0.3in;
  left: 0.5in;
  right: 0.5in;
  display: flex;
  justify-content: space-between;
  font-size: 6.5pt;
  color: #444;
  border-top: 0.5pt solid #888;
  padding-top: 3px;
}

/* ── Print ─────────────────────────────────────────────────────────── */
@media print {
  body { background: #fff; margin: 0; }
  .page { margin: 0; box-shadow: none; width: auto; min-height: auto; padding: 0.3in; }
  .no-print { display: none !important; }
}
`;

export const URLA_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Uniform Residential Loan Application</title>
  <link rel="stylesheet" href="style.css"/>
</head>
<body>

<!-- ══════════════════════ PAGE 1 ══════════════════════ -->
<div class="page" id="page-1">
  <div class="lender-bar">
    <div class="fld"><b>To be completed by the Lender:</b></div>
    <div class="fld"><b>Lender Loan No./Universal Loan Identifier</b><div class="v" data-field="lender.loanNo">&nbsp;</div></div>
    <div class="fld"><b>Agency Case No.</b><div class="v" data-field="lender.agencyCaseNo">&nbsp;</div></div>
  </div>

  <div class="form-title">Uniform Residential Loan Application</div>
  <div class="form-subtitle">Freddie Mac Form 65 &bull; Fannie Mae Form 1003 &bull; Effective 1/2021</div>
  <div class="instructions">Verify and complete the information on this application. If you are applying for this loan with others, each additional Borrower must provide information as directed by your Lender.</div>

  <div class="section-header">Section 1: Borrower Information.</div>
  <div class="subsection-bar">This section asks about your personal information and your income from employment and other sources, such as retirement, that you want considered to qualify for this loan.</div>
  <div class="subsection-bar light">1a. Personal Information</div>

  <table class="form-table">
    <colgroup><col style="width:50%"/><col style="width:50%"/></colgroup>
    <tr>
      <td class="lbl">Name (First, Middle, Last, Suffix)<div class="val" data-field="borrower.fullName">&nbsp;</div></td>
      <td class="lbl">Social Security Number<div class="val" data-field="borrower.ssn" data-format="ssn">&nbsp;</div></td>
    </tr>
    <tr>
      <td class="lbl" colspan="2">Alternate Names &mdash; List any names by which you are known or any names under which credit was previously received (First, Middle, Last, Suffix)<div class="val" data-field="borrower.alternateNames">&nbsp;</div></td>
    </tr>
    <tr>
      <td class="lbl">Date of Birth (mm/dd/yyyy)<div class="val" data-field="borrower.dob" data-format="date">&nbsp;</div></td>
      <td class="lbl">Citizenship
        <div class="opt-block"><span class="cb" id="cb-citizen">&#9744;</span>U.S. Citizen</div>
        <div class="opt-block"><span class="cb" id="cb-perm">&#9744;</span>Permanent Resident Alien</div>
        <div class="opt-block"><span class="cb" id="cb-nonperm">&#9744;</span>Non-Permanent Resident Alien</div>
      </td>
    </tr>
    <tr>
      <td class="lbl">Type of Credit
        <div class="opt-block"><span class="cb" id="cb-credit-individual">&#9744;</span>I am applying for individual credit</div>
        <div class="opt-block"><span class="cb" id="cb-credit-joint">&#9744;</span>I am applying for joint credit. Total Number of Borrowers: <span data-field="borrower.totalBorrowers">1</span></div>
      </td>
      <td class="lbl">List Name(s) of Other Borrower(s) on the Application (First, Middle, Last, Suffix) &mdash; <i>Use a separator between names</i>
        <div class="val" data-field="coBorrower.fullName">&nbsp;</div>
      </td>
    </tr>
  </table>

  <table class="form-table">
    <colgroup><col style="width:34%"/><col style="width:33%"/><col style="width:33%"/></colgroup>
    <tr>
      <td class="lbl">Marital Status
        <div class="opt-block"><span class="cb" id="cb-married">&#9744;</span>Married</div>
        <div class="opt-block"><span class="cb" id="cb-separated">&#9744;</span>Separated</div>
        <div class="opt-block"><span class="cb" id="cb-unmarried">&#9744;</span>Unmarried (Single, Divorced, Widowed, Civil Union, Domestic Partnership, Registered Reciprocal Beneficiary Relationship)</div>
      </td>
      <td class="lbl">Dependents (not listed by another Borrower)
        <div>Number: <span data-field="borrower.dependentsCount">&nbsp;</span></div>
        <div>Ages: <span data-field="borrower.dependentsAges">&nbsp;</span></div>
      </td>
      <td class="lbl">Contact Information
        <div>Home Phone: <span data-field="borrower.homePhone">&nbsp;</span></div>
        <div>Cell Phone: <span data-field="borrower.cellPhone">&nbsp;</span></div>
        <div>Work Phone: <span data-field="borrower.workPhone">&nbsp;</span></div>
        <div>Email: <span data-field="borrower.email">&nbsp;</span></div>
      </td>
    </tr>
  </table>

  <table class="form-table">
    <tr>
      <td class="lbl" colspan="4">Current Address</td>
    </tr>
    <tr>
      <td class="lbl" style="width:55%">Street<div class="val" data-field="borrower.currentAddress.street">&nbsp;</div></td>
      <td class="lbl" style="width:15%">Unit #<div class="val" data-field="borrower.currentAddress.unit">&nbsp;</div></td>
      <td class="lbl" style="width:30%" colspan="2">Country<div class="val" data-field="borrower.currentAddress.country">USA</div></td>
    </tr>
    <tr>
      <td class="lbl">City<div class="val" data-field="borrower.currentAddress.city">&nbsp;</div></td>
      <td class="lbl">State<div class="val" data-field="borrower.currentAddress.state">&nbsp;</div></td>
      <td class="lbl" colspan="2">ZIP<div class="val" data-field="borrower.currentAddress.zip">&nbsp;</div></td>
    </tr>
    <tr>
      <td class="lbl" colspan="2">How Long at Current Address?
        <span data-field="borrower.currentAddress.years">0</span> Years
        <span data-field="borrower.currentAddress.months">0</span> Months
      </td>
      <td class="lbl" colspan="2">Housing
        <span class="opt"><span class="cb" id="cb-housing-noexpense">&#9744;</span>No Primary Housing Expense</span>
        <span class="opt"><span class="cb" id="cb-housing-own">&#9744;</span>Own</span>
        <span class="opt"><span class="cb" id="cb-housing-rent">&#9744;</span>Rent ($<span data-field="borrower.currentAddress.rent">&nbsp;</span>/month)</span>
      </td>
    </tr>
  </table>

  <table class="form-table">
    <tr>
      <td class="lbl" colspan="4">If at Current Address for LESS than 2 years, list Former Address &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply</td>
    </tr>
    <tr>
      <td class="lbl" style="width:55%">Street<div class="val" data-field="borrower.formerAddress.street">&nbsp;</div></td>
      <td class="lbl" style="width:15%">Unit #<div class="val" data-field="borrower.formerAddress.unit">&nbsp;</div></td>
      <td class="lbl" style="width:15%">City<div class="val" data-field="borrower.formerAddress.city">&nbsp;</div></td>
      <td class="lbl" style="width:15%">State/ZIP<div class="val"><span data-field="borrower.formerAddress.state">&nbsp;</span> <span data-field="borrower.formerAddress.zip">&nbsp;</span></div></td>
    </tr>
    <tr>
      <td class="lbl" colspan="4">How Long at Former Address? <span data-field="borrower.formerAddress.years">0</span> Years <span data-field="borrower.formerAddress.months">0</span> Months &nbsp;&nbsp; Housing: <span class="opt"><span class="cb">&#9744;</span>No primary housing expense</span><span class="opt"><span class="cb">&#9744;</span>Own</span><span class="opt"><span class="cb">&#9744;</span>Rent</span></td>
    </tr>
  </table>

  <table class="form-table">
    <tr><td class="lbl">Mailing Address &mdash; if different from Current Address &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply<div class="val" data-field="borrower.mailingAddress">&nbsp;</div></td></tr>
  </table>

  <div class="subsection-bar light" style="margin-top:6px">1b. Current Employment/Self-Employment and Income &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply</div>

  <table class="form-table">
    <colgroup><col style="width:55%"/><col style="width:45%"/></colgroup>
    <tr>
      <td class="lbl">Employer or Business Name<div class="val" data-field="employment.current.employerName">&nbsp;</div></td>
      <td class="lbl">Phone<div class="val" data-field="employment.current.phone">&nbsp;</div></td>
    </tr>
    <tr>
      <td class="lbl" colspan="2">Street<div class="val" data-field="employment.current.street">&nbsp;</div> &nbsp; Unit #<span data-field="employment.current.unit">&nbsp;</span></td>
    </tr>
    <tr>
      <td class="lbl">City <span data-field="employment.current.city">&nbsp;</span>&nbsp;&nbsp;State <span data-field="employment.current.state">&nbsp;</span>&nbsp;&nbsp;ZIP <span data-field="employment.current.zip">&nbsp;</span></td>
      <td class="lbl">Country <span data-field="employment.current.country">USA</span></td>
    </tr>
    <tr>
      <td class="lbl">Position or Title<div class="val" data-field="employment.current.position">&nbsp;</div></td>
      <td class="lbl" rowspan="3">
        <b>Gross Monthly Income</b>
        <div>Base: $<span data-field="employment.current.baseIncome" data-format="currency">&nbsp;</span> /mo</div>
        <div>Overtime: $<span data-field="employment.current.overtime" data-format="currency">&nbsp;</span> /mo</div>
        <div>Bonus: $<span data-field="employment.current.bonus" data-format="currency">&nbsp;</span> /mo</div>
        <div>Commission: $<span data-field="employment.current.commission" data-format="currency">&nbsp;</span> /mo</div>
        <div>Military Entitlements: $<span data-field="employment.current.military" data-format="currency">&nbsp;</span> /mo</div>
        <div>Other: $<span data-field="employment.current.other" data-format="currency">&nbsp;</span> /mo</div>
        <div style="background:#1a1a2e;color:#fff;padding:3px 4px;margin-top:3px"><b>TOTAL: $<span data-field="employment.current.total" data-format="currency">&nbsp;</span> /mo</b></div>
      </td>
    </tr>
    <tr>
      <td class="lbl">Start Date <span data-field="employment.current.startDate" data-format="date">&nbsp;</span></td>
    </tr>
    <tr>
      <td class="lbl">How long in this line of work? <span data-field="employment.current.years">0</span> Yrs <span data-field="employment.current.months">0</span> Mos
        <div><span class="cb" id="cb-emp-family">&#9744;</span> Check if you are the Business Owner or Self-Employed</div>
        <div><span class="cb" id="cb-emp-company">&#9744;</span> I have an ownership share of less than 25% &nbsp; <span class="cb" id="cb-emp-self">&#9744;</span> I have an ownership share of 25% or more</div>
      </td>
    </tr>
  </table>

  <div class="page-footer">
    <span class="footer-borrower">Borrower Name: <span data-field="borrower.fullName"></span></span>
    <span class="footer-title">Uniform Residential Loan Application &mdash; Freddie Mac Form 65 &bull; Fannie Mae Form 1003</span>
    <span class="footer-page">Page 1 of 11</span>
  </div>
</div>

<!-- ══════════════════════ PAGE 2 — 1c, 1d, 1e ══════════════════════ -->
<div class="page" id="page-2">
  <div class="subsection-bar light">1c. IF APPLICABLE, Complete Information for Additional Employment/Self-Employment and Income &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply</div>
  <table class="form-table">
    <colgroup><col style="width:55%"/><col style="width:45%"/></colgroup>
    <tr><td class="lbl">Employer or Business Name<div class="val">&nbsp;</div></td><td class="lbl">Phone<div class="val">&nbsp;</div></td></tr>
    <tr><td class="lbl" colspan="2">Street<div class="val">&nbsp;</div>Unit # &nbsp;&nbsp;City &nbsp;&nbsp;State &nbsp;&nbsp;ZIP &nbsp;&nbsp;Country</td></tr>
    <tr>
      <td class="lbl">Position or Title<div class="val">&nbsp;</div></td>
      <td class="lbl" rowspan="3"><b>Gross Monthly Income</b>
        <div>Base: $____ /mo</div>
        <div>Overtime: $____ /mo</div>
        <div>Bonus: $____ /mo</div>
        <div>Commission: $____ /mo</div>
        <div>Military Entitlements: $____ /mo</div>
        <div>Other: $____ /mo</div>
        <div style="background:#1a1a2e;color:#fff;padding:3px 4px;margin-top:3px"><b>TOTAL: $____ /mo</b></div>
      </td>
    </tr>
    <tr><td class="lbl">Start Date &nbsp;&nbsp; How long in this line of work?</td></tr>
    <tr><td class="lbl"><span class="cb">&#9744;</span>Check if this statement applies: I am employed by a family member, property seller, real estate agent, or other party to the transaction.</td></tr>
  </table>

  <div class="subsection-bar light">1d. IF APPLICABLE, Complete Information for Previous Employment/Self-Employment and Income &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply</div>
  <table class="form-table">
    <colgroup><col style="width:55%"/><col style="width:45%"/></colgroup>
    <tr><td class="lbl">Employer or Business Name<div class="val">&nbsp;</div></td><td class="lbl">Previous Gross Monthly Income $____</td></tr>
    <tr><td class="lbl" colspan="2">Street<div class="val">&nbsp;</div>Unit # &nbsp;&nbsp;City &nbsp;&nbsp;State &nbsp;&nbsp;ZIP &nbsp;&nbsp;Country</td></tr>
    <tr><td class="lbl">Position or Title<div class="val">&nbsp;</div></td><td class="lbl">Start Date &nbsp; End Date</td></tr>
    <tr><td class="lbl" colspan="2"><span class="cb">&#9744;</span>Check if this statement applies: I was employed by a family member, property seller, real estate agent, or other party to the transaction.</td></tr>
  </table>

  <div class="subsection-bar light">1e. Income from Other Sources &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply</div>
  <div style="border:0.5pt solid #000;padding:5px 8px;font-size:7pt;background:#fafafa">
    <b>NOTE:</b> Reveal alimony, child support, separate maintenance, or other income ONLY IF you want it considered in repaying this loan.
    <div style="column-count:5;column-gap:14px;margin-top:3px">
      <div>&bull; Alimony</div>
      <div>&bull; Automobile Allowance</div>
      <div>&bull; Boarder Income</div>
      <div>&bull; Capital Gains</div>
      <div>&bull; Child Support</div>
      <div>&bull; Disability</div>
      <div>&bull; Foster Care</div>
      <div>&bull; Housing or Parsonage</div>
      <div>&bull; Interest and Dividends</div>
      <div>&bull; Mortgage Credit Certificate</div>
      <div>&bull; Mortgage Differential Payments</div>
      <div>&bull; Notes Receivable</div>
      <div>&bull; Public Assistance</div>
      <div>&bull; Retirement (e.g. Pension, IRA)</div>
      <div>&bull; Royalty Payments</div>
      <div>&bull; Separate Maintenance</div>
      <div>&bull; Social Security</div>
      <div>&bull; Trust</div>
      <div>&bull; Unemployment Benefits</div>
      <div>&bull; VA Compensation</div>
      <div>&bull; Other</div>
    </div>
  </div>
  <table class="form-table">
    <colgroup><col style="width:70%"/><col style="width:30%"/></colgroup>
    <tr><th>Income Source &mdash; use list above</th><th>Monthly Income</th></tr>
    <tr><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td style="background:#1a1a2e;color:#fff;font-weight:bold">Provide TOTAL Amount Here</td><td class="val empty"></td></tr>
  </table>

  <div class="page-footer">
    <span>Borrower Name: <span data-field="borrower.fullName"></span></span>
    <span>Uniform Residential Loan Application &mdash; Freddie Mac Form 65 &bull; Fannie Mae Form 1003</span>
    <span>Page 2 of 11</span>
  </div>
</div>

<!-- ══════════════════════ PAGE 3 — Section 2 Assets & Liabilities ══════════════════════ -->
<div class="page" id="page-3">
  <div class="section-header">Section 2: Financial Information &mdash; Assets and Liabilities.</div>
  <div class="subsection-bar">This section asks about things you own that are worth money and that you want considered to qualify for this loan. It then asks about your liabilities (or debts) that you pay each month, such as credit cards, alimony, or other expenses.</div>

  <div class="subsection-bar light">2a. Assets &mdash; Bank Accounts, Retirement, and Other Accounts You Have</div>
  <div style="border:0.5pt solid #000;border-top:0;padding:4px 8px;font-size:7pt;background:#fafafa">
    <b>Account Types:</b> Checking &bull; Savings &bull; Money Market &bull; Certificate of Deposit &bull; Mutual Fund &bull; Stocks &bull; Stock Options &bull; Bonds &bull; Retirement (e.g. 401k, IRA) &bull; Bridge Loan Proceeds &bull; Individual Development Account &bull; Trust Account &bull; Cash Value of Life Insurance (used for the transaction) &bull; Other
  </div>
  <table class="form-table">
    <colgroup><col style="width:24%"/><col style="width:32%"/><col style="width:24%"/><col style="width:20%"/></colgroup>
    <tr><th>Account Type &mdash; use list above</th><th>Financial Institution</th><th>Account Number</th><th>Cash or Market Value</th></tr>
    <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td colspan="3" style="background:#1a1a2e;color:#fff;font-weight:bold">Provide TOTAL Amount Here</td><td class="val empty"></td></tr>
  </table>

  <div class="subsection-bar light">2b. Other Assets and Credits You Have &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply</div>
  <div style="border:0.5pt solid #000;border-top:0;padding:4px 8px;font-size:7pt;background:#fafafa">
    <b>Assets:</b> Proceeds from Real Estate Property to be sold on or before closing &bull; Proceeds from Sale of Non-Real Estate Asset &bull; Secured Borrowed Funds &bull; Unsecured Borrowed Funds &bull; Other<br/>
    <b>Credits:</b> Earnest Money &bull; Employer Assistance &bull; Lot Equity &bull; Relocation Funds &bull; Rent Credit &bull; Sweat Equity &bull; Trade Equity &bull; Other
  </div>
  <table class="form-table">
    <colgroup><col style="width:70%"/><col style="width:30%"/></colgroup>
    <tr><th>Asset or Credit Type &mdash; use list above</th><th>Cash or Market Value</th></tr>
    <tr><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td></tr>
  </table>

  <div class="subsection-bar light">2c. Liabilities &mdash; Credit Cards, Other Debts, and Leases That You Owe &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply</div>
  <div style="border:0.5pt solid #000;border-top:0;padding:4px 8px;font-size:7pt;background:#fafafa">
    <b>Account Types:</b> Revolving (e.g. Credit Cards) &bull; Installment (e.g. Car, Student, Personal Loans) &bull; Open 30-Day (balance paid monthly) &bull; Lease (not real estate) &bull; Other
  </div>
  <table class="form-table">
    <colgroup><col style="width:18%"/><col style="width:25%"/><col style="width:17%"/><col style="width:20%"/><col style="width:20%"/></colgroup>
    <tr><th>Account Type</th><th>Company Name</th><th>Account Number</th><th>Unpaid Balance</th><th>Monthly Payment</th></tr>
    <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
  </table>

  <div class="subsection-bar light">2d. Other Liabilities and Expenses &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply</div>
  <div style="border:0.5pt solid #000;border-top:0;padding:4px 8px;font-size:7pt;background:#fafafa">
    <b>Types:</b> Alimony &bull; Child Support &bull; Separate Maintenance &bull; Job-Related Expenses &bull; Other
  </div>
  <table class="form-table">
    <colgroup><col style="width:70%"/><col style="width:30%"/></colgroup>
    <tr><th>Type</th><th>Monthly Payment</th></tr>
    <tr><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val empty"></td></tr>
  </table>

  <div class="page-footer">
    <span>Borrower Name: <span data-field="borrower.fullName"></span></span>
    <span>Uniform Residential Loan Application &mdash; Freddie Mac Form 65 &bull; Fannie Mae Form 1003</span>
    <span>Page 3 of 11</span>
  </div>
</div>

<!-- ══════════════════════ PAGE 4 — Section 3 Real Estate ══════════════════════ -->
<div class="page" id="page-4">
  <div class="section-header">Section 3: Financial Information &mdash; Real Estate.</div>
  <div class="subsection-bar">This section asks you to list all properties you currently own and what you owe on them. &nbsp;&nbsp;<span class="cb">&#9744;</span>I do not own any real estate</div>

  <div class="subsection-bar light">3a. Property You Own &mdash; If you are refinancing, list the property you are refinancing FIRST.</div>
  <table class="form-table">
    <tr><td class="lbl" colspan="6">Address &mdash; Street <span class="val" style="display:inline-block;min-width:200pt">&nbsp;</span> Unit # <span class="val" style="display:inline-block;min-width:40pt">&nbsp;</span></td></tr>
    <tr><td class="lbl" colspan="6">City <span class="val" style="display:inline-block;min-width:100pt">&nbsp;</span> State <span class="val" style="display:inline-block;min-width:30pt">&nbsp;</span> ZIP <span class="val" style="display:inline-block;min-width:50pt">&nbsp;</span> Country <span class="val" style="display:inline-block;min-width:60pt">&nbsp;</span></td></tr>
    <tr>
      <th>Property Value</th>
      <th>Status: Sold, Pending Sale, or Retained</th>
      <th>Intended Occupancy: Investment, Primary Residence, Second Home, Other</th>
      <th>Monthly Insurance, Taxes, Association Dues, etc. (if not included in mortgage)</th>
      <th>For 2-4 Unit Primary or Investment Property &mdash; Monthly Rental Income</th>
      <th>For LENDER to calculate: Net Monthly Rental Income</th>
    </tr>
    <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
  </table>
  <div class="subsection-bar light">Mortgage Loans on this Property &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply</div>
  <table class="form-table">
    <tr><th>Creditor Name</th><th>Account Number</th><th>Monthly Mortgage Payment</th><th>Unpaid Balance</th><th>To be paid off at or before closing</th><th>Type (FHA, VA, Conventional, USDA-RD)</th><th>Credit Limit (if applicable)</th></tr>
    <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val"><span class="cb">&#9744;</span></td><td class="val empty"></td><td class="val empty"></td></tr>
  </table>

  <div class="subsection-bar light">3b. IF APPLICABLE, Complete Information for Additional Property &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply</div>
  <table class="form-table">
    <tr><td class="lbl" colspan="6">Address: Street &nbsp; Unit # &nbsp; City &nbsp; State &nbsp; ZIP &nbsp; Country</td></tr>
    <tr><th>Property Value</th><th>Status</th><th>Occupancy</th><th>Monthly Taxes/Ins/HOA</th><th>Monthly Rental Income</th><th>Net Monthly Rental</th></tr>
    <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
  </table>

  <div class="subsection-bar light">3c. IF APPLICABLE, Complete Information for Additional Property &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply</div>
  <table class="form-table">
    <tr><td class="lbl" colspan="6">Address: Street &nbsp; Unit # &nbsp; City &nbsp; State &nbsp; ZIP &nbsp; Country</td></tr>
    <tr><th>Property Value</th><th>Status</th><th>Occupancy</th><th>Monthly Taxes/Ins/HOA</th><th>Monthly Rental Income</th><th>Net Monthly Rental</th></tr>
    <tr><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
  </table>

  <div class="page-footer">
    <span>Borrower Name: <span data-field="borrower.fullName"></span></span>
    <span>Uniform Residential Loan Application &mdash; Freddie Mac Form 65 &bull; Fannie Mae Form 1003</span>
    <span>Page 4 of 11</span>
  </div>
</div>

<!-- ══════════════════════ PAGE 5 — Section 4 Loan & Property ══════════════════════ -->
<div class="page" id="page-5">
  <div class="section-header">Section 4: Loan and Property Information.</div>
  <div class="subsection-bar">This section asks about the loan's purpose and the property you want to purchase or refinance.</div>

  <div class="subsection-bar light">4a. Loan and Property Information</div>
  <table class="form-table">
    <colgroup><col style="width:30%"/><col style="width:70%"/></colgroup>
    <tr>
      <td class="lbl">Loan Amount $<span data-field="loan.amount" data-format="currency">&nbsp;</span></td>
      <td class="lbl">Loan Purpose
        <span class="opt"><span class="cb" id="cb-purchase">&#9744;</span>Purchase</span>
        <span class="opt"><span class="cb" id="cb-refinance">&#9744;</span>Refinance</span>
        <span class="opt"><span class="cb" id="cb-purpose-other">&#9744;</span>Other (specify): ______</span>
      </td>
    </tr>
    <tr>
      <td class="lbl" colspan="2">Property Address &mdash; Street <span data-field="loan.property.street">&nbsp;</span> &nbsp; Unit # <span data-field="loan.property.unit">&nbsp;</span></td>
    </tr>
    <tr>
      <td class="lbl">City <span data-field="loan.property.city">&nbsp;</span></td>
      <td class="lbl">State <span data-field="loan.property.state">&nbsp;</span> &nbsp; ZIP <span data-field="loan.property.zip">&nbsp;</span> &nbsp; County <span data-field="loan.property.county">&nbsp;</span> &nbsp; Country <span data-field="loan.property.country">USA</span></td>
    </tr>
    <tr>
      <td class="lbl">Number of Units <span data-field="loan.property.units">1</span></td>
      <td class="lbl">Property Value $<span data-field="loan.property.value" data-format="currency">&nbsp;</span></td>
    </tr>
    <tr>
      <td class="lbl" colspan="2">Occupancy
        <span class="opt"><span class="cb" id="cb-primary">&#9744;</span>Primary Residence</span>
        <span class="opt"><span class="cb" id="cb-second">&#9744;</span>Second Home</span>
        <span class="opt"><span class="cb" id="cb-investment">&#9744;</span>Investment Property</span>
        <span class="opt"><span class="cb" id="cb-fha-secondary">&#9744;</span>FHA Secondary Residence</span>
      </td>
    </tr>
    <tr>
      <td class="lbl" colspan="2">1. Mixed-Use Property. If you will occupy the property, will you set aside space within the property to operate your own business? (e.g., daycare facility, medical office, beauty/barber shop) &nbsp;&nbsp;
        <span class="opt"><span class="cb" id="cb-mixed-no">&#9744;</span>NO</span>
        <span class="opt"><span class="cb" id="cb-mixed-yes">&#9744;</span>YES</span>
      </td>
    </tr>
    <tr>
      <td class="lbl" colspan="2">2. Manufactured Home. Is the property a manufactured home? (e.g., a factory built dwelling built on a permanent chassis) &nbsp;&nbsp;
        <span class="opt"><span class="cb" id="cb-manufactured-no">&#9744;</span>NO</span>
        <span class="opt"><span class="cb" id="cb-manufactured-yes">&#9744;</span>YES</span>
      </td>
    </tr>
  </table>

  <div class="subsection-bar light">4b. Other New Mortgage Loans on the Property You are Buying or Refinancing &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply</div>
  <table class="form-table">
    <tr><th>Creditor Name</th><th>Lien Type (First Lien / Subordinate Lien)</th><th>Monthly Payment</th><th>Loan Amount / Amount to be Drawn</th><th>Credit Limit (if applicable)</th></tr>
    <tr><td class="val empty"></td><td class="val"><span class="cb">&#9744;</span>First <span class="cb">&#9744;</span>Subordinate</td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val"><span class="cb">&#9744;</span>First <span class="cb">&#9744;</span>Subordinate</td><td class="val empty"></td><td class="val empty"></td><td class="val empty"></td></tr>
  </table>

  <div class="subsection-bar light">4c. Rental Income on the Property You Want to Purchase (For Purchase Only) &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply</div>
  <table class="form-table">
    <colgroup><col style="width:70%"/><col style="width:30%"/></colgroup>
    <tr><td class="lbl">Expected Monthly Rental Income</td><td class="val empty"></td></tr>
    <tr><td class="lbl">Expected Net Monthly Rental Income (for LENDER to calculate)</td><td class="val empty"></td></tr>
  </table>

  <div class="subsection-bar light">4d. Gifts or Grants You Have Been Given or Will Receive for this Loan &nbsp;&nbsp;<span class="cb">&#9744;</span>Does not apply</div>
  <div style="border:0.5pt solid #000;border-top:0;padding:4px 8px;font-size:7pt;background:#fafafa">
    <b>Asset Types:</b> Cash Gift &bull; Gift of Equity &bull; Grant<br/>
    <b>Sources:</b> Community Nonprofit &bull; Employer &bull; Federal Agency &bull; Local Agency &bull; Relative &bull; Religious Nonprofit &bull; State Agency &bull; Unmarried Partner &bull; Other
  </div>
  <table class="form-table">
    <tr><th>Asset Type</th><th>Deposited / Not Deposited</th><th>Source</th><th>Cash or Market Value</th></tr>
    <tr><td class="val empty"></td><td class="val"><span class="cb">&#9744;</span>Deposited <span class="cb">&#9744;</span>Not Deposited</td><td class="val empty"></td><td class="val empty"></td></tr>
    <tr><td class="val empty"></td><td class="val"><span class="cb">&#9744;</span>Deposited <span class="cb">&#9744;</span>Not Deposited</td><td class="val empty"></td><td class="val empty"></td></tr>
  </table>

  <div class="page-footer">
    <span>Borrower Name: <span data-field="borrower.fullName"></span></span>
    <span>Uniform Residential Loan Application &mdash; Freddie Mac Form 65 &bull; Fannie Mae Form 1003</span>
    <span>Page 5 of 11</span>
  </div>
</div>

<!-- ══════════════════════ PAGE 6 — Section 5 Declarations ══════════════════════ -->
<div class="page" id="page-6">
  <div class="section-header">Section 5: Declarations.</div>
  <div class="subsection-bar">This section asks you specific questions about the property, your funding, and your past financial history.</div>

  <div class="subsection-bar light">5a. About this Property and Your Money for this Loan</div>
  <div class="decl"><span>A. Will you occupy the property as your primary residence?</span><span class="yn"><span class="opt"><span class="cb" id="decl-a-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="decl-a-yes">&#9744;</span>YES</span></span></div>
  <div class="decl"><span style="padding-left:14pt;color:#444;font-size:7.5pt">If YES, have you had an ownership interest in another property in the last three years? If YES: (1) What type of property did you own (Primary Residence = PR, FHA Secondary Residence = SR, Second Home = SH, or Investment Property = IP)? ______ &nbsp; (2) How did you hold title to the property: Solely (S), Jointly with Spouse (SP), or Jointly with Another Person (O)? ______</span><span class="yn">&nbsp;</span></div>
  <div class="decl"><span>B. If this is a Purchase Transaction: Do you have a family relationship or business affiliation with the seller of the property?</span><span class="yn"><span class="opt"><span class="cb" id="decl-b-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="decl-b-yes">&#9744;</span>YES</span></span></div>
  <div class="decl"><span>C. Are you borrowing any money for this real estate transaction (e.g., money for your closing costs or down payment) or obtaining any money from another party, such as the seller or realtor, that you have not disclosed on this loan application?</span><span class="yn"><span class="opt"><span class="cb" id="decl-c-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="decl-c-yes">&#9744;</span>YES</span></span></div>
  <div class="decl"><span style="padding-left:14pt;color:#444;font-size:7.5pt">If YES, what is the amount of this money? $______</span><span class="yn">&nbsp;</span></div>
  <div class="decl"><span>D. 1. Have you or will you be applying for a mortgage loan on another property (not the property securing this loan) on or before closing this transaction that is not disclosed on this loan application?</span><span class="yn"><span class="opt"><span class="cb" id="decl-d1-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="decl-d1-yes">&#9744;</span>YES</span></span></div>
  <div class="decl"><span>&nbsp;&nbsp;&nbsp;2. Have you or will you be applying for any new credit (e.g., installment loan, credit card, etc.) on or before closing this loan that is not disclosed on this application?</span><span class="yn"><span class="opt"><span class="cb" id="decl-d2-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="decl-d2-yes">&#9744;</span>YES</span></span></div>
  <div class="decl"><span>E. Will this property be subject to a lien that could take priority over the first mortgage lien, such as a clean energy lien paid through your property taxes (e.g., the Property Assessed Clean Energy Program)?</span><span class="yn"><span class="opt"><span class="cb" id="decl-e-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="decl-e-yes">&#9744;</span>YES</span></span></div>

  <div class="subsection-bar light">5b. About Your Finances</div>
  <div class="decl"><span>F. Are you a co-signer or guarantor on any debt or loan that is not disclosed on this application?</span><span class="yn"><span class="opt"><span class="cb" id="decl-f-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="decl-f-yes">&#9744;</span>YES</span></span></div>
  <div class="decl"><span>G. Are there any outstanding judgments against you?</span><span class="yn"><span class="opt"><span class="cb" id="decl-g-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="decl-g-yes">&#9744;</span>YES</span></span></div>
  <div class="decl"><span>H. Are you currently delinquent or in default on a Federal debt?</span><span class="yn"><span class="opt"><span class="cb" id="decl-h-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="decl-h-yes">&#9744;</span>YES</span></span></div>
  <div class="decl"><span>I. Are you a party to a lawsuit in which you potentially have any personal financial liability?</span><span class="yn"><span class="opt"><span class="cb" id="decl-i-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="decl-i-yes">&#9744;</span>YES</span></span></div>
  <div class="decl"><span>J. Have you conveyed title to any property in lieu of foreclosure in the past 7 years?</span><span class="yn"><span class="opt"><span class="cb" id="decl-j-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="decl-j-yes">&#9744;</span>YES</span></span></div>
  <div class="decl"><span>K. Within the past 7 years, have you completed a pre-foreclosure sale or short sale, whereby the property was sold to a third party and the Lender agreed to accept less than the outstanding mortgage balance due?</span><span class="yn"><span class="opt"><span class="cb" id="decl-k-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="decl-k-yes">&#9744;</span>YES</span></span></div>
  <div class="decl"><span>L. Have you had property foreclosed upon in the last 7 years?</span><span class="yn"><span class="opt"><span class="cb" id="decl-l-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="decl-l-yes">&#9744;</span>YES</span></span></div>
  <div class="decl"><span>M. Have you declared bankruptcy within the past 7 years?</span><span class="yn"><span class="opt"><span class="cb" id="decl-m-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="decl-m-yes">&#9744;</span>YES</span></span></div>
  <div class="decl"><span>&nbsp;&nbsp;&nbsp;If YES, identify the type(s) of bankruptcy:
    <span class="opt"><span class="cb" id="cb-bk-7">&#9744;</span>Chapter 7</span>
    <span class="opt"><span class="cb" id="cb-bk-11">&#9744;</span>Chapter 11</span>
    <span class="opt"><span class="cb" id="cb-bk-12">&#9744;</span>Chapter 12</span>
    <span class="opt"><span class="cb" id="cb-bk-13">&#9744;</span>Chapter 13</span>
  </span><span class="yn">&nbsp;</span></div>

  <div class="page-footer">
    <span>Borrower Name: <span data-field="borrower.fullName"></span></span>
    <span>Uniform Residential Loan Application &mdash; Freddie Mac Form 65 &bull; Fannie Mae Form 1003</span>
    <span>Page 6 of 11</span>
  </div>
</div>

<!-- ══════════════════════ PAGE 7 — Section 6 Acknowledgements ══════════════════════ -->
<div class="page" id="page-7">
  <div class="section-header">Section 6: Acknowledgements and Agreements.</div>
  <div class="subsection-bar">This section tells you about your legal obligations when you sign this application.</div>
  <div class="subsection-bar light">Acknowledgements and Agreements</div>

  <div class="ack">
    <p>The undersigned acknowledges and agrees to the following in connection with the mortgage loan (the "Loan") this application is requesting. "I" and "my" refers to the undersigned. "Lender" refers to the Lender, its agents, service providers, and any of their successors and assigns. "Other Loan Participants" includes any actual or potential owners of the Loan, acquirers of any beneficial or other interest in the Loan, any mortgage insurer, guarantor, any servicers or service providers for these parties, and any of their successors and assigns.</p>
    <div class="cols">
      <p><b>(1) The Complete Information for this Application</b> &mdash; The information I have provided in this application is true, accurate, and complete as of the date I signed this application. If the information I provided changes or is inaccurate on or before the closing date of the Loan, I will inform the Lender. I understand that: (a) the Lender and Other Loan Participants may take any action permitted by law and the Loan documents, and (b) I may be liable for monetary damages to the Lender and any Other Loan Participants due to my providing false or misleading information.</p>
      <p><b>(2) The Property's Security</b> &mdash; The Loan I have applied for in this application will be secured by a mortgage or deed of trust which provides the Lender a security interest in the property described in this application.</p>
      <p><b>(3) The Property's Appraisal, Value, and Condition</b> &mdash; Any appraisal or value of the property obtained by the Lender is for use by the Lender and Other Loan Participants. The Lender and Other Loan Participants have not made any representation or warranty, express or implied, regarding the property, its condition, or its value.</p>
      <p><b>(4) Electronic Records and Signatures</b> &mdash; The Lender and Other Loan Participants may keep any paper record and/or electronic record of this application, whether or not the Loan is approved. If this application is created as (or converted into) an "electronic application," I consent to the use of "electronic records" and "electronic signatures" as those terms are defined in applicable Federal and/or state laws (excluding audio and video recordings), or as otherwise provided by applicable law. I further agree that the Lender and Other Loan Participants may retain a paper or electronic copy of this application.</p>
      <p><b>(5) Delinquency</b> &mdash; The Lender and Other Loan Participants may report information about my account to credit bureaus. Late payments, missed payments, or other defaults on my account may be reflected in my credit report and will likely affect my credit score.</p>
      <p><b>(6) Authorization for Use and Sharing of Information</b> &mdash; By signing below, I authorize the Lender and Other Loan Participants, without any further notice or consent, to any or all of the following actions: (a) process and underwrite my application for the Loan; (b) verify any information contained in my application and in any other documents or information I provide, or that the Lender or Other Loan Participants use, in connection with my application; (c) obtain any information or data relating to the Loan or me, including but not limited to, my employment, income, assets, credit, and debt, including from a credit reporting agency and any other third party; (d) share my information and the Loan with investors, servicers, insurers, guarantors, appraisers, settlement agents, third-party service providers, and their affiliates; (e) perform required loan quality control reviews including ordering new appraisals, credit reports, title reports, and verifications; and (f) market my application to others who may have an interest in the Loan.</p>
      <p><b>(7) The Borrower's Right to Receive a Copy of the Appraisal</b> &mdash; I have the right to receive a copy of any written appraisal prepared in connection with this application for the Loan at least three (3) business days before my Loan closes.</p>
      <p><b>(8) Other Acknowledgements</b> &mdash; I agree that the Lender and Other Loan Participants may provide information about the Loan to Other Loan Participants, and that any Loan disclosures sent to me may be delivered electronically. I consent to being contacted by the Lender or its representatives regarding my application, by telephone (including cellular), text, or email.</p>
    </div>
  </div>

  <div class="sig-row">
    <div class="sig-box"><div class="line"></div><div class="lbl2">Borrower Signature &nbsp;&nbsp;&nbsp; <span data-field="borrower.fullName"></span></div></div>
    <div class="sig-box" style="flex:0 0 25%"><div class="line"></div><div class="lbl2">Date (mm/dd/yyyy)</div></div>
  </div>
  <div class="sig-row">
    <div class="sig-box"><div class="line"></div><div class="lbl2">Co-Borrower Signature &nbsp;&nbsp;&nbsp; <span data-field="coBorrower.fullName"></span></div></div>
    <div class="sig-box" style="flex:0 0 25%"><div class="line"></div><div class="lbl2">Date (mm/dd/yyyy)</div></div>
  </div>

  <div class="page-footer">
    <span>Borrower Name: <span data-field="borrower.fullName"></span></span>
    <span>Uniform Residential Loan Application &mdash; Freddie Mac Form 65 &bull; Fannie Mae Form 1003</span>
    <span>Page 7 of 11</span>
  </div>
</div>

<!-- ══════════════════════ PAGE 8 — Section 7 Military + Section 8 Demographics ══════════════════════ -->
<div class="page" id="page-8">
  <div class="section-header">Section 7: Military Service.</div>
  <div class="subsection-bar">This section asks questions about your (or your deceased spouse's) military service.</div>
  <div class="subsection-bar light">Military Service of Borrower</div>

  <div class="decl"><span>Military Service &mdash; Did you (or your deceased spouse) ever serve, or are you currently serving, in the United States Armed Forces?</span><span class="yn"><span class="opt"><span class="cb" id="cb-military-no">&#9744;</span>NO</span><span class="opt"><span class="cb" id="cb-military-yes">&#9744;</span>YES</span></span></div>
  <table class="form-table">
    <tr><td class="lbl">If YES, check all that apply:
      <div class="opt-block"><span class="cb" id="cb-mil-active">&#9744;</span>Currently serving on active duty with projected expiration date of service/tour ______</div>
      <div class="opt-block"><span class="cb" id="cb-mil-retired">&#9744;</span>Currently retired, discharged, or separated from service</div>
      <div class="opt-block"><span class="cb" id="cb-mil-reserve">&#9744;</span>Only period of service was as a non-activated member of the Reserve or National Guard</div>
      <div class="opt-block"><span class="cb" id="cb-mil-surviving">&#9744;</span>Surviving spouse</div>
    </td></tr>
  </table>

  <div class="section-header" style="margin-top:10px">Section 8: Demographic Information.</div>
  <div class="subsection-bar">This section asks about your ethnicity, sex, and race.</div>
  <div class="subsection-bar light">Demographic Information of Borrower</div>

  <div class="ack" style="border-bottom:0">
    <p>The purpose of collecting this information is to help ensure that all applicants are treated fairly and that the housing needs of communities and neighborhoods are being fulfilled. For residential mortgage lending, Federal law requires that we ask applicants for their demographic information (ethnicity, sex, and race) in order to monitor our compliance with equal credit opportunity, fair housing, and home mortgage disclosure laws. You are not required to provide this information, but are encouraged to do so. You may select one or more designations for "Ethnicity" and one or more designations for "Race." The law provides that we may not discriminate on the basis of this information, or on whether you choose to provide it. However, if you choose not to provide the information and you have made this application in person, Federal regulations require us to note your ethnicity, sex, and race on the basis of visual observation or surname. The law also provides that we may not discriminate on the basis of age or marital status information you provide in this application. If you do not wish to provide some or all of this information, please check below.</p>
  </div>

  <table class="form-table">
    <colgroup><col style="width:50%"/><col style="width:50%"/></colgroup>
    <tr>
      <th>Ethnicity &mdash; Check one or more</th>
      <th>Race &mdash; Check one or more</th>
    </tr>
    <tr>
      <td class="val">
        <div class="opt-block"><span class="cb">&#9744;</span>Hispanic or Latino</div>
        <div style="padding-left:14pt">
          <span class="opt"><span class="cb">&#9744;</span>Mexican</span>
          <span class="opt"><span class="cb">&#9744;</span>Puerto Rican</span>
          <span class="opt"><span class="cb">&#9744;</span>Cuban</span>
        </div>
        <div style="padding-left:14pt"><span class="cb">&#9744;</span>Other Hispanic or Latino &mdash; Print origin: ______</div>
        <div class="opt-block"><span class="cb">&#9744;</span>Not Hispanic or Latino</div>
        <div class="opt-block"><span class="cb">&#9744;</span>I do not wish to provide this information</div>
      </td>
      <td class="val">
        <div class="opt-block"><span class="cb">&#9744;</span>American Indian or Alaska Native &mdash; Enrolled or principal tribe: ______</div>
        <div class="opt-block"><span class="cb">&#9744;</span>Asian</div>
        <div style="padding-left:14pt">
          <span class="opt"><span class="cb">&#9744;</span>Asian Indian</span>
          <span class="opt"><span class="cb">&#9744;</span>Chinese</span>
          <span class="opt"><span class="cb">&#9744;</span>Filipino</span>
        </div>
        <div style="padding-left:14pt">
          <span class="opt"><span class="cb">&#9744;</span>Japanese</span>
          <span class="opt"><span class="cb">&#9744;</span>Korean</span>
          <span class="opt"><span class="cb">&#9744;</span>Vietnamese</span>
        </div>
        <div style="padding-left:14pt"><span class="cb">&#9744;</span>Other Asian &mdash; Print race: ______</div>
        <div class="opt-block"><span class="cb">&#9744;</span>Black or African American</div>
        <div class="opt-block"><span class="cb">&#9744;</span>Native Hawaiian or Other Pacific Islander</div>
        <div style="padding-left:14pt">
          <span class="opt"><span class="cb">&#9744;</span>Native Hawaiian</span>
          <span class="opt"><span class="cb">&#9744;</span>Guamanian or Chamorro</span>
          <span class="opt"><span class="cb">&#9744;</span>Samoan</span>
        </div>
        <div class="opt-block"><span class="cb">&#9744;</span>White</div>
        <div class="opt-block"><span class="cb">&#9744;</span>I do not wish to provide this information</div>
      </td>
    </tr>
    <tr>
      <td class="lbl" colspan="2">Sex
        <span class="opt"><span class="cb">&#9744;</span>Female</span>
        <span class="opt"><span class="cb">&#9744;</span>Male</span>
        <span class="opt"><span class="cb">&#9744;</span>I do not wish to provide this information</span>
      </td>
    </tr>
  </table>

  <div class="subsection-bar light">To Be Completed by Financial Institution (for application taken in person):</div>
  <table class="form-table">
    <tr><td class="lbl">Was the ethnicity of the Borrower collected on the basis of visual observation or surname?</td><td class="lbl" style="width:120pt"><span class="opt"><span class="cb">&#9744;</span>NO</span><span class="opt"><span class="cb">&#9744;</span>YES</span></td></tr>
    <tr><td class="lbl">Was the sex of the Borrower collected on the basis of visual observation or surname?</td><td class="lbl"><span class="opt"><span class="cb">&#9744;</span>NO</span><span class="opt"><span class="cb">&#9744;</span>YES</span></td></tr>
    <tr><td class="lbl">Was the race of the Borrower collected on the basis of visual observation or surname?</td><td class="lbl"><span class="opt"><span class="cb">&#9744;</span>NO</span><span class="opt"><span class="cb">&#9744;</span>YES</span></td></tr>
    <tr><td class="lbl" colspan="2">The Demographic Information was provided through:
      <span class="opt"><span class="cb">&#9744;</span>Face-to-Face Interview (includes Electronic Media w/ Video Component)</span>
      <span class="opt"><span class="cb">&#9744;</span>Telephone Interview</span>
      <span class="opt"><span class="cb">&#9744;</span>Fax or Mail</span>
      <span class="opt"><span class="cb">&#9744;</span>Email or Internet</span>
    </td></tr>
  </table>

  <div class="page-footer">
    <span>Borrower Name: <span data-field="borrower.fullName"></span></span>
    <span>Uniform Residential Loan Application &mdash; Freddie Mac Form 65 &bull; Fannie Mae Form 1003</span>
    <span>Page 8 of 11</span>
  </div>
</div>

<!-- ══════════════════════ PAGE 9 — Section 9 LO Info ══════════════════════ -->
<div class="page" id="page-9">
  <div class="section-header">Section 9: Loan Originator Information.</div>
  <div class="subsection-bar">To be completed by your Loan Originator.</div>
  <div class="subsection-bar light">Loan Originator Information</div>

  <table class="form-table">
    <tr><td class="lbl" colspan="4">Loan Originator Organization Name<div class="val" data-field="lo.orgName">&nbsp;</div></td></tr>
    <tr><td class="lbl" colspan="4">Address<div class="val" data-field="lo.orgAddress">&nbsp;</div></td></tr>
    <tr>
      <td class="lbl" style="width:25%">Loan Originator Organization NMLSR ID#<div class="val" data-field="lo.orgNmls">&nbsp;</div></td>
      <td class="lbl" style="width:25%">State License ID#<div class="val" data-field="lo.orgLicense">&nbsp;</div></td>
      <td class="lbl" style="width:25%">Loan Originator Name<div class="val" data-field="lo.loName">&nbsp;</div></td>
      <td class="lbl" style="width:25%">Loan Originator NMLSR ID#<div class="val" data-field="lo.loNmls">&nbsp;</div></td>
    </tr>
    <tr>
      <td class="lbl">State License ID#<div class="val" data-field="lo.loLicense">&nbsp;</div></td>
      <td class="lbl">Email<div class="val" data-field="lo.email">&nbsp;</div></td>
      <td class="lbl" colspan="2">Phone<div class="val" data-field="lo.phone">&nbsp;</div></td>
    </tr>
    <tr>
      <td class="lbl" colspan="3">Signature<div style="height:24px;border-bottom:1px solid #000"></div></td>
      <td class="lbl">Date (mm/dd/yyyy)<div style="height:24px;border-bottom:1px solid #000"></div></td>
    </tr>
  </table>

  <div class="page-footer">
    <span>Borrower Name: <span data-field="borrower.fullName"></span></span>
    <span>Uniform Residential Loan Application &mdash; Freddie Mac Form 65 &bull; Fannie Mae Form 1003</span>
    <span>Page 9 of 11</span>
  </div>
</div>

<!-- ══════════════════════ PAGE 10 — Lender Loan Information (L1, L2, L3) ══════════════════════ -->
<div class="page" id="page-10">
  <div class="lender-bar">
    <div class="fld"><b>To be completed by the Lender:</b></div>
    <div class="fld"><b>Lender Loan No./Universal Loan Identifier</b><div class="v" data-field="lender.loanNo">&nbsp;</div></div>
    <div class="fld"><b>Agency Case No.</b><div class="v" data-field="lender.agencyCaseNo">&nbsp;</div></div>
  </div>
  <div class="form-title" style="font-size:16pt">Uniform Residential Loan Application &mdash; Lender Loan Information</div>
  <div class="form-subtitle">This section is completed by your Lender.</div>

  <div class="subsection-bar">L1. Property and Loan Information</div>
  <table class="form-table">
    <colgroup><col style="width:22%"/><col style="width:78%"/></colgroup>
    <tr><td class="lbl">Community Property State</td><td class="val">
      <div class="opt-block"><span class="cb">&#9744;</span>At least one borrower lives in a community property state.</div>
      <div class="opt-block"><span class="cb">&#9744;</span>The property is in a community property state.</div>
    </td></tr>
    <tr><td class="lbl">Transaction Detail</td><td class="val">
      <div class="opt-block"><span class="cb">&#9744;</span>Conversion of Contract for Deed or Land Contract</div>
      <div class="opt-block"><span class="cb">&#9744;</span>Renovation</div>
      <div class="opt-block"><span class="cb">&#9744;</span>Construction-Conversion / Construction-to-Permanent &mdash; <span class="opt"><span class="cb">&#9744;</span>Single-Closing</span><span class="opt"><span class="cb">&#9744;</span>Two-Closing</span></div>
      <div class="opt-block"><span class="cb">&#9744;</span>Construction / Renovation &mdash; Construction/Improvement Costs $______ &nbsp; Lot Acquired Date _____ &nbsp; Original Cost $______</div>
    </td></tr>
    <tr><td class="lbl">Refinance Type</td><td class="val">
      <span class="opt"><span class="cb">&#9744;</span>No Cash Out</span>
      <span class="opt"><span class="cb">&#9744;</span>Limited Cash Out</span>
      <span class="opt"><span class="cb">&#9744;</span>Cash Out</span>
    </td></tr>
    <tr><td class="lbl">Refinance Program</td><td class="val">
      <span class="opt"><span class="cb">&#9744;</span>Full Documentation</span>
      <span class="opt"><span class="cb">&#9744;</span>Interest Rate Reduction</span>
      <span class="opt"><span class="cb">&#9744;</span>Streamlined without Appraisal</span>
      <span class="opt"><span class="cb">&#9744;</span>Other: ______</span>
    </td></tr>
    <tr><td class="lbl">Energy Improvement</td><td class="val">
      <div class="opt-block"><span class="cb">&#9744;</span>Mortgage loan will finance energy-related improvements.</div>
      <div class="opt-block"><span class="cb">&#9744;</span>Property is currently subject to a lien that could take priority over the first mortgage lien for energy-related improvements.</div>
    </td></tr>
    <tr><td class="lbl">Project Type</td><td class="val">
      <span class="opt"><span class="cb">&#9744;</span>Condominium</span>
      <span class="opt"><span class="cb">&#9744;</span>Cooperative</span>
      <span class="opt"><span class="cb">&#9744;</span>Planned Unit Development (PUD)</span>
      <span class="opt"><span class="cb">&#9744;</span>Property is not located in a project</span>
    </td></tr>
  </table>

  <div class="subsection-bar">L2. Title Information</div>
  <table class="form-table">
    <colgroup><col style="width:22%"/><col style="width:78%"/></colgroup>
    <tr><td class="lbl">Title to the Property Will be Held In What Name(s)</td><td class="val"><span data-field="borrower.fullName"></span> <span data-field="coBorrower.fullName"></span></td></tr>
    <tr><td class="lbl">For Refinance: Title to the Property is Currently Held In What Name(s)</td><td class="val">&nbsp;</td></tr>
    <tr><td class="lbl">Estate Will be Held In</td><td class="val">
      <span class="opt"><span class="cb">&#9744;</span>Fee Simple</span>
      <span class="opt"><span class="cb">&#9744;</span>Leasehold &mdash; Expiration Date: ______</span>
    </td></tr>
    <tr><td class="lbl">Manner in Which Title Will be Held</td><td class="val">
      <span class="opt"><span class="cb">&#9744;</span>Sole Ownership</span>
      <span class="opt"><span class="cb">&#9744;</span>Joint Tenancy with Right of Survivorship</span>
      <span class="opt"><span class="cb">&#9744;</span>Tenancy by the Entirety</span>
      <span class="opt"><span class="cb">&#9744;</span>Tenancy in Common</span>
      <span class="opt"><span class="cb">&#9744;</span>Life Estate</span>
      <span class="opt"><span class="cb">&#9744;</span>Other: ______</span>
    </td></tr>
    <tr><td class="lbl">Trust Information</td><td class="val">
      <span class="opt"><span class="cb">&#9744;</span>Title Will be Held in a Land Trust</span>
      <span class="opt"><span class="cb">&#9744;</span>Title Will be Held in an Inter Vivos (Living) Trust</span>
    </td></tr>
    <tr><td class="lbl">Indian Country Land Tenure</td><td class="val">
      <span class="opt"><span class="cb">&#9744;</span>Fee Simple On a Reservation</span>
      <span class="opt"><span class="cb">&#9744;</span>Individual Trust Land (Allotted/Restricted)</span>
      <span class="opt"><span class="cb">&#9744;</span>Tribal Trust Land On a Reservation</span>
      <span class="opt"><span class="cb">&#9744;</span>Tribal Trust Land Off Reservation</span>
      <span class="opt"><span class="cb">&#9744;</span>Alaska Native Corporation Land</span>
    </td></tr>
  </table>

  <div class="subsection-bar">L3. Mortgage Loan Information</div>
  <table class="form-table">
    <colgroup><col style="width:22%"/><col style="width:48%"/><col style="width:30%"/></colgroup>
    <tr>
      <td class="lbl">Mortgage Type Applied For</td>
      <td class="val">
        <span class="opt"><span class="cb" id="cb-conventional">&#9744;</span>Conventional</span>
        <span class="opt"><span class="cb" id="cb-usda">&#9744;</span>USDA-RD</span>
        <span class="opt"><span class="cb" id="cb-fha">&#9744;</span>FHA</span>
        <span class="opt"><span class="cb" id="cb-va">&#9744;</span>VA</span>
        <span class="opt"><span class="cb">&#9744;</span>Other: ______</span>
      </td>
      <td class="lbl" rowspan="4">
        <b>Proposed Monthly Payment for Property</b>
        <div>First Mortgage (P&amp;I): $______</div>
        <div>Subordinate Lien(s) (P&amp;I): $______</div>
        <div>Homeowner's Insurance: $______</div>
        <div>Supplemental Property Insurance: $______</div>
        <div>Property Taxes: $______</div>
        <div>Mortgage Insurance: $______</div>
        <div>Association/Project Dues (Condo, Co-Op, PUD): $______</div>
        <div>Other: $______</div>
        <div style="background:#1a1a2e;color:#fff;padding:3px;margin-top:3px"><b>TOTAL: $______</b></div>
      </td>
    </tr>
    <tr>
      <td class="lbl">Terms of Loan</td>
      <td class="val">Note Rate: <span data-field="loan.interestRate">&nbsp;</span>% &nbsp;&nbsp; Loan Term: <span data-field="loan.termMonths">&nbsp;</span> (months)</td>
    </tr>
    <tr>
      <td class="lbl">Mortgage Lien Type</td>
      <td class="val">
        <span class="opt"><span class="cb">&#9744;</span>First Lien</span>
        <span class="opt"><span class="cb">&#9744;</span>Subordinate Lien</span>
      </td>
    </tr>
    <tr>
      <td class="lbl">Amortization Type</td>
      <td class="val">
        <span class="opt"><span class="cb">&#9744;</span>Fixed Rate</span>
        <span class="opt"><span class="cb">&#9744;</span>Adjustable Rate — initial period prior to first adjustment ___ months</span>
        <span class="opt"><span class="cb">&#9744;</span>Other</span>
      </td>
    </tr>
    <tr>
      <td class="lbl">Loan Features</td>
      <td class="val" colspan="2">
        <span class="opt"><span class="cb">&#9744;</span>Balloon / Term ___</span>
        <span class="opt"><span class="cb">&#9744;</span>Interest Only / Term ___</span>
        <span class="opt"><span class="cb">&#9744;</span>Negative Amortization</span>
        <span class="opt"><span class="cb">&#9744;</span>Prepayment Penalty / Term ___</span>
        <span class="opt"><span class="cb">&#9744;</span>Temporary Interest Rate Buydown / Initial Rate ___%</span>
        <span class="opt"><span class="cb">&#9744;</span>Other: ______</span>
      </td>
    </tr>
  </table>

  <div class="page-footer">
    <span>Borrower Name: <span data-field="borrower.fullName"></span></span>
    <span>Uniform Residential Loan Application &mdash; Freddie Mac Form 65 &bull; Fannie Mae Form 1003</span>
    <span>Page 10 of 11</span>
  </div>
</div>

<!-- ══════════════════════ PAGE 11 — L4 Qualifying the Borrower ══════════════════════ -->
<div class="page" id="page-11">
  <div class="subsection-bar">L4. Qualifying the Borrower &mdash; Minimum Required Funds or Cash Back</div>
  <table class="form-table">
    <colgroup><col style="width:6%"/><col style="width:70%"/><col style="width:24%"/></colgroup>
    <tr><td class="lbl" colspan="3">DUE FROM BORROWER(S)</td></tr>
    <tr><td class="val" style="text-align:center">A.</td><td class="val">Sales Contract Price</td><td class="val" data-field="loan.property.value" data-format="currency">&nbsp;</td></tr>
    <tr><td class="val" style="text-align:center">B.</td><td class="val">Improvements, Renovations, and Repairs</td><td class="val empty"></td></tr>
    <tr><td class="val" style="text-align:center">C.</td><td class="val">Land (if acquired separately)</td><td class="val empty"></td></tr>
    <tr><td class="val" style="text-align:center">D.</td><td class="val">For Refinance: Balance of Mortgage Loans on the Property to be paid off in the Transaction (See Table 3a. Property You Own)</td><td class="val empty"></td></tr>
    <tr><td class="val" style="text-align:center">E.</td><td class="val">Credit Cards and Other Debts Paid Off (See Table 2c. Liabilities &mdash; Credit Cards, Other Debts, and Leases that You Owe)</td><td class="val empty"></td></tr>
    <tr><td class="val" style="text-align:center">F.</td><td class="val">Borrower Closing Costs (including Prepaid Items)</td><td class="val empty"></td></tr>
    <tr><td class="val" style="text-align:center">G.</td><td class="val">Discount Points</td><td class="val empty"></td></tr>
    <tr style="background:#eaeaea;font-weight:bold"><td class="val" style="text-align:center"><b>H.</b></td><td class="val"><b>TOTAL DUE FROM BORROWER(s)</b> (Total of A thru G)</td><td class="val">&nbsp;</td></tr>

    <tr><td class="lbl" colspan="3">TOTAL MORTGAGE LOANS</td></tr>
    <tr><td class="val" style="text-align:center">I.</td><td class="val">Loan Amount &mdash; Loan Amount Excluding Financed Mortgage Insurance (or Mortgage Insurance Equivalent) $<span data-field="loan.amount" data-format="currency"></span> &nbsp; Financed Mortgage Insurance (or Mortgage Insurance Equivalent) Amount $______</td><td class="val" data-field="loan.amount" data-format="currency">&nbsp;</td></tr>
    <tr><td class="val" style="text-align:center">J.</td><td class="val">Other New Mortgage Loans on the Property the Borrower(s) is Buying or Refinancing (See Table 4b. Other New Mortgage Loans)</td><td class="val empty"></td></tr>
    <tr style="background:#eaeaea;font-weight:bold"><td class="val" style="text-align:center"><b>K.</b></td><td class="val"><b>TOTAL MORTGAGE LOANS</b> (Total of I and J)</td><td class="val" data-field="loan.amount" data-format="currency">&nbsp;</td></tr>

    <tr><td class="lbl" colspan="3">TOTAL CREDITS</td></tr>
    <tr><td class="val" style="text-align:center">L.</td><td class="val">Seller Credits (See Table 4d. Gifts or Grants)</td><td class="val empty"></td></tr>
    <tr><td class="val" style="text-align:center">M.</td><td class="val">Other Credits (See Table 2b. Other Assets and Credits)</td><td class="val empty"></td></tr>
    <tr style="background:#eaeaea;font-weight:bold"><td class="val" style="text-align:center"><b>N.</b></td><td class="val"><b>TOTAL CREDITS</b> (Total of L and M)</td><td class="val">&nbsp;</td></tr>

    <tr><td class="lbl" colspan="3">CALCULATION</td></tr>
    <tr><td class="val">&nbsp;</td><td class="val">TOTAL DUE FROM BORROWER(s) (Line H)</td><td class="val empty"></td></tr>
    <tr><td class="val">&nbsp;</td><td class="val">LESS TOTAL MORTGAGE LOANS (Line K) AND TOTAL CREDITS (Line N)</td><td class="val" data-field="loan.amount" data-format="currency">&nbsp;</td></tr>
    <tr style="background:#1a1a2e;color:#fff;font-weight:bold">
      <td class="val" style="text-align:center;background:#1a1a2e;color:#fff"><b></b></td>
      <td class="val" style="background:#1a1a2e;color:#fff"><b>Cash From/To the Borrower</b> (Line H minus Line K and Line N) &mdash; <i>NOTE: This amount does not include reserves or other funds that may be required by the Lender to be verified.</i></td>
      <td class="val" style="background:#f5f5f5;color:#000">&nbsp;</td>
    </tr>
  </table>

  <div class="page-footer">
    <span>Borrower Name: <span data-field="borrower.fullName"></span></span>
    <span>Uniform Residential Loan Application &mdash; Freddie Mac Form 65 &bull; Fannie Mae Form 1003</span>
    <span>Page 11 of 11</span>
  </div>
</div>

<script src="script.js"></script>
</body>
</html>
`;

export const URLA_JS = String.raw`/* URLA 1003 — Client-side fill logic
 * Reads window.URLA_DATA (injected by the edge function) and populates
 * every [data-field] element + all checkbox spans.
 */

const URLA = {
  fill(data) {
    if (!data) return;

    // Populate data-field targets — supports nested paths like "borrower.fullName"
    document.querySelectorAll('[data-field]').forEach((el) => {
      const path = el.getAttribute('data-field');
      let val = this.getPath(data, path);
      if (val === undefined || val === null) val = '';

      // Apply formatting hints
      const fmt = el.getAttribute('data-format');
      if (fmt === 'currency') val = this.formatCurrency(val);
      else if (fmt === 'date') val = this.formatDate(val);
      else if (fmt === 'ssn') val = this.formatSSN(val);
      else if (fmt === 'percent' && val) val = val + '%';

      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = val;
      else el.textContent = val;
    });

    this.fillCheckboxes(data);
  },

  getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  },

  setCb(id, on) {
    const el = document.getElementById(id);
    if (el) el.textContent = on ? '\u2611' : '\u2610'; // ☑ / ☐
  },

  fillCheckboxes(data) {
    const b = data.borrower || {};
    const l = data.loan || {};
    const decl = data.declarations || {};

    // Citizenship
    const cit = String(b.citizenship || '').toLowerCase().replace(/[^a-z]/g, '');
    this.setCb('cb-citizen', cit === 'uscitizen' || cit === 'usacitizen');
    this.setCb('cb-perm', cit === 'permanentresidentalien' || cit === 'permanentresident');
    this.setCb('cb-nonperm', cit === 'nonpermanentresidentalien' || cit === 'nonpermanentresident');

    // Credit type (individual/joint)
    const hasCoBorrower = !!(data.coBorrower && data.coBorrower.fullName);
    this.setCb('cb-credit-individual', !hasCoBorrower);
    this.setCb('cb-credit-joint', hasCoBorrower);

    // Marital Status
    const ms = String(b.maritalStatus || '').toLowerCase();
    this.setCb('cb-married', ms === 'married');
    this.setCb('cb-separated', ms === 'separated');
    this.setCb('cb-unmarried', ms.includes('unmarried') || ms.includes('single') || ms.includes('divorced'));

    // Housing (current address)
    const housing = String((b.currentAddress || {}).housing || '').toLowerCase();
    this.setCb('cb-housing-noexpense', housing.includes('no primary') || housing.includes('noexpense'));
    this.setCb('cb-housing-own', housing === 'own');
    this.setCb('cb-housing-rent', housing === 'rent');

    // Loan Purpose
    const lp = String(l.purpose || '').toLowerCase();
    this.setCb('cb-purchase', lp === 'purchase');
    this.setCb('cb-refinance', lp === 'refinance');
    this.setCb('cb-purpose-other', lp === 'other');

    // Occupancy
    const occ = String((l.property || {}).occupancy || '').toLowerCase();
    this.setCb('cb-primary', occ.includes('primary'));
    this.setCb('cb-second', occ.includes('second'));
    this.setCb('cb-investment', occ.includes('invest'));
    this.setCb('cb-fha-secondary', occ.includes('fha secondary'));

    // Mixed use / Manufactured
    this.setCb('cb-mixed-yes', !!(l.property && l.property.mixedUse));
    this.setCb('cb-mixed-no', !(l.property && l.property.mixedUse));
    this.setCb('cb-manufactured-yes', !!(l.property && l.property.manufactured));
    this.setCb('cb-manufactured-no', !(l.property && l.property.manufactured));

    // Loan Type
    const lt = String(l.type || '');
    this.setCb('cb-conventional', lt === 'Conventional');
    this.setCb('cb-fha', lt === 'FHA');
    this.setCb('cb-va', lt === 'VA');
    this.setCb('cb-usda', lt === 'USDA-RD' || lt === 'USDA');

    // Employment status (current)
    const emp = (data.employment || {}).current || {};
    this.setCb('cb-emp-company', !emp.selfEmployed);
    this.setCb('cb-emp-self', !!emp.selfEmployed);
    this.setCb('cb-emp-family', !!emp.familyEmployer);

    // Military
    const mil = !!b.militaryService;
    this.setCb('cb-military-no', !mil);
    this.setCb('cb-military-yes', mil);
    const milSt = String(b.militaryStatus || '');
    this.setCb('cb-mil-active', milSt === 'Currently serving');
    this.setCb('cb-mil-retired', milSt === 'Veteran');
    this.setCb('cb-mil-reserve', milSt === 'Reserve/National Guard');
    this.setCb('cb-mil-surviving', milSt === 'Surviving spouse');

    // Declarations A through M (including D.1 and D.2)
    ['a','b','c','d1','d2','e','f','g','h','i','j','k','l','m'].forEach((key) => {
      const v = decl[key];
      this.setCb('decl-' + key + '-yes', !!v);
      this.setCb('decl-' + key + '-no', !v);
    });

    // Bankruptcy chapters
    const bk = String(decl.bankruptcyType || '');
    this.setCb('cb-bk-7', bk.includes('7'));
    this.setCb('cb-bk-11', bk.includes('11'));
    this.setCb('cb-bk-12', bk.includes('12'));
    this.setCb('cb-bk-13', bk.includes('13'));
  },

  formatCurrency(val) {
    if (val == null || val === '') return '';
    const n = parseFloat(String(val).replace(/[$,]/g, ''));
    if (isNaN(n)) return String(val);
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  formatDate(val) {
    if (!val) return '';
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
  },

  formatSSN(val) {
    if (!val) return '';
    const s = String(val).replace(/\D/g, '');
    return s.length === 9 ? 'XXX-XX-' + s.slice(5) : String(val);
  },
};

// Auto-fill from window.URLA_DATA if present
(function () {
  if (typeof window !== 'undefined' && window.URLA_DATA) {
    try { URLA.fill(window.URLA_DATA); } catch (e) { console.error('[URLA] fill error', e); }
  }
})();
`;
