import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { requireStaff } from "../_shared/require-staff.ts";

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// Returns the next index in `src` at or after `from` where the exact tag opens.
// An exact open is `<TAG>` or `<TAG ` (with space + attributes). NOT `<TAGS>`.
function findNextTagOpen(src: string, tag: string, from: number): number {
  const needle = '<' + tag;
  let pos = from;
  while (pos < src.length) {
    const i = src.indexOf(needle, pos);
    if (i < 0) return -1;
    const next = src.charAt(i + needle.length);
    if (next === '>' || next === ' ' || next === '\t' || next === '\n' || next === '\r' || next === '/') return i;
    pos = i + needle.length;
  }
  return -1;
}

function tv(src: string, tag: string): string | null {
  const patterns = ['<' + tag + '>', '<' + tag + ' '];
  let start = -1;
  for (const p of patterns) {
    const i = src.indexOf(p);
    if (i >= 0 && (start < 0 || i < start)) start = i;
  }
  if (start < 0) return null;
  const valStart = src.indexOf('>', start) + 1;
  const valEnd = src.indexOf('</' + tag + '>', valStart);
  if (valEnd < 0) return null;
  const val = src.substring(valStart, valEnd).trim();
  return val || null;
}

// Extract the Nth block of <TAG>...</TAG> (or <TAG attr=...>...</TAG>).
// Correctly handles nesting by ONLY counting same-name tags (not prefix-matches
// like EMPLOYERS when looking for EMPLOYER).
function tb(src: string, tag: string, nth = 0): string | null {
  const close = '</' + tag + '>';
  let found = 0;
  let pos = 0;
  while (pos < src.length) {
    const tagStart = findNextTagOpen(src, tag, pos);
    if (tagStart < 0) return null;
    if (found < nth) {
      // Skip past this opening tag and continue searching for the nth occurrence at depth 0
      const skipFrom = src.indexOf('>', tagStart) + 1;
      // Walk to find matching close so we don't accidentally start inside its body
      let depth = 1, scan = skipFrom;
      while (depth > 0 && scan < src.length) {
        const nOpen  = findNextTagOpen(src, tag, scan);
        const nClose = src.indexOf(close, scan);
        if (nClose < 0) return null;
        if (nOpen >= 0 && nOpen < nClose) { depth++; scan = src.indexOf('>', nOpen) + 1; }
        else { depth--; scan = nClose + close.length; }
      }
      pos = scan;
      found++;
      continue;
    }
    const contentStart = src.indexOf('>', tagStart) + 1;
    let depth = 1, scanPos = contentStart;
    while (depth > 0 && scanPos < src.length) {
      const nextOpen  = findNextTagOpen(src, tag, scanPos);
      const nextClose = src.indexOf(close, scanPos);
      if (nextClose < 0) return null;
      if (nextOpen >= 0 && nextOpen < nextClose) { depth++; scanPos = src.indexOf('>', nextOpen) + 1; }
      else {
        depth--;
        if (depth === 0) return src.substring(tagStart, nextClose + close.length);
        scanPos = nextClose + close.length;
      }
    }
    return null;
  }
  return null;
}

function tbAll(src: string, tag: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < 300; i++) {
    const b = tb(src, tag, i);
    if (!b) break;
    result.push(b);
  }
  return result;
}

// Extract the xlink:label attribute value from a block's opening tag.
function xlabel(blockXml: string): string | null {
  const m = blockXml.match(/xlink:label="([^"]+)"/);
  return m ? m[1] : null;
}

function num(v: string | null): number | null {
  if (!v) return null;
  const n = parseFloat(v.replace(/[,$%]/g, ''));
  return isNaN(n) ? null : n;
}

function bv(v: string | null): boolean | null {
  if (!v) return null;
  return ['true','y','1','yes'].includes(v.toLowerCase());
}

function extractName(xml: string): {first:string|null,middle:string|null,last:string|null} {
  for (const tag of ['n', 'NAME', 'INDIVIDUAL']) {
    const block = tb(xml, tag);
    if (block) {
      const first = tv(block, 'FirstName');
      const last  = tv(block, 'LastName');
      if (first || last) return { first, middle: tv(block,'MiddleName'), last };
      const full = tv(block, 'FullName');
      if (full) return splitFull(full);
    }
  }
  const first = tv(xml, 'FirstName');
  const last  = tv(xml, 'LastName');
  if (first || last) return { first, middle: tv(xml,'MiddleName'), last };
  const full = tv(xml, 'FullName');
  if (full) return splitFull(full);
  return { first:null, middle:null, last:null };
}

function splitFull(full: string): {first:string|null,middle:string|null,last:string|null} {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first:parts[0], middle:null, last:null };
  if (parts.length === 2) return { first:parts[0], middle:null, last:parts[1] };
  return { first:parts[0], middle:parts.slice(1,-1).join(' '), last:parts[parts.length-1] };
}

function extractHolderName(holderXml: string): string | null {
  for (const tag of ['n','NAME','LEGAL_ENTITY_DETAIL']) {
    const block = tb(holderXml, tag);
    if (block) {
      const full = tv(block,'FullName');
      if (full) return full;
    }
  }
  return tv(holderXml,'FullName') || null;
}

function extractEmployerName(empXml: string): string | null {
  const le = tb(empXml, 'LEGAL_ENTITY') || empXml;
  const led = tb(le, 'LEGAL_ENTITY_DETAIL') || le;
  const name = tv(led, 'FullName') || tv(empXml, 'FullName');
  return name && name.trim() ? name.trim() : null;
}

