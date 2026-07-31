import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey' };
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const AI_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

const ok = (d:any) => new Response(JSON.stringify(d),{headers:{...cors,'Content-Type':'application/json'}});
const err = (m:string,s=400) => new Response(JSON.stringify({error:m}),{status:s,headers:{...cors,'Content-Type':'application/json'}});

function fmt(n:any, prefix='$') { if(!n) return 'N/A'; return prefix + Number(n).toLocaleString(); }
function yn(v:any) { return v ? 'Yes' : 'No'; }

function generateCSV(intakes: any[]): string {
  const headers = ['submission_id','submission_date','loan_purpose','property_address','property_city','property_state','property_zip','property_type','units','square_feet','occupancy_percent','purchase_price','estimated_value','requested_loan_amount','down_payment_or_equity','rehab_budget','target_closing_date','loan_term_preference','interest_only_needed','recourse_preference','borrower_name','entity_name','entity_type','business_name','email','phone','credit_score_estimate','liquidity','net_worth','years_experience','owned_properties_count','similar_projects_count','bankruptcy_foreclosure_history','guarantors','monthly_gross_rents','other_income','monthly_operating_expenses','annual_taxes','annual_insurance','hoa_dues','current_mortgage_payment','noi','dscr','cap_rate','time_in_business','industry','annual_revenue','net_income','employees','owner_occupancy_percent','franchise','business_debt_total','purchase_contract','offering_memorandum','rent_roll','t12','leases','property_photos','mortgage_statement','bank_statements','pfs','sre','personal_tax_returns','business_tax_returns','pl','balance_sheet','entity_docs','driver_license','scope_of_work','contractor_bids','plans_permits','insurance_decl','other_docs','status','notes'];
  const rows = intakes.map(i => [
    i.submission_id, i.submitted_at||i.created_at, i.loan_purpose, i.property_address,
    i.property_city, i.property_state, i.property_zip, i.property_type, i.units, i.square_feet,
    i.occupancy_pct, i.purchase_price, i.estimated_value, i.requested_loan_amount,
    i.down_payment_equity, i.rehab_budget, i.target_closing_date, i.loan_term_preference,
    yn(i.interest_only_needed), i.recourse_preference, i.borrower_name, i.entity_name,
    i.entity_type, i.business_name, i.borrower_email, i.borrower_phone, i.credit_score_estimate,
    i.liquidity, i.net_worth, i.years_experience, i.owned_properties_count, i.similar_projects_count,
    i.bankruptcy_foreclosure_history, i.guarantors, i.monthly_gross_rents, i.other_income,
    i.monthly_operating_expenses, i.annual_taxes, i.annual_insurance, i.hoa_dues,
    i.current_mortgage_payment, i.noi, i.dscr, i.cap_rate, i.time_in_business, i.industry,
    i.annual_revenue, i.net_income, i.employees, i.owner_occupancy_pct, yn(i.franchise),
    i.business_debt_total, yn(i.doc_purchase_contract), yn(i.doc_offering_memorandum),
    yn(i.doc_rent_roll), yn(i.doc_t12), yn(i.doc_leases), yn(i.doc_property_photos),
    yn(i.doc_mortgage_statement), yn(i.doc_bank_statements), yn(i.doc_pfs), yn(i.doc_sre),
    yn(i.doc_personal_tax_returns), yn(i.doc_business_tax_returns), yn(i.doc_pl),
    yn(i.doc_balance_sheet), yn(i.doc_entity_docs), yn(i.doc_driver_license),
    yn(i.doc_scope_of_work), yn(i.doc_contractor_bids), yn(i.doc_plans_permits),
    yn(i.doc_insurance_decl), yn(i.doc_other), i.status, i.internal_notes
  ].map(v => `"${String(v||'').replace(/"/g,'""')}"`));
  return [headers.join(','), ...rows.map(r=>r.join(','))].join('\n');
}

