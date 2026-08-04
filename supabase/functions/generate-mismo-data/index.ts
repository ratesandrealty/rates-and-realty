import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

// generate-mismo-data
// Data-driven DU ULAD MISMO 3.4 generator built from CRM data. SSN hard-block:
// full SSN lives in the admin-only application_ssn vault; this function runs as
// service_role and overlays the vaulted SSN onto the application before building XML.
//
// ── Fidelity gates (2026-07-14 rewrite) ────────────────────────────────
// 1. DECLARATIONS: sourced from real columns via coalesce(decl_X, declaration_X)
//    for the borrower, and the 5 real co_borrower_decl_* for the co-borrower.
//    NULL => the indicator is OMITTED. We never emit a hardcoded `false`
//    (a false attestation). Co-borrower indicators that have no column are
//    omitted (never stubbed false).
// 2. HMDA / GOVERNMENT_MONITORING: sourced from real ethnicity/race/sex.
//    Empty => OMITTED. A `RefusalIndicator=true` is emitted ONLY when the
//    borrower genuinely refused (explicit "do not wish to provide" sentinel).
//    We never fabricate a refusal over missing data. Co-borrower has no
//    demographic columns, so its demographic detail is omitted entirely.
// 3. INCOME: structured loan_income child rows are preferred. When those are
//    absent we FALL BACK to the flat employment/income columns (employments
//    jsonb + scalar *_income) so the export is never blocked — and we FLAG
//    every loan/borrower that used the fallback in the response `warnings` +
//    `income_source` so it is never silent. (Rough-but-real + disclosed is OK;
//    invented data is not.)
// 4. UPFRONT MI / FUNDING FEE: FHA UFMIP (1.75%) and USDA guarantee (1.00%) are
//    computed from the base loan amount (same statutory rates as the fee sheet's
//    computeGovUpfrontFee). VA funding fee is OMITTED (never $0) because first-
//    use/exemption are not captured. Conventional = 0 (true value).

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

const esc = (s: any) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const n2 = (v: any): string | null => { if (v == null || v === '') return null; const f = parseFloat(String(v).replace(/[,$%]/g,'')); if (isNaN(f)) return null; return (Math.round(f*100)/100).toString(); };
const numOrNull = (v: any): number | null => { if (v == null || v === '') return null; const f = parseFloat(String(v).replace(/[,$%]/g,'')); return isNaN(f) ? null : f; };
const digits = (v: any) => v ? String(v).replace(/\D/g,'') : '';

// coalesceBool: first strictly-boolean value wins; otherwise null (=> omit).
// Ignores null/undefined so a legacy declaration_* value backfills a missing decl_*.
const coalesceBool = (...vals: any[]): boolean | null => {
  for (const v of vals) { if (v === true || v === false) return v; }
  return null;
};
// Emit a MISMO boolean indicator only when the source is non-null.
const boolTag = (tag: string, v: boolean | null): string => (v === null ? '' : `<${tag}>${v ? 'true' : 'false'}</${tag}>`);

// A genuine "I do not wish to provide" refusal sentinel (future portal build).
// Until the portal collects this, no value matches => no refusal is ever emitted.
const isRefusal = (s: any): boolean => {
  if (s == null) return false;
  const v = String(s).toLowerCase();
  return /\bnot?\s*(wish|want)|do\s*not\s*wish|refus|decline|prefer\s*not/.test(v);
};

const mapCitizen = (c: any) => { if(!c) return 'USCitizen'; const v=String(c).toLowerCase(); if(v.includes('non')) return 'NonPermanentResidentAlien'; if(v.includes('permanent')||v.includes('resident')) return 'PermanentResidentAlien'; return 'USCitizen'; };
const mapMarital = (m: any) => { if(!m) return 'Unmarried'; const v=String(m).toLowerCase(); if(v.startsWith('marri')) return 'Married'; if(v.startsWith('sep')) return 'Separated'; return 'Unmarried'; };
const mapPurpose = (p: any) => { if(!p) return 'Purchase'; return String(p).toLowerCase().includes('refi') ? 'Refinance' : 'Purchase'; };
const mapMtgType = (t: any) => { if(!t) return 'Conventional'; const v=String(t).toLowerCase(); if(v==='fha') return 'FHA'; if(v==='va') return 'VA'; if(v.includes('usda')||v.includes('rural')) return 'USDA'; return 'Conventional'; };
const mapUsage = (o: any) => { if(!o) return 'PrimaryResidence'; const v=String(o).toLowerCase(); if(v.includes('second')) return 'SecondHome'; if(v.includes('invest')) return 'Investment'; return 'PrimaryResidence'; };
const mapHousing = (h: any) => { if(!h) return null; const v=String(h).toLowerCase(); if(v.includes('own')) return 'Own'; if(v.includes('rent')&&v.includes('free')) return 'LivingRentFree'; if(v.includes('free')) return 'LivingRentFree'; if(v.includes('rent')) return 'Rent'; return null; };
const mapLiabType = (t: any) => { if(!t) return 'Revolving'; const v=String(t).toLowerCase(); if(v.includes('mortgage')) return 'MortgageLoan'; if(v.includes('install')) return 'Installment'; if(v.includes('revolv')) return 'Revolving'; if(v.includes('lease')) return 'LeasePayment'; if(v.includes('heloc')) return 'HELOC'; if(v.includes('open')) return 'Open30DayChargeAccount'; if(v.includes('taxes')||v.includes('lien')) return 'TaxLien'; return 'Revolving'; };
const mapAssetType = (t: any) => { if(!t) return 'CheckingAccount'; const v=String(t).toLowerCase(); if(v.includes('check')) return 'CheckingAccount'; if(v.includes('saving')) return 'SavingsAccount'; if(v.includes('money')) return 'MoneyMarketFund'; if(v.includes('stock')||v.includes('bond')) return 'StocksAndBonds'; if(v.includes('mutual')) return 'MutualFund'; if(v.includes('retire')||v.includes('401')||v.includes('ira')) return 'RetirementFund'; if(v.includes('cd')||v.includes('certificate')) return 'CertificateOfDepositTimeDeposit'; if(v.includes('gift')) return 'GiftsTotal'; if(v.includes('trust')) return 'TrustAccount'; return 'CheckingAccount'; };

// ── Income type mapping ─────────────────────────────────────────
// Free-text income_type (e.g. "Base Salary", "Bonus", "Alimony") -> ULAD IncomeType
// enum, plus whether the item is employment income (drives EmploymentIncomeIndicator).
const EMPLOYMENT_INCOME = new Set(['Base','Overtime','Bonus','Commission','MilitaryEntitlements']);
const mapIncomeType = (t: any): string => {
  if (!t) return 'Base';
  const v = String(t).toLowerCase();
  if (v.includes('overtime')) return 'Overtime';
  if (v.includes('bonus')) return 'Bonus';
  if (v.includes('commiss')) return 'Commission';
  if (v.includes('base') || v.includes('salary') || v.includes('w2') || v.includes('wage')) return 'Base';
  if (v.includes('military') || v.includes('entitle') || v.includes('bah') || v.includes('bas')) return 'MilitaryEntitlements';
  if (v.includes('alimony') || v.includes('child support') || v.includes('separate maint')) return 'AlimonyChildSupport';
  if (v.includes('social security') || v.includes('ssi')) return 'SocialSecurity';
  if (v.includes('pension') || v.includes('retire')) return 'Retirement';
  if (v.includes('dividend') || v.includes('interest')) return 'DividendsInterest';
  if (v.includes('rental') || v.includes('net rent')) return 'NetRentalIncome';
  return 'Other';
};
const isEmploymentIncome = (uladType: string): boolean => EMPLOYMENT_INCOME.has(uladType);