function parseParty(partyXml: string) {
  const { first, middle, last } = extractName(partyXml);

  const cpBlocks = tbAll(partyXml, 'CONTACT_POINT');
  let cell:string|null=null, home:string|null=null, work:string|null=null, email:string|null=null;
  for (const cp of cpBlocks) {
    const role  = tv(cp, 'ContactPointRoleType');
    const phone = tv(cp, 'ContactPointTelephoneValue');
    const em    = tv(cp, 'ContactPointEmailValue');
    if (em) email = em;
    if (phone) {
      if (!role || /mobile|cell/i.test(role)) { if (!cell) cell = phone; }
      else if (/home/i.test(role)) home = phone;
      else if (/work|business/i.test(role)) work = phone;
      else if (!cell) cell = phone;
    }
  }

  const ssn      = tv(partyXml, 'TaxpayerIdentifierValue');
  const roleType = tv(partyXml, 'PartyRoleType');
  const borrowerBlock = tb(partyXml, 'BORROWER') || '';
  const borrDetail    = tb(borrowerBlock, 'BORROWER_DETAIL') || borrowerBlock;
  const dob      = tv(borrDetail, 'BorrowerBirthDate');
  const marital  = tv(borrDetail, 'MaritalStatusType');
  const deps     = tv(borrDetail, 'DependentCount');
  const citizen  = tv(borrDetail, 'CitizenshipResidencyType');
  const declBlock   = tb(borrowerBlock, 'DECLARATION_DETAIL') || '';
  const intentOccup = tv(declBlock, 'IntentToOccupyType');

  let currStreet:string|null=null, currCity:string|null=null, currState:string|null=null, currZip:string|null=null;
  let currHousing:string|null=null, currMonths:number|null=null;
  let prevStreet:string|null=null, prevCity:string|null=null, prevState:string|null=null, prevZip:string|null=null, prevMonths:number|null=null;
  for (const res of tbAll(borrowerBlock, 'RESIDENCE')) {
    const rt  = tv(res, 'BorrowerResidencyType');
    const det = tb(res, 'RESIDENCE_DETAIL') || res;
    const addr= tb(res, 'ADDRESS') || res;
    const mo  = num(tv(det, 'BorrowerResidencyDurationMonthsCount'));
    if (!rt || /current/i.test(rt)) {
      currStreet = tv(addr,'AddressLineText'); currCity = tv(addr,'CityName');
      currState  = tv(addr,'StateCode');       currZip  = tv(addr,'PostalCode');
      currHousing= tv(det,'BorrowerResidencyBasisType'); currMonths = mo ? Math.round(mo) : null;
    } else if (/prior/i.test(rt)) {
      prevStreet = tv(addr,'AddressLineText'); prevCity = tv(addr,'CityName');
      prevState  = tv(addr,'StateCode');       prevZip  = tv(addr,'PostalCode');
      prevMonths = mo ? Math.round(mo) : null;
    }
  }

  let empName:string|null=null, empPhone:string|null=null;
  let empStreet:string|null=null, empCity:string|null=null, empState:string|null=null, empZip:string|null=null;
  let position:string|null=null, startDate:string|null=null;
  let selfEmp:boolean|null=null, baseIncome:number|null=null, lineMonths:number|null=null;
  let prevEmpName:string|null=null, prevStart:string|null=null, prevEnd:string|null=null;
  let prevPosition:string|null=null, prevMonthlyIncome:number|null=null;

  const empBlocks = tbAll(borrowerBlock, 'EMPLOYER');
  for (const emp of empBlocks) {
    const empDetail = tb(emp,'EMPLOYMENT') || emp;
    const status    = (tv(empDetail,'EmploymentStatusType')||'current').toLowerCase();
    const classif   = (tv(empDetail,'EmploymentClassificationType')||'primary').toLowerCase();
    const name      = extractEmployerName(emp);
    const addr      = tb(emp,'ADDRESS') || '';
    const phone     = tv(emp,'ContactPointTelephoneValue');
    const monthly   = num(tv(empDetail,'EmploymentMonthlyIncomeAmount'));
    const se        = bv(tv(empDetail,'EmploymentBorrowerSelfEmployedIndicator'));
    const eStart    = tv(empDetail,'EmploymentStartDate');
    const eEnd      = tv(empDetail,'EmploymentEndDate');
    const pos       = tv(empDetail,'EmploymentPositionDescription');
    const lm        = num(tv(empDetail,'EmploymentTimeInLineOfWorkMonthsCount'));
    const isCurr    = /current/.test(status);
    const isPrimary = /primary/.test(classif);

    if (isCurr && isPrimary && !empName) {
      empName  = name; empPhone = phone;
      empStreet= tv(addr,'AddressLineText'); empCity = tv(addr,'CityName');
      empState = tv(addr,'StateCode');       empZip  = tv(addr,'PostalCode');
      position = pos; startDate = eStart; selfEmp = se;
      baseIncome = monthly; lineMonths = lm ? Math.round(lm) : null;
    } else if (/previous/.test(status) && !prevEmpName) {
      prevEmpName = name; prevStart = eStart; prevEnd = eEnd;
      prevPosition= pos; prevMonthlyIncome = monthly;
    }
  }

  if (!empName) {
    for (const emp of empBlocks) {
      const empDetail = tb(emp,'EMPLOYMENT') || emp;
      const status = (tv(empDetail,'EmploymentStatusType')||'current').toLowerCase();
      if (!/current/.test(status)) continue;
      const name = extractEmployerName(emp);
      if (name) {
        empName = name;
        const pos = tv(empDetail,'EmploymentPositionDescription');
        if (pos) position = pos;
        const monthly = num(tv(empDetail,'EmploymentMonthlyIncomeAmount'));
        if (monthly && !baseIncome) baseIncome = monthly;
        break;
      }
    }
  }

  const incomeRows: any[] = [];
  for (const item of tbAll(borrowerBlock,'CURRENT_INCOME_ITEM')) {
    const amt  = num(tv(item,'CurrentIncomeMonthlyTotalAmount'));
    const type = tv(item,'IncomeType') || 'Other';
    if (amt && amt > 0) incomeRows.push({ income_type:type, monthly_amount:amt, annual_amount:amt*12, is_active:true, source:'mismo' });
  }
  if (!incomeRows.length && baseIncome && baseIncome > 0)
    incomeRows.push({ income_type:'Base', monthly_amount:baseIncome, annual_amount:baseIncome*12, is_active:true, source:'mismo' });
  const totalIncome = incomeRows.reduce((s:number,r:any)=>s+r.monthly_amount, 0);
  const ssnLast4 = ssn && ssn.length >= 4 ? ssn.slice(-4) : null;

  return {
    first_name:first, middle_name:middle, last_name:last,
    email, cell_phone:cell, home_phone:home, work_phone:work,
    borrower_email:email, ssn, ssn_last4:ssnLast4,
    date_of_birth:dob||null, marital_status:marital, citizenship:citizen,
    dependents_count: deps ? parseInt(deps) : null,
    current_address_street:currStreet, current_address_city:currCity,
    current_address_state:currState,   current_address_zip:currZip,
    current_housing_type:currHousing,  current_address_months:currMonths,
    former_address_street:prevStreet,  former_address_city:prevCity,
    former_address_state:prevState,    former_address_zip:prevZip, former_address_months:prevMonths,
    employer_name:empName, employer_phone:empPhone,
    employer_street:empStreet, employer_city:empCity, employer_state:empState, employer_zip:empZip,
    position_title:position, employment_start_date:startDate||null,
    is_self_employed:selfEmp, base_income:baseIncome,
    total_monthly_income: totalIncome > 0 ? totalIncome : (baseIncome||null),
    months_in_line_of_work:lineMonths,
    prev_employer_name:prevEmpName,
    prev_employment_start_date:prevStart||null, prev_employment_end_date:prevEnd||null,
    prev_position_title:prevPosition, prev_monthly_income:prevMonthlyIncome,
    decl_primary_residence: intentOccup ? intentOccup.toLowerCase()==='yes' : null,
    decl_bankruptcy:         bv(tv(declBlock,'BankruptcyIndicator')),
    decl_foreclosure:        bv(tv(declBlock,'PriorPropertyForeclosureCompletedIndicator')),
    decl_outstanding_judgments: bv(tv(declBlock,'OutstandingJudgmentsIndicator')),
    decl_delinquent_federal: bv(tv(declBlock,'PresentlyDelinquentIndicator')),
    decl_lawsuit:            bv(tv(declBlock,'PartyToLawsuitIndicator')),
    decl_deed_in_lieu:       bv(tv(declBlock,'PriorPropertyDeedInLieuConveyedIndicator')),
    decl_short_sale:         bv(tv(declBlock,'PriorPropertyShortSaleCompletedIndicator')),
    decl_borrowed_funds:     bv(tv(declBlock,'UndisclosedBorrowedFundsIndicator')),
    decl_applying_other_mortgage: bv(tv(declBlock,'UndisclosedMortgageApplicationIndicator')),
    decl_new_credit:         bv(tv(declBlock,'UndisclosedCreditApplicationIndicator')),
    decl_cosigner:           bv(tv(declBlock,'UndisclosedComakerOfNoteIndicator')),
    roleType, incomeRows
  };
}