function generatePDFHTML(i: any): string {
  const reqDocs = [
    ['Purchase Contract', i.doc_purchase_contract],
    ['Offering Memorandum', i.doc_offering_memorandum],
    ['Rent Roll', i.doc_rent_roll],
    ['T-12 Operating Statement', i.doc_t12],
    ['Current Leases', i.doc_leases],
    ['Property Photos', i.doc_property_photos],
    ['Mortgage Statement', i.doc_mortgage_statement],
    ['Bank Statements (3 mo.)', i.doc_bank_statements],
    ['Personal Financial Statement', i.doc_pfs],
    ['Schedule of Real Estate Owned', i.doc_sre],
    ['Personal Tax Returns (2yr)', i.doc_personal_tax_returns],
    ['Business Tax Returns (2yr)', i.doc_business_tax_returns],
    ['P&L Statement', i.doc_pl],
    ['Balance Sheet', i.doc_balance_sheet],
    ['Entity Formation Docs', i.doc_entity_docs],
    ['Driver License / ID', i.doc_driver_license],
    ['Scope of Work', i.doc_scope_of_work],
    ['Contractor Bids', i.doc_contractor_bids],
    ['Plans / Permits', i.doc_plans_permits],
    ['Insurance Declaration', i.doc_insurance_decl],
  ];
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body{font-family:Arial,sans-serif;font-size:12px;color:#1a1a1a;margin:0;padding:40px;}
  .header{background:#1a1a1a;color:#C9A84C;padding:24px 32px;margin:-40px -40px 32px;}
  .header h1{margin:0;font-size:22px;letter-spacing:1px;}
  .header .sub{font-size:11px;color:#aaa;margin-top:4px;}
  .meta{display:flex;gap:40px;margin-bottom:24px;padding:16px;background:#f8f8f8;border-radius:6px;}
  .meta div{flex:1;}
  .meta .label{font-size:10px;text-transform:uppercase;color:#888;margin-bottom:2px;}
  .meta .val{font-size:14px;font-weight:700;color:#1a1a1a;}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#C9A84C;border-bottom:2px solid #C9A84C;padding-bottom:6px;margin:24px 0 12px;}
  table{width:100%;border-collapse:collapse;margin-bottom:8px;}
  td{padding:7px 10px;border-bottom:1px solid #eee;vertical-align:top;}
  td:first-child{font-weight:600;color:#555;width:42%;font-size:11px;text-transform:uppercase;}
  td:last-child{color:#1a1a1a;}
  .doc-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px;}
  .doc-item{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;font-size:11px;}
  .doc-yes{background:#e8f5e9;color:#2e7d32;}
  .doc-no{background:#fafafa;color:#aaa;}
  .badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:700;text-transform:uppercase;}
  .badge-new{background:#E3F2FD;color:#1565C0;}
  .footer{margin-top:40px;padding-top:16px;border-top:1px solid #ddd;font-size:10px;color:#aaa;text-align:center;}
</style></head><body>
<div class="header">
  <h1>🏢 Commercial Loan Intake Summary</h1>
  <div class="sub">RFD Group LLC · Rates & Realty · rene@ratesandrealty.com · (714) 555-0100</div>
</div>

<div class="meta">
  <div><div class="label">Submission ID</div><div class="val">${i.submission_id}</div></div>
  <div><div class="label">Submitted</div><div class="val">${new Date(i.submitted_at||i.created_at).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div></div>
  <div><div class="label">Borrower</div><div class="val">${i.borrower_name||'—'}</div></div>
  <div><div class="label">Property</div><div class="val">${i.property_address||'—'}</div></div>
  <div><div class="label">Status</div><div class="val"><span class="badge badge-new">${i.status||'submitted'}</span></div></div>
</div>

<h2>1. Deal Summary</h2>
<table>
  <tr><td>Loan Purpose</td><td>${i.loan_purpose||'—'}</td></tr>
  <tr><td>Property Address</td><td>${[i.property_address,i.property_city,i.property_state,i.property_zip].filter(Boolean).join(', ')||'—'}</td></tr>
  <tr><td>Property Type</td><td>${i.property_type||'—'}</td></tr>
  <tr><td>Units / Square Feet</td><td>${i.units||'—'} units / ${i.square_feet?Number(i.square_feet).toLocaleString()+' SF':'—'}</td></tr>
  <tr><td>Occupancy</td><td>${i.occupancy_pct||'—'}%</td></tr>
  <tr><td>Purchase Price / Value</td><td>${fmt(i.purchase_price)} / ${fmt(i.estimated_value)}</td></tr>
  <tr><td>Requested Loan Amount</td><td>${fmt(i.requested_loan_amount)}</td></tr>
  <tr><td>Down Payment / Equity</td><td>${fmt(i.down_payment_equity)}</td></tr>
  ${i.rehab_budget?`<tr><td>Rehab Budget</td><td>${fmt(i.rehab_budget)}</td></tr>`:''}
  <tr><td>Target Closing Date</td><td>${i.target_closing_date||'—'}</td></tr>
  <tr><td>Loan Term Preference</td><td>${i.loan_term_preference||'—'}</td></tr>
  <tr><td>Interest Only Needed</td><td>${yn(i.interest_only_needed)}</td></tr>
  <tr><td>Recourse Preference</td><td>${i.recourse_preference||'—'}</td></tr>
  ${i.current_lender?`<tr><td>Current Lender</td><td>${i.current_lender} @ ${i.current_rate||'—'}% — Maturity: ${i.maturity_date||'—'}</td></tr>`:''}
</table>

<h2>2. Borrower / Sponsor</h2>
<table>
  <tr><td>Borrower Name</td><td>${i.borrower_name||'—'}</td></tr>
  <tr><td>Entity Name / Type</td><td>${i.entity_name||'—'} (${i.entity_type||'—'})</td></tr>
  <tr><td>Email / Phone</td><td>${i.borrower_email||'—'} / ${i.borrower_phone||'—'}</td></tr>
  <tr><td>Credit Score Estimate</td><td>${i.credit_score_estimate||'—'}</td></tr>
  <tr><td>Liquidity / Net Worth</td><td>${fmt(i.liquidity)} / ${fmt(i.net_worth)}</td></tr>
  <tr><td>Years Experience</td><td>${i.years_experience||'—'} years</td></tr>
  <tr><td>Owned Properties</td><td>${i.owned_properties_count||'—'}</td></tr>
  <tr><td>Similar Projects Completed</td><td>${i.similar_projects_count||'—'}</td></tr>
  <tr><td>Guarantors</td><td>${i.guarantors||'—'}</td></tr>
  <tr><td>Bankruptcy / Foreclosure</td><td>${i.bankruptcy_foreclosure_history||'None'}</td></tr>
</table>

<h2>3. Property Financials</h2>
<table>
  <tr><td>Monthly Gross Rents</td><td>${fmt(i.monthly_gross_rents)}/mo</td></tr>
  <tr><td>Other Income</td><td>${fmt(i.other_income)}/mo</td></tr>
  <tr><td>Monthly Operating Expenses</td><td>${fmt(i.monthly_operating_expenses)}/mo</td></tr>
  <tr><td>Annual Taxes / Insurance</td><td>${fmt(i.annual_taxes)} / ${fmt(i.annual_insurance)}</td></tr>
  <tr><td>HOA Dues</td><td>${fmt(i.hoa_dues)}</td></tr>
  <tr><td>Net Operating Income (NOI)</td><td><strong>${fmt(i.noi)}</strong></td></tr>
  <tr><td>DSCR</td><td><strong>${i.dscr||'—'}x</strong></td></tr>
  <tr><td>Cap Rate</td><td><strong>${i.cap_rate||'—'}%</strong></td></tr>
  <tr><td>Rent Roll / T-12 / Leases</td><td>${yn(i.rent_roll_available)} / ${yn(i.t12_available)} / ${yn(i.leases_available)}</td></tr>
</table>

${i.time_in_business||i.industry?`
<h2>4. Business Information</h2>
<table>
  <tr><td>Time in Business</td><td>${i.time_in_business||'—'}</td></tr>
  <tr><td>Industry</td><td>${i.industry||'—'}</td></tr>
  <tr><td>Annual Revenue / Net Income</td><td>${fmt(i.annual_revenue)} / ${fmt(i.net_income)}</td></tr>
  <tr><td>Employees</td><td>${i.employees||'—'}</td></tr>
  <tr><td>Owner Occupancy %</td><td>${i.owner_occupancy_pct||'—'}%</td></tr>
  <tr><td>Franchise</td><td>${yn(i.franchise)}</td></tr>
  <tr><td>Total Business Debt</td><td>${fmt(i.business_debt_total)}</td></tr>
</table>`:''}

<h2>5. Document Checklist</h2>
<div class="doc-grid">
  ${reqDocs.map(([name,val])=>`<div class="doc-item ${val?'doc-yes':'doc-no'}">${val?'✅':'⬜'} ${name}</div>`).join('')}
</div>

${i.deal_notes?`<h2>Notes / Special Circumstances</h2><p style="line-height:1.7;">${i.deal_notes}</p>`:''}

<div class="footer">
  Generated by Rates & Realty CRM · RFD Group LLC · Submission ID: ${i.submission_id} · ${new Date().toLocaleString()}<br>
  This document is confidential and intended for lender review purposes only.
</div>
</body></html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});

  const url = new URL(req.url);
  const action = url.searchParams.get('action') || (req.method==='POST' ? (await req.clone().json().catch(()=>({}))).action : null);

  try {
    if (req.method === 'GET') {
      const id = url.searchParams.get('id');
      const contactId = url.searchParams.get('contact_id');
      const adminView = url.searchParams.get('admin') === 'true';
      const exportCsv = url.searchParams.get('export') === 'csv';

      if (action === 'get_pdf' && id) {
        const { data } = await sb.from('commercial_loan_intakes').select('*').eq('id',id).single();
        if (!data) return err('Not found',404);
        const html = generatePDFHTML(data);
        return new Response(html,{headers:{...cors,'Content-Type':'text/html'}});
      }

      let q = sb.from('commercial_loan_intakes').select('*').order('created_at',{ascending:false});
      if (contactId) q = q.eq('contact_id', contactId);
      if (url.searchParams.get('status')) q = q.eq('status', url.searchParams.get('status')!);
      if (url.searchParams.get('state')) q = q.eq('property_state', url.searchParams.get('state')!);
      if (url.searchParams.get('purpose')) q = q.eq('loan_purpose', url.searchParams.get('purpose')!);
      if (url.searchParams.get('type')) q = q.eq('property_type', url.searchParams.get('type')!);
      const minLoan = url.searchParams.get('min_loan');
      const maxLoan = url.searchParams.get('max_loan');
      if (minLoan) q = q.gte('requested_loan_amount', parseFloat(minLoan));
      if (maxLoan) q = q.lte('requested_loan_amount', parseFloat(maxLoan));

      const { data, error } = await q.limit(100);
      if (error) return err(error.message);

      if (exportCsv) {
        const csv = generateCSV(data||[]);
        return new Response(csv,{headers:{...cors,'Content-Type':'text/csv','Content-Disposition':'attachment; filename="commercial-intakes.csv"'}});
      }

      return ok({ success:true, intakes: data||[], count: data?.length||0 });
    }

    const body = await req.json();
    const { action: bodyAction, intake, id } = body;
    const act = bodyAction || action;

    // SAVE DRAFT
    if (act === 'save_draft') {
      const payload = { ...intake, updated_at: new Date().toISOString() };
      if (intake.id) {
        const { data, error } = await sb.from('commercial_loan_intakes').update(payload).eq('id',intake.id).select().single();
        if (error) return err(error.message);
        return ok({ success:true, intake:data });
      } else {
        payload.created_at = new Date().toISOString();
        const { data, error } = await sb.from('commercial_loan_intakes').insert(payload).select().single();
        if (error) return err(error.message);
        return ok({ success:true, intake:data });
      }
    }

    // SUBMIT
    if (act === 'submit') {
      const required = ['loan_purpose','property_address','property_state','property_type','requested_loan_amount','borrower_name','borrower_email','borrower_phone'];
      const missing = required.filter(f => !intake[f]);
      if (missing.length) return err(`Missing required fields: ${missing.join(', ')}`);

      const payload = {
        ...intake,
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      let result;
      if (intake.id) {
        const { data, error } = await sb.from('commercial_loan_intakes').update(payload).eq('id',intake.id).select().single();
        if (error) return err(error.message);
        result = data;
      } else {
        payload.created_at = new Date().toISOString();
        const { data, error } = await sb.from('commercial_loan_intakes').insert(payload).select().single();
        if (error) return err(error.message);
        result = data;
      }

      // Log to activity_events
      if (result.contact_id) {
        await sb.from('activity_events').insert({
          contact_id: result.contact_id,
          type: 'system',
          channel: 'system',
          title: `Commercial Loan Intake Submitted — ${result.submission_id}`,
          description: `${result.loan_purpose} · ${result.property_type} · ${result.property_address} · $${Number(result.requested_loan_amount||0).toLocaleString()}`,
          status: 'submitted',
          created_at: new Date().toISOString()
        }).catch(()=>{});
      }

      return ok({ success:true, intake:result, submission_id: result.submission_id });
    }

    // ADMIN: UPDATE STATUS / NOTES / LENDER
    if (act === 'admin_update') {
      const { intake_id, status, internal_notes, assigned_lender } = body;
      const update: any = { updated_at: new Date().toISOString() };
      if (status) update.status = status;
      if (internal_notes !== undefined) update.internal_notes = internal_notes;
      if (assigned_lender !== undefined) update.assigned_lender = assigned_lender;
      const { data, error } = await sb.from('commercial_loan_intakes').update(update).eq('id',intake_id).select().single();
      if (error) return err(error.message);
      return ok({ success:true, intake:data });
    }

    // UPLOAD FILE
    if (act === 'upload_file') {
      const { intake_id, file_name, file_base64, file_type, doc_field } = body;
      if (!intake_id || !file_base64) return err('intake_id and file_base64 required');
      const binary = Uint8Array.from(atob(file_base64), c => c.charCodeAt(0));
      const path = `${intake_id}/${Date.now()}_${file_name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
      const { error: upErr } = await sb.storage.from('commercial-intake-docs').upload(path, binary, { contentType: file_type||'application/octet-stream', upsert: false });
      if (upErr) return err('Upload failed: ' + upErr.message);
      const { data: urlData } = sb.storage.from('commercial-intake-docs').getPublicUrl(path);
      // Update uploaded_files array and doc flag
      const { data: existing } = await sb.from('commercial_loan_intakes').select('uploaded_files').eq('id',intake_id).single();
      const files = Array.isArray(existing?.uploaded_files) ? existing.uploaded_files : [];
      files.push({ name: file_name, url: urlData.publicUrl, doc_field, uploaded_at: new Date().toISOString() });
      const update: any = { uploaded_files: files, updated_at: new Date().toISOString() };
      if (doc_field) update[doc_field] = true;
      await sb.from('commercial_loan_intakes').update(update).eq('id',intake_id);
      return ok({ success:true, url: urlData.publicUrl, path });
    }

    return err('Unknown action');
  } catch(e:any) {
    console.error('commercial-intake error:', e);
    return err(e.message||'Server error',500);
  }
});