// ── HMDA / demographic value mapping ────────────────────────────────
// Values arrive as jsonb arrays of strings (ethnicity/race) or a text scalar (sex).
// Empty/absent => nothing emitted for that category. Refusal sentinel => refusal.
const asArray = (v: any): string[] => {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x && (x.value || x.label || x.name)) || '')).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v];
  return [];
};
const mapEthnicityType = (s: string): string | null => {
  const v = s.toLowerCase();
  if (v.includes('not hispanic') || v.includes('non-hispanic') || v.includes('nothispanic')) return 'NotHispanicOrLatino';
  if (v.includes('hispanic') || v.includes('latino')) return 'HispanicOrLatino';
  return null;
};
const mapRaceType = (s: string): string | null => {
  const v = s.toLowerCase();
  if (v.includes('american indian') || v.includes('alaska')) return 'AmericanIndianOrAlaskaNative';
  if (v.includes('asian')) return 'Asian';
  if (v.includes('black') || v.includes('african')) return 'BlackOrAfricanAmerican';
  if (v.includes('hawaii') || v.includes('pacific')) return 'NativeHawaiianOrOtherPacificIslander';
  if (v.includes('white')) return 'White';
  return null;
};
const mapGenderType = (s: any): string | null => {
  if (!s) return null;
  const v = String(s).toLowerCase();
  if (v.startsWith('m')) return 'Male';
  if (v.startsWith('f')) return 'Female';
  return null;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const contact_id = body.contact_id;
    const debug = !!body.debug;
    if (!contact_id) return new Response(JSON.stringify({ error: 'contact_id required' }), { status: 400, headers: cors });

    const warnings: string[] = [];

    const { data: apps } = await sb.from('mortgage_applications').select('*').eq('contact_id', contact_id).order('created_at', { ascending: false }).limit(1);
    const app = apps?.[0];
    if (!app) return new Response(JSON.stringify({ error: 'no_application', message: 'No loan application found for this contact.' }), { status: 404, headers: cors });
    const appId = app.id;

    // SSN hard-block: full SSN lives in the admin-only application_ssn vault.
    try {
      const { data: _ssnRows } = await sb.from('application_ssn').select('ssn,co_borrower_ssn').eq('application_id', appId).limit(1);
      if (_ssnRows && _ssnRows[0]) {
        if (_ssnRows[0].ssn) app.ssn = _ssnRows[0].ssn;
        if (_ssnRows[0].co_borrower_ssn) app.co_borrower_ssn = _ssnRows[0].co_borrower_ssn;
      }
    } catch (_e) { /* fall back to (now-empty) table columns */ }

    // ---- Effective loan terms: prefer the primary loan_scenarios row, fall back to the application ----
    const { data: scens } = await sb.from('loan_scenarios').select('*').eq('contact_id', contact_id).order('is_primary', { ascending: false }).order('updated_at', { ascending: false }).limit(1);
    const scen: any = scens?.[0] || {};
    const sNum = (v: any) => { if (v == null || v === '') return null; const f = parseFloat(String(v)); return (isNaN(f) || f === 0) ? null : f; };
    const eff = {
      loanAmount: sNum(scen.loan_amount) ?? sNum(app.loan_amount),
      propVal: sNum(scen.appraised_value) ?? sNum(app.estimated_value) ?? sNum(app.property_value) ?? sNum(app.purchase_price),
      rate: sNum(scen.interest_rate) ?? sNum(app.current_interest_rate),
      term: scen.loan_term_months || app.loan_term_months || 360,
      pi: sNum(scen.pi_payment) ?? sNum(app.pi_payment),
      taxes: sNum(scen.property_taxes_monthly) ?? sNum(app.taxes_monthly),
      insurance: sNum(scen.insurance_monthly) ?? sNum(app.insurance_monthly),
      mi: sNum(app.mi_monthly),
    };

    const [{ data: lbs }, { data: income }, { data: liabs }, { data: assets }, { data: reo }] = await Promise.all([
      sb.from('loan_borrowers').select('*').eq('application_id', appId).order('borrower_order'),
      sb.from('loan_income').select('*').eq('application_id', appId).eq('is_active', true),
      sb.from('loan_liabilities').select('*').eq('application_id', appId).order('sort_order'),
      sb.from('loan_assets').select('*').eq('application_id', appId).order('sort_order'),
      sb.from('loan_reo').select('*').eq('application_id', appId).order('sort_order'),
    ]);

    let borrowerRows = lbs || [];
    if (!borrowerRows.length) {
      // Fall back to the primary contact as sole borrower if loan_borrowers is empty.
      borrowerRows = [{ contact_id, borrower_order: 1, is_primary: true, borrower_role: 'Borrower' }];
    }
    // Co-borrower fallback: if loan_borrowers has no 2nd row but the application carries a
    // co-borrower on the flat co_borrower_* columns, synthesize borrower 2 from those columns
    // (same principle as the flat income fallback) so the co-borrower party + its 5 stored
    // declarations are exported instead of silently dropped. FLAGGED in warnings.
    const hasSecond = borrowerRows.some((b: any) => (b.borrower_order || 0) === 2) || borrowerRows.length >= 2;
    if (!hasSecond && (app.co_borrower_first_name || app.co_borrower_last_name)) {
      borrowerRows.push({ contact_id: app.co_borrower_contact_id || null, borrower_order: 2, is_primary: false, borrower_role: 'CoBorrower', _flat_coborrower: true });
      warnings.push(`Co-borrower (${((app.co_borrower_first_name||'')+' '+(app.co_borrower_last_name||'')).trim()}) synthesized from flat co_borrower_* columns (no loan_borrowers row) — declarations limited to the 5 stored fields; demographics not available for co-borrower.`);
    }
    const cids = borrowerRows.map((b: any) => b.contact_id).filter(Boolean);
    const { data: contacts } = await sb.from('contacts').select('*').in('id', cids.length ? cids : ['00000000-0000-0000-0000-000000000000']);
    const cById: Record<string, any> = {};
    for (const c of (contacts || [])) cById[c.id] = c;

    const incomeByContact: Record<string, any[]> = {};
    for (const r of (income || [])) { (incomeByContact[r.contact_id] ||= []).push(r); }

    // Parse the flat `employments` jsonb array once (fallback income/employer source).
    let flatEmployments: any[] = [];
    try {
      if (Array.isArray(app.employments)) flatEmployments = app.employments;
      else if (typeof app.employments === 'string') flatEmployments = JSON.parse(app.employments) || [];
    } catch (_e) { flatEmployments = []; }

    // ---- Per-borrower declaration sources (real columns; null => omit) ----
    // Borrower 1 uses decl_* with declaration_* legacy backfill. Borrower 2 uses the
    // 5 real co_borrower_decl_* columns; the ~10 declarations with no B2 column are omitted.
    const declFor = (order: number) => {
      if (order === 1) {
        return {
          primaryResidence: coalesceBool(app.decl_primary_residence, app.declaration_primary_residence),
          ownershipInterest: coalesceBool(app.decl_ownership_interest),
          familySeller: coalesceBool(app.decl_family_relationship_seller, app.declaration_family_relationship),
          borrowedFunds: coalesceBool(app.decl_borrowed_funds, app.declaration_borrowed_funds),
          applyingOtherMortgage: coalesceBool(app.decl_applying_other_mortgage, app.declaration_other_mortgage),
          newCredit: coalesceBool(app.decl_new_credit, app.declaration_new_credit),
          lienPriority: coalesceBool(app.decl_lien_priority, app.declaration_lien_priority),
          cosigner: coalesceBool(app.decl_cosigner, app.declaration_cosigner),
          outstandingJudgments: coalesceBool(app.decl_outstanding_judgments, app.declaration_judgments),
          delinquentFederal: coalesceBool(app.decl_delinquent_federal, app.declaration_delinquent),
          lawsuit: coalesceBool(app.decl_lawsuit, app.declaration_lawsuit),
          deedInLieu: coalesceBool(app.decl_deed_in_lieu, app.declaration_deed_in_lieu),
          shortSale: coalesceBool(app.decl_short_sale, app.declaration_short_sale),
          foreclosure: coalesceBool(app.decl_foreclosure, app.declaration_foreclosure),
          bankruptcy: coalesceBool(app.decl_bankruptcy, app.declaration_bankruptcy),
        };
      }
      // Co-borrower: only these 5 columns exist. Everything else => null (omit).
      return {
        primaryResidence: coalesceBool(app.co_borrower_decl_primary),
        ownershipInterest: null, familySeller: null, borrowedFunds: null,
        applyingOtherMortgage: null, newCredit: null, lienPriority: null, cosigner: null,
        outstandingJudgments: coalesceBool(app.co_borrower_decl_judgments),
        delinquentFederal: coalesceBool(app.co_borrower_decl_federal),
        lawsuit: null, deedInLieu: null, shortSale: null,
        foreclosure: coalesceBool(app.co_borrower_decl_foreclosure),
        bankruptcy: coalesceBool(app.co_borrower_decl_bankruptcy),
      };
    };

    // ---- Per-borrower HMDA sources (real columns; empty => omit; only B1 has columns) ----
    const hmdaFor = (order: number) => {
      if (order !== 1) return { ethnicity: [], race: [], sex: null };
      return { ethnicity: asArray(app.ethnicity), race: asArray(app.race), sex: app.sex ?? null };
    };

    let empSeq = 0, incSeq = 0;
    const borrowers = borrowerRows.map((lb: any, i: number) => {
      const c = cById[lb.contact_id] || {};
      const order = lb.borrower_order || (i + 1);
      let ssnFull: string | null = null;
      if (order === 1) ssnFull = digits(app.ssn);
      else if (order === 2) ssnFull = digits(app.co_borrower_ssn);
      if (ssnFull && ssnFull.length !== 9) ssnFull = null;

      const structuredRows = incomeByContact[lb.contact_id] || [];
      const isSE = lb.is_self_employed === true || (order === 1 && app.is_self_employed === true);

      const b: any = {
        order,
        label: 'BORROWER_' + order,
        contact_id: lb.contact_id,
        first: lb.first_name || c.first_name || (order===1?app.first_name:order===2?app.co_borrower_first_name:null) || '',
        last: c.last_name || (order===1?app.last_name:order===2?app.co_borrower_last_name:null) || '',
        email: c.email || (order===1?app.email:order===2?app.co_borrower_email:null) || null,
        phone: digits(c.phone || (order===1?app.cell_phone:order===2?app.co_borrower_cell_phone:null)) || null,
        dob: c.date_of_birth || (order===1?app.date_of_birth:order===2?app.co_borrower_dob:null) || null,
        marital: (order===1?app.marital_status:order===2?app.co_borrower_marital_status:null),
        citizenship: (order===1?app.citizenship:order===2?app.co_borrower_citizenship:null),
        dependents: order===1 ? (app.dependents_count ?? 0) : 0,
        addr_street: c.address || (order===1?app.current_address_street:order===2?app.co_borrower_current_street:null) || null,
        addr_city: c.city || (order===1?app.current_address_city:order===2?app.co_borrower_current_city:null) || null,
        addr_state: c.state || (order===1?app.current_address_state:order===2?app.co_borrower_current_state:null) || null,
        addr_zip: c.zip || (order===1?app.current_address_zip:order===2?app.co_borrower_current_zip:null) || null,
        months: order===1 ? app.current_address_months : null,
        housing: order===1 ? (app.current_housing_type || app.current_housing) : (order===2 ? app.co_borrower_housing_type : null),
        emp_name: lb.employer_name || (order===1?app.employer_name:order===2?app.co_borrower_employer:null) || null,
        emp_street: lb.employer_street || (order===1?app.employer_street:null) || null,
        emp_city: lb.employer_city || (order===1?app.employer_city:null) || null,
        emp_state: lb.employer_state || (order===1?app.employer_state:null) || null,
        emp_zip: lb.employer_zip || (order===1?app.employer_zip:null) || null,
        emp_position: lb.position_title || (order===1?app.position_title:order===2?app.co_borrower_title:null) || null,
        emp_start: lb.employment_start_date || (order===1?app.employment_start_date:order===2?app.co_borrower_start_date:null) || null,
        is_self_employed: isSE,
        ssnFull,
        role: lb.is_primary || order===1 ? 'Borrower' : 'CoBorrower',
        decl: declFor(order),
        hmda: hmdaFor(order),
        incomeSource: 'structured',
      };

      // ── Income items: structured child rows first, then flat fallback ──
      let items: any[] = [];
      if (structuredRows.length) {
        items = structuredRows.map((r) => {
          const uladType = mapIncomeType(r.income_type);
          return { amount: n2(r.monthly_amount), uladType, employment: isEmploymentIncome(uladType) };
        });
        if (!b.emp_name && structuredRows[0]?.employer_name) b.emp_name = structuredRows[0].employer_name;
      } else {
        b.incomeSource = 'flat_fallback';
        if (order === 1 && flatEmployments.length) {
          // Backfill employer identity from the first flat employment if missing.
          const e0 = flatEmployments[0] || {};
          if (!b.emp_name && e0.employer) b.emp_name = e0.employer;
          if (!b.emp_street && e0.street) b.emp_street = e0.street;
          if (!b.emp_city && e0.city) b.emp_city = e0.city;
          if (!b.emp_position && e0.title) b.emp_position = e0.title;
          if (!b.emp_start && e0.start_date) b.emp_start = e0.start_date;
          if (e0.self_employed === true) b.is_self_employed = true;
          for (const e of flatEmployments) {
            const parts: Array<[any, string]> = [[e.base,'Base'],[e.overtime,'Overtime'],[e.bonus,'Bonus'],[e.commission,'Commission']];
            for (const [val, t] of parts) { const amt = numOrNull(val); if (amt && amt > 0) items.push({ amount: n2(amt), uladType: t, employment: true }); }
          }
        }
        if (!items.length) {
          // Scalar column fallback (typed income columns on the application).
          const scalarParts: Array<[any, string, boolean]> = order === 1
            ? [
                [app.base_income,'Base',true],[app.overtime_income,'Overtime',true],[app.bonus_income,'Bonus',true],
                [app.commission_income,'Commission',true],[app.military_income,'MilitaryEntitlements',true],
                [app.other_income,'Other',false],
              ]
            : [[app.co_borrower_base_income,'Base',true]];
          for (const [val, t, emp] of scalarParts) { const amt = numOrNull(val); if (amt && amt > 0) items.push({ amount: n2(amt), uladType: t, employment: emp }); }
          // Last resort: a single total_monthly_income lump (order 1 only).
          if (!items.length && order === 1) { const tmi = numOrNull(app.total_monthly_income); if (tmi && tmi > 0) items.push({ amount: n2(tmi), uladType: 'Base', employment: true }); }
        }
        warnings.push(`Borrower ${order} (${(b.first + ' ' + b.last).trim()}): income taken from flat fallback columns (structured loan_income empty) — simplified, not itemized.`);
      }

      if (b.emp_name) { empSeq++; b.empLabel = 'EMPLOYER_' + empSeq; } else b.empLabel = null;

      if (isSE) {
        b.seIncome = items.reduce((s, it) => s + (parseFloat(it.amount || '0') || 0), 0);
        b.incomeItems = [];
      } else {
        b.seIncome = 0;
        b.incomeItems = items.map((it) => { incSeq++; return { ...it, label: 'CURRENT_INCOME_ITEM_' + incSeq, emp: it.employment ? b.empLabel : null }; });
      }
      return b;
    });

    const incomeSources = Array.from(new Set(borrowers.map((b) => b.incomeSource)));
    const incomeSourceSummary = incomeSources.length > 1 ? 'mixed' : (incomeSources[0] || 'structured');

    const borrowerByContact: Record<string, any> = {};
    for (const b of borrowers) borrowerByContact[b.contact_id] = b;
    const nameToBorrower = (nm: string) => {
      if (!nm) return borrowers[0];
      const low = nm.toLowerCase().trim();
      return borrowers.find(b => `${b.first} ${b.last}`.toLowerCase().trim() === low) || borrowers.find(b => low.includes((b.last||'').toLowerCase()) && (b.last)) || borrowers[0];
    };

    // ---- Labels for assets / liabilities ----
    let assetSeq = 0;
    const cashAssets = (assets || []).map((a: any) => { assetSeq++; return { ...a, label: 'ASSET_' + assetSeq, owner: nameToBorrower(a.asset_owner) }; });
    const reoAssets = (reo || []).map((r: any) => { assetSeq++; return { ...r, label: 'ASSET_' + assetSeq, owner: borrowerByContact[r.contact_id] || borrowers[0] }; });
    const liabilities = (liabs || []).map((l: any, i: number) => ({ ...l, label: 'LIABILITY_' + (i + 1), owner: borrowerByContact[l.contact_id] || borrowers[0] }));

    // ---- Build XML ----
    const out: string[] = [];
    const p = (s: string) => out.push(s);
    p('<?xml version="1.0"?>');
    p('<MESSAGE xmlns:DU="http://www.datamodelextension.org/Schema/DU" xmlns:ULAD="http://www.datamodelextension.org/Schema/ULAD" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xlink="http://www.w3.org/1999/xlink" MISMOReferenceModelIdentifier="3.4.032420160128" xmlns="http://www.mismo.org/residential/2009/schemas">');
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    p('  <ABOUT_VERSIONS><ABOUT_VERSION><AboutVersionIdentifier>DU Spec 1.8.5</AboutVersionIdentifier><CreatedDatetime>'+now+'</CreatedDatetime></ABOUT_VERSION></ABOUT_VERSIONS>');
    p('  <DEAL_SETS><DEAL_SET><DEALS><DEAL>');

    // ASSETS
    p('    <ASSETS>');
    for (const a of cashAssets) {
      p('      <ASSET SequenceNumber="'+a.label.split('_')[1]+'" xlink:label="'+a.label+'">');
      p('        <ASSET_DETAIL><AssetCashOrMarketValueAmount>'+(n2(a.current_value)||'0')+'</AssetCashOrMarketValueAmount><AssetType>'+mapAssetType(a.asset_type)+'</AssetType></ASSET_DETAIL>');
      p('        <ASSET_HOLDER><NAME><FullName>'+esc(a.institution_name||a.asset_owner||'Account')+'</FullName></NAME></ASSET_HOLDER>');
      p('      </ASSET>');
    }
    for (const r of reoAssets) {
      p('      <ASSET SequenceNumber="'+r.label.split('_')[1]+'" xlink:label="'+r.label+'">');
      p('        <OWNED_PROPERTY><OWNED_PROPERTY_DETAIL>');
      p('          <OwnedPropertyDispositionStatusType>'+(String(r.disposition||'Retain').toLowerCase().includes('sell')?'Sell':String(r.disposition||'Retain').toLowerCase().includes('pend')?'PendingSale':'Retain')+'</OwnedPropertyDispositionStatusType>');
      p('          <OwnedPropertyLienUPBAmount>'+(n2(r.mortgage_balance)||'0')+'</OwnedPropertyLienUPBAmount>');
      p('          <OwnedPropertyMaintenanceExpenseAmount>'+(n2(r.hoa)||'0')+'</OwnedPropertyMaintenanceExpenseAmount>');
      p('          <OwnedPropertySubjectIndicator>false</OwnedPropertySubjectIndicator>');
      p('        </OWNED_PROPERTY_DETAIL><PROPERTY><ADDRESS><AddressLineText>'+esc(r.property_address||'')+'</AddressLineText></ADDRESS>');
      p('          <PROPERTY_DETAIL><PropertyEstimatedValueAmount>'+(n2(r.market_value)||'0')+'</PropertyEstimatedValueAmount></PROPERTY_DETAIL></PROPERTY>');
      p('        </OWNED_PROPERTY>');
      p('      </ASSET>');
    }
    p('    </ASSETS>');

    // COLLATERALS / SUBJECT_PROPERTY
    const purpose = mapPurpose(scen.loan_purpose||app.loan_purpose);
    const usage = mapUsage(app.occupancy_type || app.occupancy);
    const mtgType = mapMtgType(scen.loan_type || app.loan_type);
    const propVal = n2(eff.propVal) || n2(eff.loanAmount) || '0';
    // Real property attributes (coalesce live/legacy columns) instead of hardcoded values.
    const mixedUse = coalesceBool(app.mixed_use_property, app.is_mixed_use);
    const manufactured = coalesceBool(app.manufactured_home, app.is_manufactured_home);
    const unitCount = app.number_of_units || app.num_units || 1;
    p('    <COLLATERALS><COLLATERAL><SUBJECT_PROPERTY>');
    p('      <ADDRESS><AddressLineText>'+esc(app.property_address_street||app.property_address||'')+'</AddressLineText><CityName>'+esc(app.property_address_city||app.property_city||'')+'</CityName>'+(app.property_address_county?'<CountyName>'+esc(app.property_address_county)+'</CountyName>':'')+'<PostalCode>'+esc(app.property_address_zip||app.property_zip||'')+'</PostalCode><StateCode>'+esc(app.property_address_state||app.property_state||'')+'</StateCode></ADDRESS>');
    p('      <PROPERTY_DETAIL>');
    p('        <AttachmentType>'+esc(app.attachment_type||'Detached')+'</AttachmentType>');
    p('        <CommunityPropertyStateIndicator>false</CommunityPropertyStateIndicator>');
    p('        <ConstructionMethodType>'+(manufactured === true ? 'Manufactured' : 'SiteBuilt')+'</ConstructionMethodType>');
    p('        <FinancedUnitCount>'+unitCount+'</FinancedUnitCount>');
    p('        <PropertyEstateType>'+esc(app.property_estate_type||'FeeSimple')+'</PropertyEstateType>');
    p('        <PropertyExistingCleanEnergyLienIndicator>false</PropertyExistingCleanEnergyLienIndicator>');
    p('        <PropertyInProjectIndicator>false</PropertyInProjectIndicator>');
    p('        <PropertyMixedUsageIndicator>'+(mixedUse === true ? 'true' : 'false')+'</PropertyMixedUsageIndicator>');
    p('        <PropertyUsageType>'+usage+'</PropertyUsageType>');
    p('        <PUDIndicator>false</PUDIndicator>');
    p('      </PROPERTY_DETAIL>');
    p('      <PROPERTY_VALUATIONS><PROPERTY_VALUATION><PROPERTY_VALUATION_DETAIL><PropertyValuationAmount>'+propVal+'</PropertyValuationAmount></PROPERTY_VALUATION_DETAIL></PROPERTY_VALUATION></PROPERTY_VALUATIONS>');
    if (purpose === 'Purchase' && n2(app.purchase_price)) p('      <SALES_CONTRACT><SALES_CONTRACT_DETAIL><SalesContractAmount>'+n2(app.purchase_price)+'</SalesContractAmount></SALES_CONTRACT_DETAIL></SALES_CONTRACT>');
    p('    </SUBJECT_PROPERTY></COLLATERAL></COLLATERALS>');

    // LIABILITIES
    p('    <LIABILITIES>');
    for (const l of liabilities) {
      p('      <LIABILITY SequenceNumber="'+l.label.split('_')[1]+'" xlink:label="'+l.label+'">');
      p('        <LIABILITY_DETAIL>');
      if (l.account_number) p('          <LiabilityAccountIdentifier>'+esc(l.account_number)+'</LiabilityAccountIdentifier>');
      p('          <LiabilityExclusionIndicator>'+(l.is_omitted?'true':'false')+'</LiabilityExclusionIndicator>');
      p('          <LiabilityMonthlyPaymentAmount>'+(n2(l.monthly_payment)||'0')+'</LiabilityMonthlyPaymentAmount>');
      p('          <LiabilityPaymentIncludesTaxesInsuranceIndicator>false</LiabilityPaymentIncludesTaxesInsuranceIndicator>');
      p('          <LiabilityPayoffStatusIndicator>'+(l.is_payoff?'true':'false')+'</LiabilityPayoffStatusIndicator>');
      p('          <LiabilityRemainingTermMonthsCount>'+(l.remaining_term_months||0)+'</LiabilityRemainingTermMonthsCount>');
      p('          <LiabilityType>'+mapLiabType(l.liability_type)+'</LiabilityType>');
      if (n2(l.balance)) p('          <LiabilityUnpaidBalanceAmount>'+n2(l.balance)+'</LiabilityUnpaidBalanceAmount>');
      p('        </LIABILITY_DETAIL>');
      p('        <LIABILITY_HOLDER><NAME><FullName>'+esc(l.creditor_name||'Creditor')+'</FullName></NAME></LIABILITY_HOLDER>');
      p('      </LIABILITY>');
    }
    p('    </LIABILITIES>');

    // LOANS
    const borrowerCount = borrowers.length;
    const piAmt = n2(eff.pi), insAmt = n2(eff.insurance), taxAmt = n2(eff.taxes), miAmt = n2(eff.mi);
    // Upfront government MI / funding fee — mirrors computeGovUpfrontFee() in tools/fee-sheet.html.
    //   FHA  UFMIP     = base loan x 1.75%  (financed)
    //   USDA guarantee = base loan x 1.00%  (financed)
    //   VA   funding fee => OMIT both elements: first-use vs subsequent-use and exemption status
    //        are not captured anywhere, so we NEVER emit a false $0 on a VA loan.
    //   Conventional   = 0 (true value — there is no upfront MI).
    const baseLoanNum = numOrNull(eff.loanAmount) || 0;
    let miffTag = '<MIAndFundingFeeFinancedAmount>0</MIAndFundingFeeFinancedAmount><MIAndFundingFeeTotalAmount>0</MIAndFundingFeeTotalAmount>';
    if (mtgType === 'FHA' || mtgType === 'USDA') {
      const amt = +(baseLoanNum * (mtgType === 'FHA' ? 0.0175 : 0.01)).toFixed(2);
      miffTag = '<MIAndFundingFeeFinancedAmount>'+amt+'</MIAndFundingFeeFinancedAmount><MIAndFundingFeeTotalAmount>'+amt+'</MIAndFundingFeeTotalAmount>';
    } else if (mtgType === 'VA') {
      miffTag = ''; // omit — never a stand-in $0 on a government loan
      warnings.push('VA funding fee OMITTED (not emitted as $0): required inputs — first-use vs subsequent-use and funding-fee exemption status — are not captured anywhere in the CRM. DATA-COLLECTION GAP: add VA first-use + exemption to the portal/1003 to populate MIAndFundingFee.');
    }
    p('    <LOANS><LOAN SequenceNumber="1" LoanRoleType="SubjectLoan" xlink:label="LOAN_1">');
    p('      <AMORTIZATION><AMORTIZATION_RULE><AmortizationType>'+esc(app.amortization_type||'Fixed')+'</AmortizationType><LoanAmortizationPeriodCount>'+(eff.term)+'</LoanAmortizationPeriodCount><LoanAmortizationPeriodType>Month</LoanAmortizationPeriodType></AMORTIZATION_RULE></AMORTIZATION>');
    if (n2(app.cash_to_borrower) != null) p('      <CLOSING_INFORMATION><CLOSING_INFORMATION_DETAIL><CashToBorrowerAtClosingAmount>'+n2(app.cash_to_borrower)+'</CashToBorrowerAtClosingAmount></CLOSING_INFORMATION_DETAIL></CLOSING_INFORMATION>');
    p('      <DOCUMENT_SPECIFIC_DATA_SETS><DOCUMENT_SPECIFIC_DATA_SET><URLA><URLA_DETAIL><AlterationsImprovementsAndRepairsAmount>0</AlterationsImprovementsAndRepairsAmount><EstimatedClosingCostsAmount>'+(n2(app.estimated_closing_costs)||'0')+'</EstimatedClosingCostsAmount>'+miffTag+'</URLA_DETAIL></URLA></DOCUMENT_SPECIFIC_DATA_SET></DOCUMENT_SPECIFIC_DATA_SETS>');
    p('      <HMDA_LOAN><HMDA_LOAN_DETAIL><HMDA_HOEPALoanStatusIndicator>false</HMDA_HOEPALoanStatusIndicator></HMDA_LOAN_DETAIL></HMDA_LOAN>');
    p('      <HOUSING_EXPENSES>');
    if (piAmt) p('        <HOUSING_EXPENSE><HousingExpensePaymentAmount>'+piAmt+'</HousingExpensePaymentAmount><HousingExpenseTimingType>Proposed</HousingExpenseTimingType><HousingExpenseType>FirstMortgagePrincipalAndInterest</HousingExpenseType></HOUSING_EXPENSE>');
    if (insAmt) p('        <HOUSING_EXPENSE><HousingExpensePaymentAmount>'+insAmt+'</HousingExpensePaymentAmount><HousingExpenseTimingType>Proposed</HousingExpenseTimingType><HousingExpenseType>HomeownersInsurance</HousingExpenseType></HOUSING_EXPENSE>');
    if (taxAmt) p('        <HOUSING_EXPENSE><HousingExpensePaymentAmount>'+taxAmt+'</HousingExpensePaymentAmount><HousingExpenseTimingType>Proposed</HousingExpenseTimingType><HousingExpenseType>RealEstateTax</HousingExpenseType></HOUSING_EXPENSE>');
    if (miAmt) p('        <HOUSING_EXPENSE><HousingExpensePaymentAmount>'+miAmt+'</HousingExpensePaymentAmount><HousingExpenseTimingType>Proposed</HousingExpenseTimingType><HousingExpenseType>MIPremium</HousingExpenseType></HOUSING_EXPENSE>');
    p('      </HOUSING_EXPENSES>');
    p('      <LOAN_DETAIL><BalloonIndicator>false</BalloonIndicator><BelowMarketSubordinateFinancingIndicator>false</BelowMarketSubordinateFinancingIndicator><BorrowerCount>'+borrowerCount+'</BorrowerCount><BuydownTemporarySubsidyFundingIndicator>false</BuydownTemporarySubsidyFundingIndicator><ConstructionLoanIndicator>false</ConstructionLoanIndicator><ConversionOfContractForDeedIndicator>false</ConversionOfContractForDeedIndicator><EnergyRelatedImprovementsIndicator>false</EnergyRelatedImprovementsIndicator><InterestOnlyIndicator>false</InterestOnlyIndicator><NegativeAmortizationIndicator>false</NegativeAmortizationIndicator><PrepaymentPenaltyIndicator>false</PrepaymentPenaltyIndicator><RenovationLoanIndicator>false</RenovationLoanIndicator><TotalMortgagedPropertiesCount>'+(1+reoAssets.length)+'</TotalMortgagedPropertiesCount><TotalSubordinateFinancingAmount>0</TotalSubordinateFinancingAmount></LOAN_DETAIL>');
    p('      <LOAN_IDENTIFIERS><LOAN_IDENTIFIER><LoanIdentifier>'+esc(app.borrower_id||app.id)+'</LoanIdentifier><LoanIdentifierType>LenderLoan</LoanIdentifierType></LOAN_IDENTIFIER></LOAN_IDENTIFIERS>');
    p('      <LOAN_PRODUCT><LOAN_PRODUCT_DETAIL><DiscountPointsTotalAmount>0</DiscountPointsTotalAmount></LOAN_PRODUCT_DETAIL></LOAN_PRODUCT>');
    p('      <ORIGINATION_SYSTEMS><ORIGINATION_SYSTEM><LoanOriginationSystemLoanIdentifier>'+esc(app.borrower_id||app.id)+'</LoanOriginationSystemLoanIdentifier><LoanOriginationSystemName>LendingPad</LoanOriginationSystemName></ORIGINATION_SYSTEM></ORIGINATION_SYSTEMS>');
    p('      <PURCHASE_CREDITS />');
    p('      <QUALIFICATION />');
    if (purpose === 'Refinance') p('      <REFINANCE><RefinanceCashOutDeterminationType>LimitedCashOut</RefinanceCashOutDeterminationType></REFINANCE>');
    p('      <TERMS_OF_LOAN><BaseLoanAmount>'+(n2(eff.loanAmount)||'0')+'</BaseLoanAmount><LienPriorityType>FirstLien</LienPriorityType><LoanPurposeType>'+purpose+'</LoanPurposeType><MortgageType>'+mtgType+'</MortgageType><NoteAmount>'+(n2(eff.loanAmount)||'0')+'</NoteAmount>'+(n2(eff.rate)?'<NoteRatePercent>'+n2(eff.rate)+'</NoteRatePercent>':'')+'</TERMS_OF_LOAN>');
    p('    </LOAN></LOANS>');

    // PARTIES
    p('    <PARTIES>');
    for (const b of borrowers) {
      p('      <PARTY>');
      // INDIVIDUAL
      p('        <INDIVIDUAL>');
      if (b.phone || b.email) {
        p('          <CONTACT_POINTS>');
        if (b.phone) p('            <CONTACT_POINT><CONTACT_POINT_TELEPHONE><ContactPointTelephoneValue>'+esc(b.phone)+'</ContactPointTelephoneValue></CONTACT_POINT_TELEPHONE><CONTACT_POINT_DETAIL><ContactPointRoleType>Mobile</ContactPointRoleType></CONTACT_POINT_DETAIL></CONTACT_POINT>');
        if (b.email) p('            <CONTACT_POINT><CONTACT_POINT_EMAIL><ContactPointEmailValue>'+esc(b.email)+'</ContactPointEmailValue></CONTACT_POINT_EMAIL></CONTACT_POINT>');
        p('          </CONTACT_POINTS>');
      }
      p('          <NAME><FirstName>'+esc(b.first)+'</FirstName><LastName>'+esc(b.last)+'</LastName></NAME>');
      p('        </INDIVIDUAL>');
      // LANGUAGES
      p('        <LANGUAGES><LANGUAGE><LanguageCode>eng</LanguageCode><EXTENSION><OTHER><ULAD:LANGUAGE_EXTENSION><ULAD:LanguageRefusalIndicator>false</ULAD:LanguageRefusalIndicator></ULAD:LANGUAGE_EXTENSION></OTHER></EXTENSION></LANGUAGE></LANGUAGES>');
      // ROLES > ROLE > BORROWER
      p('        <ROLES><ROLE SequenceNumber="'+b.order+'" xlink:label="'+b.label+'">');
      p('          <BORROWER>');
      p('            <BORROWER_DETAIL>'+(b.dob?'<BorrowerBirthDate>'+esc(b.dob)+'</BorrowerBirthDate>':'')+'<CommunityPropertyStateResidentIndicator>false</CommunityPropertyStateResidentIndicator><DependentCount>'+(b.dependents||0)+'</DependentCount><MaritalStatusType>'+mapMarital(b.marital)+'</MaritalStatusType></BORROWER_DETAIL>');
      // CURRENT_INCOME
      if (b.incomeItems.length) {
        p('            <CURRENT_INCOME><CURRENT_INCOME_ITEMS>');
        for (const it of b.incomeItems) {
          p('              <CURRENT_INCOME_ITEM SequenceNumber="'+it.label.split('_').pop()+'" xlink:label="'+it.label+'"><CURRENT_INCOME_ITEM_DETAIL><CurrentIncomeMonthlyTotalAmount>'+(it.amount||'0')+'</CurrentIncomeMonthlyTotalAmount><EmploymentIncomeIndicator>'+(it.employment?'true':'false')+'</EmploymentIncomeIndicator><IncomeType>'+it.uladType+'</IncomeType></CURRENT_INCOME_ITEM_DETAIL></CURRENT_INCOME_ITEM>');
        }
        p('            </CURRENT_INCOME_ITEMS></CURRENT_INCOME>');
      } else {
        p('            <CURRENT_INCOME><CURRENT_INCOME_ITEMS /></CURRENT_INCOME>');
      }
      // DECLARATION — real values only; NULL => element omitted (no false attestation).
      const d = b.decl;
      // IntentToOccupy from the primary-residence declaration; fall back to real occupancy usage.
      const intent = d.primaryResidence === true ? 'Yes' : d.primaryResidence === false ? 'No' : (usage === 'PrimaryResidence' ? 'Yes' : 'No');
      // HomeownerPastThreeYears from ownership-interest declaration; omit when unknown.
      const homeowner3yr = d.ownershipInterest === true ? 'Yes' : d.ownershipInterest === false ? 'No' : null;
      let declInner = '';
      declInner += boolTag('BankruptcyIndicator', d.bankruptcy);
      declInner += '<CitizenshipResidencyType>'+mapCitizen(b.citizenship)+'</CitizenshipResidencyType>';
      if (homeowner3yr) declInner += '<HomeownerPastThreeYearsType>'+homeowner3yr+'</HomeownerPastThreeYearsType>';
      declInner += '<IntentToOccupyType>'+intent+'</IntentToOccupyType>';
      declInner += boolTag('OutstandingJudgmentsIndicator', d.outstandingJudgments);
      declInner += boolTag('PartyToLawsuitIndicator', d.lawsuit);
      declInner += boolTag('PresentlyDelinquentIndicator', d.delinquentFederal);
      declInner += boolTag('PriorPropertyDeedInLieuConveyedIndicator', d.deedInLieu);
      declInner += boolTag('PriorPropertyForeclosureCompletedIndicator', d.foreclosure);
      declInner += boolTag('PriorPropertyShortSaleCompletedIndicator', d.shortSale);
      declInner += boolTag('PropertyProposedCleanEnergyLienIndicator', d.lienPriority);
      declInner += boolTag('UndisclosedBorrowedFundsIndicator', d.borrowedFunds);
      declInner += boolTag('UndisclosedComakerOfNoteIndicator', d.cosigner);
      declInner += boolTag('UndisclosedCreditApplicationIndicator', d.newCredit);
      declInner += boolTag('UndisclosedMortgageApplicationIndicator', d.applyingOtherMortgage);
      let declExt = '';
      if (d.familySeller !== null) declExt = '<EXTENSION><OTHER><ULAD:DECLARATION_DETAIL_EXTENSION><ULAD:SpecialBorrowerSellerRelationshipIndicator>'+(d.familySeller?'true':'false')+'</ULAD:SpecialBorrowerSellerRelationshipIndicator></ULAD:DECLARATION_DETAIL_EXTENSION></OTHER></EXTENSION>';
      p('            <DECLARATION><DECLARATION_DETAIL>'+declInner+declExt+'</DECLARATION_DETAIL></DECLARATION>');
      p('            <DEPENDENTS />');
      // EMPLOYERS
      if (b.emp_name) {
        p('            <EMPLOYERS><EMPLOYER SequenceNumber="1" xlink:label="'+b.empLabel+'">');
        p('              <LEGAL_ENTITY><LEGAL_ENTITY_DETAIL><FullName>'+esc(b.emp_name)+'</FullName></LEGAL_ENTITY_DETAIL></LEGAL_ENTITY>');
        if (b.emp_street || b.emp_city) p('              <ADDRESS>'+(b.emp_street?'<AddressLineText>'+esc(b.emp_street)+'</AddressLineText>':'')+(b.emp_city?'<CityName>'+esc(b.emp_city)+'</CityName>':'')+'<CountryCode>US</CountryCode>'+(b.emp_zip?'<PostalCode>'+esc(b.emp_zip)+'</PostalCode>':'')+(b.emp_state?'<StateCode>'+esc(b.emp_state)+'</StateCode>':'')+'</ADDRESS>');
        p('              <EMPLOYMENT><EmploymentBorrowerSelfEmployedIndicator>'+(b.is_self_employed?'true':'false')+'</EmploymentBorrowerSelfEmployedIndicator><EmploymentClassificationType>Primary</EmploymentClassificationType><EmploymentMonthlyIncomeAmount>'+(b.is_self_employed?(n2(b.seIncome)||'0'):'0')+'</EmploymentMonthlyIncomeAmount>'+(b.emp_position?'<EmploymentPositionDescription>'+esc(b.emp_position)+'</EmploymentPositionDescription>':'')+(b.emp_start?'<EmploymentStartDate>'+esc(b.emp_start)+'</EmploymentStartDate>':'')+'<EmploymentStatusType>Current</EmploymentStatusType><EmploymentTimeInLineOfWorkMonthsCount>0</EmploymentTimeInLineOfWorkMonthsCount>'+(b.is_self_employed?'<OwnershipInterestType>GreaterThanOrEqualTo25Percent</OwnershipInterestType>':'')+'<SpecialBorrowerEmployerRelationshipIndicator>false</SpecialBorrowerEmployerRelationshipIndicator></EMPLOYMENT>');
        p('            </EMPLOYER></EMPLOYERS>');
      } else {
        p('            <EMPLOYERS />');
      }
      // GOVERNMENT_MONITORING — REAL demographic data only; empty => omitted.
      // A refusal is emitted ONLY on an explicit "do not wish to provide" signal.
      const h = b.hmda;
      const ethVals = (h.ethnicity || []).filter(Boolean);
      const raceVals = (h.race || []).filter(Boolean);
      const ethRefused = ethVals.some(isRefusal);
      const raceRefused = raceVals.some(isRefusal);
      const sexRefused = isRefusal(h.sex);
      const ethTypes = Array.from(new Set(ethVals.map(mapEthnicityType).filter(Boolean))) as string[];
      const raceTypes = Array.from(new Set(raceVals.map(mapRaceType).filter(Boolean))) as string[];
      const genderType = sexRefused ? null : mapGenderType(h.sex);

      let gmDetail = '';
      // Ethnicity: refusal flag only when genuinely refused; observation flag only when we have data.
      if (ethRefused) gmDetail += '<HMDAEthnicityRefusalIndicator>true</HMDAEthnicityRefusalIndicator>';
      else if (ethTypes.length) gmDetail += '<HMDAEthnicityCollectedBasedOnVisualObservationOrSurnameIndicator>false</HMDAEthnicityCollectedBasedOnVisualObservationOrSurnameIndicator><HMDAEthnicityRefusalIndicator>false</HMDAEthnicityRefusalIndicator>';
      if (sexRefused) gmDetail += '<HMDAGenderRefusalIndicator>true</HMDAGenderRefusalIndicator>';
      else if (genderType) gmDetail += '<HMDAGenderCollectedBasedOnVisualObservationOrNameIndicator>false</HMDAGenderCollectedBasedOnVisualObservationOrNameIndicator><HMDAGenderRefusalIndicator>false</HMDAGenderRefusalIndicator><HMDAGenderType>'+genderType+'</HMDAGenderType>';
      if (raceRefused) gmDetail += '<HMDARaceRefusalIndicator>true</HMDARaceRefusalIndicator>';
      else if (raceTypes.length) gmDetail += '<HMDARaceCollectedBasedOnVisualObservationOrSurnameIndicator>false</HMDARaceCollectedBasedOnVisualObservationOrSurnameIndicator><HMDARaceRefusalIndicator>false</HMDARaceRefusalIndicator>';
      const gmExt = '<EXTENSION><OTHER><ULAD:GOVERNMENT_MONITORING_DETAIL_EXTENSION><ULAD:ApplicationTakenMethodType>Internet</ULAD:ApplicationTakenMethodType></ULAD:GOVERNMENT_MONITORING_DETAIL_EXTENSION></OTHER></EXTENSION>';
      let gm = '            <GOVERNMENT_MONITORING><GOVERNMENT_MONITORING_DETAIL>'+gmDetail+gmExt+'</GOVERNMENT_MONITORING_DETAIL>';
      if (ethTypes.length) { gm += '<HMDA_ETHNICITY_ORIGINS>'; for (const t of ethTypes) gm += '<HMDA_ETHNICITY_ORIGIN><HMDAEthnicityType>'+t+'</HMDAEthnicityType></HMDA_ETHNICITY_ORIGIN>'; gm += '</HMDA_ETHNICITY_ORIGINS>'; }
      if (raceTypes.length) { gm += '<HMDA_RACES>'; for (const t of raceTypes) gm += '<HMDA_RACE><HMDA_RACE_DETAIL><HMDARaceType>'+t+'</HMDARaceType></HMDA_RACE_DETAIL></HMDA_RACE>'; gm += '</HMDA_RACES>'; }
      gm += '</GOVERNMENT_MONITORING>';
      p(gm);
      // RESIDENCES
      if (b.addr_street || b.addr_city) {
        const basis = mapHousing(b.housing);
        p('            <RESIDENCES><RESIDENCE><ADDRESS>'+(b.addr_street?'<AddressLineText>'+esc(b.addr_street)+'</AddressLineText>':'')+(b.addr_city?'<CityName>'+esc(b.addr_city)+'</CityName>':'')+'<CountryCode>US</CountryCode>'+(b.addr_zip?'<PostalCode>'+esc(b.addr_zip)+'</PostalCode>':'')+(b.addr_state?'<StateCode>'+esc(b.addr_state)+'</StateCode>':'')+'</ADDRESS><RESIDENCE_DETAIL>'+(basis?'<BorrowerResidencyBasisType>'+basis+'</BorrowerResidencyBasisType>':'')+(b.months?'<BorrowerResidencyDurationMonthsCount>'+b.months+'</BorrowerResidencyDurationMonthsCount>':'')+'<BorrowerResidencyType>Current</BorrowerResidencyType></RESIDENCE_DETAIL></RESIDENCE></RESIDENCES>');
      }
      p('          </BORROWER>');
      p('          <ROLE_DETAIL><PartyRoleType>Borrower</PartyRoleType></ROLE_DETAIL>');
      p('        </ROLE></ROLES>');
      // TAXPAYER_IDENTIFIERS
      if (b.ssnFull) p('        <TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER><TaxpayerIdentifierType>SocialSecurityNumber</TaxpayerIdentifierType><TaxpayerIdentifierValue>'+esc(b.ssnFull)+'</TaxpayerIdentifierValue></TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS>');
      p('      </PARTY>');
    }
    // LoanOriginationCompany party
    if (app.lo_org_name) {
      p('      <PARTY>');
      p('        <LEGAL_ENTITY><LEGAL_ENTITY_DETAIL><FullName>'+esc(app.lo_org_name)+'</FullName></LEGAL_ENTITY_DETAIL></LEGAL_ENTITY>');
      p('        <ROLES><ROLE>'+(app.lo_org_nmls?'<LICENSES><LICENSE><LICENSE_DETAIL><LicenseAuthorityLevelType>Private</LicenseAuthorityLevelType><LicenseIdentifier>'+esc(app.lo_org_nmls)+'</LicenseIdentifier></LICENSE_DETAIL></LICENSE></LICENSES>':'')+'<ROLE_DETAIL><PartyRoleType>LoanOriginationCompany</PartyRoleType></ROLE_DETAIL></ROLE></ROLES>');
      p('      </PARTY>');
    }
    // LoanOriginator party
    if (app.lo_name) {
      const loFirst = String(app.lo_name).trim().split(/\s+/)[0] || app.lo_name;
      const loLast = String(app.lo_name).trim().split(/\s+/).slice(1).join(' ') || '';
      p('      <PARTY>');
      p('        <INDIVIDUAL>');
      if (app.lo_phone || app.lo_email) {
        p('          <CONTACT_POINTS>');
        if (app.lo_phone) p('            <CONTACT_POINT><CONTACT_POINT_TELEPHONE><ContactPointTelephoneValue>'+esc(digits(app.lo_phone))+'</ContactPointTelephoneValue></CONTACT_POINT_TELEPHONE><CONTACT_POINT_DETAIL><ContactPointRoleType>Work</ContactPointRoleType></CONTACT_POINT_DETAIL></CONTACT_POINT>');
        if (app.lo_email) p('            <CONTACT_POINT><CONTACT_POINT_EMAIL><ContactPointEmailValue>'+esc(app.lo_email)+'</ContactPointEmailValue></CONTACT_POINT_EMAIL></CONTACT_POINT>');
        p('          </CONTACT_POINTS>');
      }
      p('          <NAME><FirstName>'+esc(loFirst)+'</FirstName><LastName>'+esc(loLast)+'</LastName></NAME>');
      p('        </INDIVIDUAL>');
      p('        <ROLES><ROLE>'+(app.lo_nmls?'<LICENSES><LICENSE><LICENSE_DETAIL><LicenseAuthorityLevelType>Private</LicenseAuthorityLevelType><LicenseIdentifier>'+esc(app.lo_nmls)+'</LicenseIdentifier></LICENSE_DETAIL></LICENSE></LICENSES>':'')+'<ROLE_DETAIL><PartyRoleType>LoanOriginator</PartyRoleType></ROLE_DETAIL></ROLE></ROLES>');
      p('      </PARTY>');
    }
    p('    </PARTIES>');

    // RELATIONSHIPS
    p('    <RELATIONSHIPS>');
    let rseq = 0;
    const rel = (arc: string, from: string, to: string) => { rseq++; p('      <RELATIONSHIP SequenceNumber="'+rseq+'" xlink:arcrole="urn:fdc:mismo.org:2009:residential/'+arc+'" xlink:from="'+from+'" xlink:to="'+to+'" />'); };
    for (const a of cashAssets) if (a.owner) rel('ASSET_IsAssociatedWith_ROLE', a.label, a.owner.label);
    for (const r of reoAssets) { if (r.owner) rel('ASSET_IsAssociatedWith_ROLE', r.label, r.owner.label); }
    for (const b of borrowers) for (const it of b.incomeItems) if (it.emp) rel('CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER', it.label, it.emp);
    for (const l of liabilities) if (l.owner) rel('LIABILITY_IsAssociatedWith_ROLE', l.label, l.owner.label);
    p('    </RELATIONSHIPS>');

    p('  </DEAL></DEALS></DEAL_SET></DEAL_SETS>');
    p('</MESSAGE>');

    const xml = out.join('\r\n');
    const first = borrowers[0]?.first || app.first_name || 'Borrower';
    const last = borrowers[0]?.last || app.last_name || '';
    const fileName = `MISMO_3.4_${String(last).replace(/\s+/g,'_')}_${String(first).replace(/\s+/g,'_')}_${new Date().toISOString().slice(0,10)}.xml`;

    // Demographic collection status — surfaced so the operator knows HMDA is a data gap.
    const hmdaStatus = {
      borrower_ethnicity: (borrowers[0]?.hmda?.ethnicity || []).length > 0,
      borrower_race: (borrowers[0]?.hmda?.race || []).length > 0,
      borrower_sex: !!borrowers[0]?.hmda?.sex,
    };
    if (!hmdaStatus.borrower_ethnicity && !hmdaStatus.borrower_race && !hmdaStatus.borrower_sex) {
      warnings.push('HMDA demographics (ethnicity/race/sex) not collected for the borrower — omitted rather than reported as refused. Collect in the portal/1003.');
    }

    const meta = {
      success: true,
      source: 'generated',
      file_name: fileName,
      length: xml.length,
      borrower_count: borrowers.length,
      liabilities: liabilities.length,
      assets: cashAssets.length,
      reo: reoAssets.length,
      income_source: incomeSourceSummary,           // 'structured' | 'flat_fallback' | 'mixed'
      hmda_status: hmdaStatus,
      warnings,                                       // never silent — Group B gate reads these
    };

    if (debug) {
      return new Response(JSON.stringify({ ...meta, xml }), { headers: cors });
    }
    const bytes = new TextEncoder().encode(xml);
    let bin = ''; for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    return new Response(JSON.stringify({ ...meta, xml: b64 }), { headers: cors });
  } catch (err: any) {
    console.error('[generate-mismo-data] Error:', err?.message || err);
    return new Response(JSON.stringify({ error: err?.message || 'Server error' }), { status: 500, headers: cors });
  }
});