// E2: build the employment payload for a loan_borrowers row from a parsed borrower.
// Only includes non-null values so we never clobber existing data with nulls.
function borrowerEmploymentPayload(b: any): Record<string,any> {
  const out: Record<string,any> = {};
  if (b.employer_name)            out.employer_name            = b.employer_name;
  if (b.employer_phone)           out.employer_phone           = b.employer_phone;
  if (b.employer_street)          out.employer_street          = b.employer_street;
  if (b.employer_city)            out.employer_city            = b.employer_city;
  if (b.employer_state)           out.employer_state           = b.employer_state;
  if (b.employer_zip)             out.employer_zip             = b.employer_zip;
  if (b.position_title)           out.position_title           = b.position_title;
  if (b.employment_start_date)    out.employment_start_date    = b.employment_start_date;
  if (b.is_self_employed !== null && b.is_self_employed !== undefined) out.is_self_employed = b.is_self_employed;
  if (b.base_income !== null && b.base_income !== undefined)           out.base_income      = b.base_income;
  if (b.months_in_line_of_work !== null && b.months_in_line_of_work !== undefined) out.months_in_line_of_work = b.months_in_line_of_work;
  if (b.prev_employer_name)         out.prev_employer_name         = b.prev_employer_name;
  if (b.prev_position_title)        out.prev_position_title        = b.prev_position_title;
  if (b.prev_employment_start_date) out.prev_employment_start_date = b.prev_employment_start_date;
  if (b.prev_employment_end_date)   out.prev_employment_end_date   = b.prev_employment_end_date;
  if (b.prev_monthly_income !== null && b.prev_monthly_income !== undefined) out.prev_monthly_income = b.prev_monthly_income;
  return out;
}

// v42: parse MISMO <RELATIONSHIP> xlink arcs that associate a LIABILITY (or ASSET)
// with a borrower ROLE. Returns a map of subject-label -> BORROWER ordinal index
// (0-based). e.g. { LIABILITY_2: 1 } means LIABILITY_2 belongs to borrowers[1].
// BORROWER_n labels are in PARTY document order, matching the borrowers[] array,
// so BORROWER_1 -> index 0, BORROWER_2 -> index 1, etc.
function parseRoleArcs(xml: string, subjectPrefix: string): Record<string, number> {
  const map: Record<string, number> = {};
  const re = /<RELATIONSHIP\b[^>]*\bxlink:arcrole="([^"]*)"[^>]*\bxlink:from="([^"]*)"[^>]*\bxlink:to="([^"]*)"[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const arcrole = m[1] || '';
    const from = m[2] || '';
    const to = m[3] || '';
    if (!/IsAssociatedWith_ROLE/i.test(arcrole)) continue;
    if (!from.startsWith(subjectPrefix)) continue;
    const bm = to.match(/BORROWER_(\d+)/i);
    if (!bm) continue;
    const ordinal = parseInt(bm[1], 10);
    if (!isNaN(ordinal) && ordinal >= 1) map[from] = ordinal - 1;
  }
  return map;
}

