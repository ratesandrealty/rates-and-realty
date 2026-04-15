/* URLA 1003 — Field mapping and export helpers
 * Reference implementation showing how {{placeholders}} are filled.
 * The edge function (index.ts) performs the equivalent work server-side
 * via direct template-literal interpolation against the data object.
 */

// ─── Formatters ─────────────────────────────────────────────────────────
function formatCurrency(val) {
  if (val == null || val === '') return '';
  var n = parseFloat(String(val).replace(/[$,]/g, ''));
  if (isNaN(n)) return String(val);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(val) {
  if (!val) return '';
  try { return new Date(val).toLocaleDateString('en-US'); } catch (e) { return String(val); }
}

function formatSSN(val) {
  if (!val) return '';
  var s = String(val).replace(/\D/g, '');
  return s.length === 9 ? 'XXX-XX-' + s.slice(5) : String(val);
}

function chk(on) { return on ? '\u2611' : '\u2610'; } // ☑ / ☐

// ─── Citizenship normalizer ─────────────────────────────────────────────
function normalizeCitizenship(raw) {
  var c = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  return {
    us: c === 'uscitizen' || c === 'usacitizen',
    perm: c === 'permanentresidentalien' || c === 'permanentresident',
    nonperm: c === 'nonpermanentresidentalien' || c === 'nonpermanentresident',
  };
}

// ─── Handle boolean checkbox placeholders ──────────────────────────────
function handleCheckboxes(data) {
  var cit = normalizeCitizenship(data.citizenship);
  var ms = String(data.marital_status || '').toLowerCase();
  var occ = String(data.occupancy_type || '');
  var lp = String(data.loan_purpose || '').toLowerCase();
  var lt = String(data.loan_type || '');

  return {
    citizenship_us: chk(cit.us),
    citizenship_perm: chk(cit.perm),
    citizenship_nonperm: chk(cit.nonperm),

    marital_married: chk(ms === 'married'),
    marital_separated: chk(ms === 'separated'),
    marital_unmarried: chk(['unmarried', 'single', 'divorced'].indexOf(ms) >= 0),

    occupancy_primary: chk(occ === 'Primary Residence'),
    occupancy_second: chk(occ === 'Second Home'),
    occupancy_investment: chk(occ === 'Investment'),

    loan_purpose_purchase: chk(lp === 'purchase'),
    loan_purpose_refinance: chk(lp === 'refinance'),
    loan_purpose_other: chk(lp === 'other'),

    loan_type_conventional: chk(lt === 'Conventional'),
    loan_type_fha: chk(lt === 'FHA'),
    loan_type_va: chk(lt === 'VA'),
    loan_type_usda: chk(lt === 'USDA-RD'),

    military_yes: chk(!!data.military_service),
    military_no: chk(!data.military_service),

    // Declarations A–M — YES/NO pairs
    decl_a_yes: chk(!!data.declaration_primary_residence),
    decl_a_no: chk(!data.declaration_primary_residence),
    decl_b_yes: chk(!!data.declaration_family_seller),
    decl_b_no: chk(!data.declaration_family_seller),
    decl_c_yes: chk(!!data.declaration_borrowed_funds),
    decl_c_no: chk(!data.declaration_borrowed_funds),
    decl_d1_yes: chk(!!data.declaration_other_mortgage),
    decl_d1_no: chk(!data.declaration_other_mortgage),
    decl_d2_yes: chk(!!data.declaration_new_credit),
    decl_d2_no: chk(!data.declaration_new_credit),
    decl_e_yes: chk(!!data.declaration_pace_lien),
    decl_e_no: chk(!data.declaration_pace_lien),
    decl_f_yes: chk(!!data.declaration_cosigner),
    decl_f_no: chk(!data.declaration_cosigner),
    decl_g_yes: chk(!!data.declaration_judgments),
    decl_g_no: chk(!data.declaration_judgments),
    decl_h_yes: chk(!!data.declaration_delinquent),
    decl_h_no: chk(!data.declaration_delinquent),
    decl_i_yes: chk(!!data.declaration_lawsuit),
    decl_i_no: chk(!data.declaration_lawsuit),
    decl_j_yes: chk(!!data.declaration_deed_in_lieu),
    decl_j_no: chk(!data.declaration_deed_in_lieu),
    decl_k_yes: chk(!!data.declaration_short_sale),
    decl_k_no: chk(!data.declaration_short_sale),
    decl_l_yes: chk(!!data.declaration_foreclosure),
    decl_l_no: chk(!data.declaration_foreclosure),
    decl_m_yes: chk(!!data.declaration_bankruptcy),
    decl_m_no: chk(!data.declaration_bankruptcy),
  };
}

// ─── Fill form placeholders ────────────────────────────────────────────
function fillForm(data) {
  var fullName = [data.first_name, data.middle_name, data.last_name, data.suffix].filter(Boolean).join(' ');
  var coName = [data.co_borrower_first_name, data.co_borrower_middle_name, data.co_borrower_last_name, data.co_borrower_suffix].filter(Boolean).join(' ');

  var totalIncome = data.total_monthly_income || (
    (parseFloat(data.base_income) || 0) +
    (parseFloat(data.overtime_income) || 0) +
    (parseFloat(data.bonus_income) || 0) +
    (parseFloat(data.commission_income) || 0) +
    (parseFloat(data.military_income) || 0) +
    (parseFloat(data.other_income) || 0)
  );

  var tokens = Object.assign({
    borrower_name: fullName,
    borrower_name_footer: fullName,
    co_borrower_name: coName,
    ssn: formatSSN(data.ssn),
    dob: formatDate(data.date_of_birth),

    cell_phone: data.cell_phone || '',
    home_phone: data.home_phone || '',
    work_phone: data.work_phone || '',
    email: data.email || '',

    current_address_street: data.current_address_street || '',
    current_address_city: data.current_address_city || '',
    current_address_state: data.current_address_state || '',
    current_address_zip: data.current_address_zip || '',

    employer_name: data.employer_name || '',
    employer_phone: data.employer_phone || '',
    employer_address: [data.employer_street, data.employer_city, data.employer_state, data.employer_zip].filter(Boolean).join(', '),
    position_title: data.position_title || '',
    employment_start_date: formatDate(data.employment_start_date),
    years_in_field: (data.years_in_line_of_work || 0) + ' Yrs ' + (data.months_in_line_of_work || 0) + ' Mos',

    base_income: formatCurrency(data.base_income),
    overtime: formatCurrency(data.overtime_income),
    bonus: formatCurrency(data.bonus_income),
    commission: formatCurrency(data.commission_income),
    total_monthly_income: formatCurrency(totalIncome),

    loan_amount: formatCurrency(data.loan_amount || data.requested_loan_amount),
    property_address_street: data.property_address_street || '',
    property_address_city: data.property_address_city || '',
    property_address_state: data.property_address_state || '',
    property_address_zip: data.property_address_zip || '',
    property_county: data.property_address_county || '',
    interest_rate: data.current_interest_rate ? data.current_interest_rate + '%' : '',
    loan_term: data.loan_term_months ? data.loan_term_months + ' months' : '',

    lo_org_name: 'E Mortgage Capital, Inc. / Rates & Realty',
    lo_name: 'Rene Duarte',
    lo_nmls: '1795044',
    lo_email: 'rene@ratesandrealty.com',
    lo_phone: '(714) 472-8508',

    today_date: new Date().toLocaleDateString('en-US'),
  }, handleCheckboxes(data));

  // Replace {{token}} placeholders in the DOM body.
  var html = document.body.innerHTML;
  Object.keys(tokens).forEach(function (k) {
    var re = new RegExp('\\{\\{' + k + '\\}\\}', 'g');
    html = html.replace(re, tokens[k] == null ? '' : String(tokens[k]));
  });
  document.body.innerHTML = html;
}

// ─── Auto-print 600ms after load if data is present on window ──────────
window.addEventListener('load', function () {
  if (window.URLA_DATA) {
    try { fillForm(window.URLA_DATA); } catch (e) { console.error('[URLA] fillForm', e); }
  }
});