function parseMismo(xml: string) {
  const partiesBlock = tb(xml, 'PARTIES') || xml;
  const partyBlocks: string[] = tbAll(partiesBlock, 'PARTY');

  const borrowers: ReturnType<typeof parseParty>[] = [];
  let loName:string|null=null, loNmls:string|null=null, loPhone:string|null=null, loEmail:string|null=null;
  let loOrgName:string|null=null, loOrgNmls:string|null=null;

  for (const party of partyBlocks) {
    const roleType = tv(party, 'PartyRoleType');
    if (roleType === 'PropertyOwner') continue;
    if (roleType === 'LoanOriginator') {
      const { first, last } = extractName(party);
      loName  = [first,last].filter(Boolean).join(' ') || null;
      loPhone = tv(party,'ContactPointTelephoneValue');
      loEmail = tv(party,'ContactPointEmailValue');
      for (const lic of tbAll(party,'LICENSE_DETAIL')) {
        if (tv(lic,'LicenseAuthorityLevelType')==='Private') loNmls = tv(lic,'LicenseIdentifier');
      }
    } else if (roleType === 'LoanOriginationCompany') {
      const led = tb(party,'LEGAL_ENTITY_DETAIL') || party;
      loOrgName = tv(led,'FullName') || tv(party,'FullName');
      for (const lic of tbAll(party,'LICENSE_DETAIL')) {
        if (tv(lic,'LicenseAuthorityLevelType')==='Private') loOrgNmls = tv(lic,'LicenseIdentifier');
      }
    } else if (roleType==='Borrower'||roleType==='CoBorrower'||
               party.includes('BORROWER_DETAIL')||party.includes('DECLARATION_DETAIL')) {
      const parsed = parseParty(party);
      if (parsed.first_name||parsed.last_name||parsed.email) borrowers.push(parsed);
    }
  }

  const subjProp  = tb(xml,'SUBJECT_PROPERTY') || '';
  const propAddr  = tb(subjProp,'ADDRESS') || '';
  const propDet   = tb(subjProp,'PROPERTY_DETAIL') || '';
  const propStr   = tv(propAddr,'AddressLineText');
  const propCity  = tv(propAddr,'CityName');
  const propSt    = tv(propAddr,'StateCode');
  const propZip   = tv(propAddr,'PostalCode');
  const propCnty  = tv(propAddr,'CountyName');
  const propVal   = num(tv(propDet,'PropertyEstimatedValueAmount'));
  const numUnits  = tv(propDet,'FinancedUnitCount');
  const occupancy = tv(propDet,'PropertyUsageType');
  const attachType= tv(propDet,'AttachmentType');
  const estateType= tv(propDet,'PropertyEstateType');
  const salesPrice= num(tv(tb(subjProp,'SALES_CONTRACT_DETAIL')||'','SalesContractAmount'));

  const termsBlock  = tb(xml,'TERMS_OF_LOAN') || '';
  const loanAmount  = num(tv(termsBlock,'BaseLoanAmount') || tv(termsBlock,'NoteAmount'));
  const rawPurpose  = tv(termsBlock,'LoanPurposeType');
  const loanPurpose = rawPurpose ? rawPurpose.toLowerCase().replace('purchase','purchase').replace('refinance','refinance') : null;
  const loanType    = tv(termsBlock,'MortgageType');
  const noteRate    = num(tv(termsBlock,'NoteRatePercent'));
  const losLoanId   = tv(xml,'LoanOriginationSystemLoanIdentifier') || tv(xml,'LoanIdentifier');

  const amorBlock  = tb(xml,'AMORTIZATION_RULE') || '';
  const amorType   = tv(amorBlock,'AmortizationType');
  const termMonths = num(tv(amorBlock,'LoanAmortizationPeriodCount'));

  const closingBlock = tb(xml,'CLOSING_INFORMATION_DETAIL') || '';
  const cashToBorr   = num(tv(closingBlock,'CashToBorrowerAtClosingAmount'));
  const cashFromBorr = num(tv(closingBlock,'CashFromBorrowerAtClosingAmount'));
  const urlaBlock    = tb(xml,'URLA_DETAIL') || '';
  const closingCost  = num(tv(urlaBlock,'EstimatedClosingCostsAmount'));
  const appDate      = tv(urlaBlock,'ApplicationSignedByLoanOriginatorDate') || tv(xml,'ApplicationReceivedDate');

  let piPayment:number|null=null, taxes:number|null=null, insurance:number|null=null;
  for (const h of tbAll(xml,'HOUSING_EXPENSE')) {
    const timing = tv(h,'HousingExpenseTimingType');
    if (timing && !/proposed/i.test(timing)) continue;
    const amt  = num(tv(h,'HousingExpensePaymentAmount'));
    const type = tv(h,'HousingExpenseType');
    if (!amt) continue;
    if (/MortgagePrincipalAndInterest/i.test(type||'')) piPayment = amt;
    else if (/RealEstateTax/i.test(type||'')) taxes = amt;
    else if (/Homeowners|Insurance/i.test(type||'')) insurance = amt;
  }

  // v42: build LIABILITY_n -> borrowerIndex map from RELATIONSHIP arcs.
  const liabArcs = parseRoleArcs(xml, 'LIABILITY_');

  const liabSection = tb(xml,'LIABILITIES') || '';
  const liabilities = tbAll(liabSection,'LIABILITY')
    .filter(l => !l.includes('LIABILITY_SUMMARY'))
    .map(l => {
      const label = xlabel(l);
      const bi = (label && liabArcs[label] !== undefined) ? liabArcs[label] : null;
      return {
        liability_type:  tv(tb(l,'LIABILITY_DETAIL')||l,'LiabilityType'),
        creditor_name:   extractHolderName(tb(l,'LIABILITY_HOLDER')||l),
        account_number:  tv(tb(l,'LIABILITY_DETAIL')||l,'LiabilityAccountIdentifier'),
        balance:         num(tv(tb(l,'LIABILITY_DETAIL')||l,'LiabilityUnpaidBalanceAmount')),
        monthly_payment: num(tv(tb(l,'LIABILITY_DETAIL')||l,'LiabilityMonthlyPaymentAmount')),
        remaining_term_months: parseInt(tv(tb(l,'LIABILITY_DETAIL')||l,'LiabilityRemainingTermMonthsCount')||'0')||null,
        is_omitted: bv(tv(tb(l,'LIABILITY_DETAIL')||l,'LiabilityExclusionIndicator'))||false,
        is_payoff:  bv(tv(tb(l,'LIABILITY_DETAIL')||l,'LiabilityPayoffStatusIndicator'))||false,
        borrower_index: bi,   // v42: which borrower owns this liability (0-based), or null
        source: 'mismo'
      };
    });

  const totalDebt = liabilities.reduce((s,l)=>s+(l.monthly_payment||0),0);
  const totalPITI = (piPayment||0)+(taxes||0)+(insurance||0);

  const shared = {
    loan_amount:loanAmount, requested_loan_amount:loanAmount,
    loan_purpose:loanPurpose, loan_type:loanType, current_interest_rate:noteRate,
    loan_term_months: termMonths ? Math.round(termMonths) : null,
    amortization_type:amorType,
    property_address: propStr ? [propStr,propCity,propSt,propZip].filter(Boolean).join(', ') : null,
    property_address_street:propStr, property_address_city:propCity,
    property_address_state:propSt,   property_address_zip:propZip, property_address_county:propCnty,
    property_city:propCity, property_state:propSt, property_zip:propZip,
    property_value:propVal, estimated_value:propVal, purchase_price:salesPrice,
    number_of_units: numUnits ? parseInt(numUnits) : null,
    occupancy_type: occupancy ? occupancy.replace('PrimaryResidence','primary').replace('SecondHome','second_home').replace('Investment','investment') : null,
    attachment_type:attachType, property_estate_type:estateType,
    pi_payment:piPayment, taxes_monthly:taxes, insurance_monthly:insurance,
    total_pitia: totalPITI > 0 ? totalPITI : null,
    cash_to_borrower: cashToBorr || (cashFromBorr ? -cashFromBorr : null),
    estimated_closing_costs:closingCost, application_date:appDate||null,
    lo_name:loName, lo_nmls:loNmls, lo_phone:loPhone, lo_email:loEmail,
    lo_org_name:loOrgName, lo_org_nmls:loOrgNmls,
    liabilities: liabilities.length ? JSON.stringify(liabilities) : null,
    monthly_debt: totalDebt > 0 ? totalDebt : null,
    mismo_version:'3.4', mismo_imported_at: new Date().toISOString(),
    status:'draft', borrower_id:losLoanId||null,
  };

  return { borrowers, shared, liabilities, loanId: losLoanId };
}

async function findOrCreate(b: any): Promise<{id:string; isNew:boolean}> {
  if (b.email) {
    const { data } = await sb.from('contacts').select('id').ilike('email', b.email).limit(1);
    if (data?.length) return { id:data[0].id, isNew:false };
  }
  if (b.first_name && b.last_name) {
    const { data } = await sb.from('contacts').select('id')
      .ilike('first_name', b.first_name).ilike('last_name', b.last_name).limit(1);
    if (data?.length) return { id:data[0].id, isNew:false };
  }
  if (b.cell_phone || b.home_phone) {
    const phone = (b.cell_phone||b.home_phone).replace(/\D/g,'');
    const { data } = await sb.from('contacts').select('id').eq('phone', phone).limit(1);
    if (data?.length) return { id:data[0].id, isNew:false };
  }
  const payload: Record<string,any> = {
    first_name: b.first_name||null, last_name: b.last_name||null,
    email: b.email?.toLowerCase()||null,
    phone: b.cell_phone||b.home_phone||null,
    address: b.current_address_street||null, city: b.current_address_city||null,
    state: b.current_address_state||null, zip: b.current_address_zip||null,
    pipeline_status: 'New Lead', source: 'MISMO Import',
    /* Explicit. contacts.sms_opt_in DEFAULTS TO TRUE, so an imported borrower was
     * arriving already marked as consenting to texts. A loan file is not consent
     * to be texted — record real consent only where it is actually obtained. */
    sms_opt_in: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
  if (b.ssn_last4)     payload.ssn_last4     = b.ssn_last4;
  if (b.date_of_birth) payload.date_of_birth = b.date_of_birth;
  const { data, error } = await sb.from('contacts').insert(payload).select('id').single();
  if (error||!data) throw new Error(`Contact create failed for ${b.first_name} ${b.last_name}: ${error?.message}`);
  return { id:data.id, isNew:true };
}

const NON_COLUMN_BORROWER_KEYS = new Set(['roleType','incomeRows','ssn_last4']);

async function upsertPrimaryApp(contactId:string, primary:any, shared:any, rawXml:string, fileName:string|null): Promise<string> {
  const { data:existing } = await sb.from('mortgage_applications')
    .select('id').eq('contact_id', contactId).order('created_at',{ascending:false}).limit(1);

  const alwaysFields = [
    'first_name','middle_name','last_name','email','cell_phone','home_phone','work_phone',
    'borrower_email','date_of_birth','marital_status','citizenship','dependents_count',
    'current_address_street','current_address_city','current_address_state','current_address_zip',
    'current_housing_type','current_address_months',
    'former_address_street','former_address_city','former_address_state','former_address_zip',
    'employer_name','employer_phone','employer_street','employer_city','employer_state','employer_zip',
    'position_title','employment_start_date','is_self_employed','base_income','total_monthly_income',
    'months_in_line_of_work','prev_employer_name','prev_employment_start_date',
    'prev_employment_end_date','prev_position_title','prev_monthly_income',
    'decl_primary_residence','decl_bankruptcy','decl_foreclosure','decl_outstanding_judgments',
    'decl_delinquent_federal','decl_lawsuit','decl_deed_in_lieu','decl_short_sale',
    'decl_borrowed_funds','decl_applying_other_mortgage','decl_new_credit','decl_cosigner',
    'loan_amount','requested_loan_amount','loan_purpose','loan_type','current_interest_rate',
    'loan_term_months','amortization_type','property_address','property_address_street',
    'property_address_city','property_address_state','property_address_zip','property_address_county',
    'property_value','estimated_value','purchase_price','number_of_units','occupancy_type',
    'attachment_type','property_estate_type','pi_payment','taxes_monthly','insurance_monthly',
    'total_pitia','cash_to_borrower','estimated_closing_costs','application_date',
    'lo_name','lo_nmls','lo_phone','lo_email','lo_org_name','lo_org_nmls',
    'liabilities','monthly_debt','mismo_version','mismo_imported_at','mismo_file_name',
    'mismo_raw_xml','borrower_id'
  ];

  const bFiltered = Object.fromEntries(
    Object.entries(primary).filter(([k,v]) => !NON_COLUMN_BORROWER_KEYS.has(k) && v!==undefined && v!==null && v!=='')
  );
  const sharedFiltered = Object.fromEntries(
    Object.entries(shared).filter(([,v]) => v!==undefined && v!==null && v!=='')
  );
  const allData: Record<string,any> = {
    contact_id: contactId,
    ...bFiltered,
    ...sharedFiltered,
    mismo_file_name: fileName,
    mismo_raw_xml: rawXml,
    updated_at: new Date().toISOString(),
  };

  if (existing?.length) {
    const appId = existing[0].id;
    const upd: Record<string,any> = { updated_at: new Date().toISOString() };
    for (const k of alwaysFields) {
      if (allData[k] !== undefined && allData[k] !== null && allData[k] !== '') upd[k] = allData[k];
    }
    const { data:curr } = await sb.from('mortgage_applications').select('*').eq('id',appId).single();
    for (const [k,v] of Object.entries(allData)) {
      if (!alwaysFields.includes(k) && !(curr as any)?.[k]) upd[k] = v;
    }
    const { error: updErr } = await sb.from('mortgage_applications').update(upd).eq('id',appId);
    if (updErr) throw new Error(`App update failed: ${updErr.message}`);
    return appId;
  } else {
    allData.created_at = new Date().toISOString();
    const { data, error } = await sb.from('mortgage_applications').insert(allData).select('id').single();
    if (error||!data) throw new Error(`App create failed: ${error?.message}`);
    return data.id;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  /* GUARD FIRST — before the body or query string is read, so an action
     added later is covered by default rather than by remembering.
     verify_jwt=true does NOT do this: the anon key is a project-signed JWT
     printed in every page's source. See docs/PINNED-NOT-GUARDED.md. */
  const _auth = await requireStaff(req);
  if (!_auth.ok) return new Response(JSON.stringify({ error: _auth.msg || 'not authorized' }),
    { status: _auth.status || 401, headers: { ...cors, 'Content-Type': 'application/json' } });
  const ok  = (d:any) => new Response(JSON.stringify(d),{headers:{...cors,'Content-Type':'application/json'}});
  const err = (m:string,s=400,step?:string) => new Response(JSON.stringify({error:m,step}),{status:s,headers:{...cors,'Content-Type':'application/json'}});

  let currentStep = 'init';
  try {
    currentStep = 'parse_body';
    const body = await req.json();
    const { action, xml, file_name } = body;

    if (action==='parse') {
      if (!xml) return err('xml required');
      const { borrowers, shared } = parseMismo(xml);
      // LOUD: warn on 3+ borrowers (only borrower 1 & 2 have primary / co_borrower_* slots).
      const warnings: string[] = [];
      if (borrowers.length > 2) warnings.push(`File contains ${borrowers.length} borrowers; only borrower 1 and 2 map to primary / co-borrower fields — borrower 3+ has a loan_borrowers row but NO co_borrower_* mirror.`);
      return ok({ success:true, borrower_count:borrowers.length,
        borrowers: borrowers.map(b=>({ name:`${b.first_name} ${b.last_name}`, email:b.email,
          employer:b.employer_name, position:b.position_title, income:b.total_monthly_income,
          address:`${b.current_address_street}, ${b.current_address_city} ${b.current_address_state}`,
          marital:b.marital_status, dob:b.date_of_birth })),
        shared, warnings });
    }

    if (!xml) return err('xml required');
    currentStep = 'parse_mismo';
    const { borrowers, shared, liabilities, loanId } = parseMismo(xml);
    if (!borrowers.length) return err('No borrower data found in XML');
    console.log(`[mismo] parsed ${borrowers.length} borrowers, ${liabilities.length} liabilities`);

    const primary = borrowers[0];
    const primaryFullName = [primary.first_name, primary.last_name].filter(Boolean).join(' ');
    const results: any[] = [];
    const incomeWarnings: string[] = [];

    /* REPLACE, never append. loan_income used to be a plain .insert() per row with
       no delete and no conflict target, so every re-import added a full set on top
       of the last one. Measured on EMC26071266: two imports left SIX active rows
       for three file items, the panel summed 29,023.61 against a true 14,798.67,
       and the stored back-end DTI read 23.10% where the truth is 45.31%. Doubling
       income HALVES DTI, so the error made the borrower look more qualified.

       Scoped to source='mismo' AND this application AND this contact:
         - source  — loan_income also holds hand-entered rows from the LOS editor
                     and w2_ocr rows from ocr-apply-1003. A blanket delete would
                     destroy income MISMO never carried.
         - contact — co-borrower rows live on the co-borrower's own contact_id.
         - application — the same person can hold income on another application.

       Same shape as ocr-apply-1003:233, which already deletes by contact+source
       before inserting. MISMO was the only writer into this table that did not.

       A FAILED DELETE MUST NOT BE FOLLOWED BY AN INSERT. That is how the original
       bug produced its damage — an error nobody read, and rows piling up behind
       it. On a delete failure we skip the insert and surface a warning in the
       response body rather than adding to a set we could not clear. */
    async function replaceMismoIncome(appId: string, contactId: string, ownerName: string, rows: any[]) {
      if (!rows || !rows.length) {
        // Nothing to insert. Do NOT delete: a file that parsed no income is far
        // more likely to be a parse failure than a borrower who genuinely earns
        // nothing, and wiping the previous set would turn that into data loss.
        incomeWarnings.push(`${ownerName}: no income items parsed — existing loan_income rows left untouched.`);
        return;
      }
      const { error: delErr } = await sb.from('loan_income').delete()
        .eq('application_id', appId).eq('contact_id', contactId).eq('source', 'mismo');
      if (delErr) {
        incomeWarnings.push(`${ownerName}: could not clear previous MISMO income (${delErr.message}) — NOT inserting, to avoid duplicating. Income for this borrower is unchanged.`);
        return;
      }
      for (const row of rows) {
        const { error: incErr } = await sb.from('loan_income').insert({
          ...row, application_id: appId, contact_id: contactId,
          income_owner: ownerName, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
        });
        if (incErr) incomeWarnings.push(`${ownerName}: income row failed (${incErr.message}).`);
      }
    }
    // v42: collect each borrower's contact_id + display name by ordinal index so
    // liabilities can be attributed to the correct borrower via borrower_index.
    const borrowerContactIds: (string|null)[] = new Array(borrowers.length).fill(null);
    const borrowerNames: string[] = new Array(borrowers.length).fill('');

    currentStep = `findOrCreate_primary_${primaryFullName}`;
    console.log(`[mismo] primary borrower: ${primaryFullName} | employer: ${primary.employer_name}`);
    const primaryContact = await findOrCreate(primary);
    const primaryCId = primaryContact.id;
    borrowerContactIds[0] = primaryCId;
    borrowerNames[0] = primaryFullName;

    currentStep = 'update_primary_contact';
    const cu: Record<string,any> = { updated_at: new Date().toISOString() };
    if (primary.first_name)              cu.first_name    = primary.first_name;
    if (primary.last_name)               cu.last_name     = primary.last_name;
    if (primary.email)                   cu.email         = primary.email.toLowerCase();
    if (primary.cell_phone||primary.home_phone) cu.phone   = primary.cell_phone||primary.home_phone;
    if (primary.current_address_street)  cu.address       = primary.current_address_street;
    if (primary.current_address_city)    cu.city          = primary.current_address_city;
    if (primary.current_address_state)   cu.state         = primary.current_address_state;
    if (primary.current_address_zip)     cu.zip           = primary.current_address_zip;
    if (primary.date_of_birth)           cu.date_of_birth = primary.date_of_birth;
    if (primary.ssn_last4)               cu.ssn_last4     = primary.ssn_last4;
    if (shared.loan_amount)              cu.loan_amount   = shared.loan_amount;
    await sb.from('contacts').update(cu).eq('id', primaryCId);

    currentStep = 'upsert_primary_app';
    const primaryAppId = await upsertPrimaryApp(primaryCId, primary, shared, xml, file_name||null);

    currentStep = 'insert_primary_income';
    await replaceMismoIncome(primaryAppId, primaryCId, primaryFullName, primary.incomeRows || []);

    currentStep = 'link_primary_borrower';
    const { error: lbPrimaryErr } = await sb.from('loan_borrowers').upsert({
      application_id:primaryAppId, contact_id:primaryCId,
      borrower_role:'Borrower', borrower_order:1, is_primary:true,
      ...borrowerEmploymentPayload(primary),
      updated_at:new Date().toISOString()
    },{onConflict:'application_id,contact_id'});
    if (lbPrimaryErr) console.log('[mismo] primary loan_borrowers:', lbPrimaryErr.message);

    results.push({ role:'Borrower', order:1, contact_id:primaryCId, application_id:primaryAppId,
      name:primaryFullName, employer:primary.employer_name, marital:primary.marital_status,
      is_new_contact:primaryContact.isNew });

    for (let i=1; i<borrowers.length; i++) {
      const cb = borrowers[i];
      const cbFullName = [cb.first_name, cb.last_name].filter(Boolean).join(' ');
      console.log(`[mismo] co-borrower ${i}: ${cbFullName} | employer: ${cb.employer_name}`);

      currentStep = `findOrCreate_coborrower_${i}_${cbFullName}`;
      const cbContact = await findOrCreate(cb);
      const cbCId = cbContact.id;
      borrowerContactIds[i] = cbCId;
      borrowerNames[i] = cbFullName;

      currentStep = `update_coborrower_contact_${i}`;
      const cbcu: Record<string,any> = { updated_at: new Date().toISOString() };
      if (cb.first_name)              cbcu.first_name    = cb.first_name;
      if (cb.last_name)               cbcu.last_name     = cb.last_name;
      if (cb.email)                   cbcu.email         = cb.email.toLowerCase();
      if (cb.cell_phone||cb.home_phone) cbcu.phone       = cb.cell_phone||cb.home_phone;
      if (cb.current_address_street)  cbcu.address       = cb.current_address_street;
      if (cb.current_address_city)    cbcu.city          = cb.current_address_city;
      if (cb.current_address_state)   cbcu.state         = cb.current_address_state;
      if (cb.current_address_zip)     cbcu.zip           = cb.current_address_zip;
      if (cb.date_of_birth)           cbcu.date_of_birth = cb.date_of_birth;
      if (cb.ssn_last4)               cbcu.ssn_last4     = cb.ssn_last4;
      if (shared.loan_amount)         cbcu.loan_amount   = shared.loan_amount;
      await sb.from('contacts').update(cbcu).eq('id', cbCId);

      currentStep = `insert_coborrower_income_${i}`;
      await replaceMismoIncome(primaryAppId, cbCId, cbFullName, cb.incomeRows || []);

      currentStep = `link_coborrower_${i}`;
      const { error: lbcbErr } = await sb.from('loan_borrowers').upsert({
        application_id:primaryAppId, contact_id:cbCId,
        borrower_role:'CoBorrower', borrower_order:i+1, is_primary:false,
        ...borrowerEmploymentPayload(cb),
        updated_at:new Date().toISOString()
      },{onConflict:'application_id,contact_id'});
      if (lbcbErr) console.log(`[mismo] coborr ${i} loan_borrowers:`, lbcbErr.message);

      if (i===1) {
        currentStep = 'update_primary_app_with_coborrower';
        const { error: cbUpdErr } = await sb.from('mortgage_applications').update({
          co_borrower_first_name: cb.first_name||null,
          co_borrower_middle_name: cb.middle_name||null,
          co_borrower_last_name: cb.last_name||null,
          co_borrower_email: cb.email||null,
          co_borrower_cell_phone: cb.cell_phone||null,
          co_borrower_home_phone: cb.home_phone||null,
          co_borrower_dob: cb.date_of_birth||null,
          co_borrower_marital_status: cb.marital_status||null,
          co_borrower_citizenship: cb.citizenship||null,
          co_borrower_ssn: cb.ssn||null,
          co_borrower_contact_id: cbCId,
          co_borrower_current_street: cb.current_address_street||null,
          co_borrower_current_city: cb.current_address_city||null,
          co_borrower_current_state: cb.current_address_state||null,
          co_borrower_current_zip: cb.current_address_zip||null,
          co_borrower_housing_type: cb.current_housing_type||null,
          co_borrower_employer: cb.employer_name||null,
          co_borrower_employer_phone: cb.employer_phone||null,
          co_borrower_title: cb.position_title||null,
          co_borrower_start_date: cb.employment_start_date||null,
          co_borrower_base_income: cb.base_income||null,
          co_borrower_decl_primary: cb.decl_primary_residence,
          co_borrower_decl_bankruptcy: cb.decl_bankruptcy,
          co_borrower_decl_foreclosure: cb.decl_foreclosure,
          co_borrower_decl_judgments: cb.decl_outstanding_judgments,
          co_borrower_decl_federal: cb.decl_delinquent_federal,
          updated_at: new Date().toISOString()
        }).eq('id', primaryAppId);
        if (cbUpdErr) console.log('[mismo] update primary app w/ coborrower:', cbUpdErr.message);
      }

      results.push({ role:'CoBorrower', order:i+1, contact_id:cbCId, application_id:primaryAppId,
        name:cbFullName, employer:cb.employer_name, marital:cb.marital_status,
        is_new_contact:cbContact.isNew });
    }

    currentStep = 'insert_liabilities';
    for (const liab of liabilities) {
      // v42: attribute each liability to the borrower the MISMO RELATIONSHIP arc
      // links it to. Fall back to the primary if the arc is missing/unresolved.
      const bi = (liab as any).borrower_index;
      const ownerCId = (bi !== null && bi !== undefined && borrowerContactIds[bi]) ? borrowerContactIds[bi]! : primaryCId;
      const ownerName = (bi !== null && bi !== undefined && borrowerNames[bi]) ? borrowerNames[bi] : primaryFullName;
      // Strip the helper field so it isn't sent to the DB insert.
      const { borrower_index, ...liabRow } = liab as any;
      if (liabRow.account_number) {
        const { data:dup } = await sb.from('loan_liabilities')
          .select('id').eq('contact_id',ownerCId).eq('account_number',liabRow.account_number).limit(1);
        if (dup?.length) continue;
      }
      const { error: lErr } = await sb.from('loan_liabilities').insert({
        ...liabRow, application_id:primaryAppId, contact_id:ownerCId, account_owner:ownerName,
        created_at:new Date().toISOString(), updated_at:new Date().toISOString()
      });
      if (lErr) console.log('[mismo] liability insert:', lErr.message);
    }

    currentStep = 'final_combined_totals';
    const { error: ctErr } = await sb.from('mortgage_applications').update({
      combined_monthly_debt:   liabilities.reduce((s,l)=>s+(l.monthly_payment||0),0),
      combined_borrower_count: borrowers.length,
      combined_monthly_income: borrowers.reduce((s,b)=>s+(b.total_monthly_income||0),0)
    }).eq('id',primaryAppId);
    if (ctErr) console.log('[mismo] combined totals:', ctErr.message);

    // LOUD warning: the schema has ONE co-borrower slot (co_borrower_*). Borrower 1 -> primary,
    // borrower 2 -> co_borrower_*. Borrower 3+ gets a loan_borrowers row + income but NO
    // co_borrower_* mirror, so those fields won't surface on the 1003 co-borrower panel.
    // Never let a borrower disappear silently.
    const warnings: string[] = [];
    if (borrowers.length > 2) {
      const extraNames = borrowerNames.slice(2).filter(Boolean).join(', ');
      warnings.push(`File contains ${borrowers.length} borrowers; only borrower 1 and 2 were mapped to primary / co-borrower fields — borrower 3+${extraNames ? ' ('+extraNames+')' : ''} has a loan_borrowers row but NO co_borrower_* mirror. Capture the extra borrower(s) manually.`);
    }
    /* Income problems ride in the RESPONSE, not only the console. The whole reason
       the duplication ran for a month is that the old code's only failure signal
       was console.log inside an edge function nobody reads. A caller that cannot
       see the warning cannot act on it. */
    warnings.push(...incomeWarnings);

    return ok({ success:true, borrower_count:borrowers.length, borrowers:results,
      primary_application_id:primaryAppId, primary_contact_id:primaryCId,
      liabilities_imported:liabilities.length, loan_id:loanId, warnings });

  } catch(e:any) {
    console.error('[mismo-import] step=',currentStep,'error=',e?.message||e);
    return err((e?.message||'Server error') + ' (step: ' + currentStep + ')', 500, currentStep);
  }
});
