import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey' };
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const AI_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

const ok = (d:any) => new Response(JSON.stringify(d),{headers:{...cors,'Content-Type':'application/json'}});
const err = (m:string,s=400) => new Response(JSON.stringify({error:m}),{status:s,headers:{...cors,'Content-Type':'application/json'}});

async function callClaude(prompt:string, system:string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'x-api-key':AI_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
    body: JSON.stringify({
      model:'claude-sonnet-4-20250514',
      max_tokens:4000,
      messages:[{role:'user',content:prompt}],
      system
    })
  });
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

function formatMoney(n:any): string {
  if (!n) return 'N/A';
  const num = parseFloat(n);
  if (num >= 1000000) return '$' + (num/1000000).toFixed(2) + 'M';
  if (num >= 1000) return '$' + (num/1000).toFixed(0) + 'K';
  return '$' + num.toLocaleString();
}

async function generatePreApproval(deal:any, lender:any): Promise<string> {
  const system = `You are a senior commercial mortgage underwriter at a lending institution. 
Generate a professional commercial loan pre-approval letter in clean HTML. 
Use proper business letter formatting. Be specific with numbers. 
Return ONLY the HTML body content — no markdown, no code fences.`;
  
  const prompt = `Generate a commercial loan pre-approval letter for:

BORROWER: ${deal.borrower_name || 'Borrower'} ${deal.borrower_entity ? '/ ' + deal.borrower_entity : ''}
PROPERTY: ${deal.property_address || 'Subject Property'}, ${deal.property_city || ''} ${deal.property_state || ''}
PROPERTY TYPE: ${deal.property_type_name || 'Commercial Property'}
LOAN AMOUNT: ${formatMoney(deal.loan_amount)}
PURCHASE PRICE: ${formatMoney(deal.purchase_price)}
LTV: ${deal.ltv || 'TBD'}%
DSCR: ${deal.dscr || 'TBD'}
NOI: ${formatMoney(deal.noi)}
CAP RATE: ${deal.cap_rate || 'TBD'}%
OCCUPANCY: ${deal.occupancy_pct || 'TBD'}%
LOAN PRODUCT: ${deal.loan_product_name || 'Commercial Loan'}

LENDER: ${lender?.name || 'Rates & Realty Capital Partners'}
ISSUED BY: Rene Duarte, Commercial Financing Advisor, RFD Group LLC

Include: subject line, date, borrower address block, formal pre-approval language, 
loan terms summary table, conditions/contingencies, expiration date (30 days), 
professional closing signature block for Rene Duarte / RFD Group LLC.`;

  return await callClaude(prompt, system);
}

async function generateLOI(deal:any, lender:any): Promise<string> {
  const system = `You are a commercial real estate financing advisor drafting a Letter of Intent for a loan transaction.
Generate a professional LOI in clean HTML with proper legal business letter formatting.
Be specific, formal, and comprehensive. Return ONLY HTML body content.`;
  
  const prompt = `Generate a commercial loan Letter of Intent (LOI) for:

BORROWER/SPONSOR: ${deal.borrower_name || 'Sponsor'} ${deal.borrower_entity ? '(' + deal.borrower_entity + ')' : ''}
PROPERTY: ${deal.property_address || 'Subject Property'}, ${deal.property_city || ''} ${deal.property_state || ''}
PROPERTY TYPE: ${deal.property_type_name || 'Commercial'}
PURCHASE PRICE / VALUE: ${formatMoney(deal.purchase_price)}
LOAN AMOUNT REQUESTED: ${formatMoney(deal.loan_amount)}
DOWN PAYMENT: ${formatMoney(deal.down_payment)}
LTV: ${deal.ltv || 'TBD'}%
DSCR: ${deal.dscr || 'TBD'}
NOI: ${formatMoney(deal.noi)}
LOAN PRODUCT: ${deal.loan_product_name || 'Bridge Loan'}
SPONSOR NET WORTH: ${formatMoney(deal.sponsor_net_worth)}
SPONSOR LIQUIDITY: ${formatMoney(deal.sponsor_liquidity)}
PROPERTY DESCRIPTION: ${deal.property_description || 'Commercial income-producing property'}

LENDER TARGET: ${lender?.name || 'To Be Determined'}
SUBMITTED BY: Rene Duarte, RFD Group LLC (Commercial Financing Advisory)

Include: date, parties section, property description, proposed terms table (loan amount, rate, term, amortization, LTV, DSCR, recourse), 
conditions to closing, due diligence period, broker fee disclosure, expiration (5 business days), 
signature blocks for borrower and advisor.`;

  return await callClaude(prompt, system);
}

async function generateTermSheet(deal:any, lender:any): Promise<string> {
  const system = `You are a commercial lender generating a loan term sheet.
Create a detailed, professional term sheet in clean HTML with tables.
Return ONLY HTML body content — no markdown.`;
  
  const prompt = `Generate a commercial loan term sheet for:

PROPERTY: ${deal.property_address || 'Subject Property'}, ${deal.property_city || ''} ${deal.property_state || ''}
PROPERTY TYPE: ${deal.property_type_name || 'Commercial'}
BORROWER: ${deal.borrower_name || 'Sponsor'} / ${deal.borrower_entity || 'TBD'}
LOAN AMOUNT: ${formatMoney(deal.loan_amount)}
LTV: ${deal.ltv || 'TBD'}%
DSCR MINIMUM: ${deal.dscr || '1.25'}
NOI: ${formatMoney(deal.noi)}
LOAN PRODUCT: ${deal.loan_product_name || 'Commercial Loan'}
RECOURSE: ${deal.recourse_preference || 'TBD'}
CLOSING TIMELINE: ${deal.max_closing_days || 'TBD'} days
RATE TIER: ${deal.rate_tier_preference || 'TBD'}

LENDER: ${lender?.name || 'Lender TBD'}
CONTACT AE: ${lender?.contact_name || 'TBD'} — ${lender?.contact_email || ''}
CHANNEL: ${lender?.channel || 'Wholesale'}

Include sections: Transaction Overview, Loan Terms table (amount, rate type, term, amortization, LTV, DSCR, prepayment), 
Borrower Requirements, Property Requirements, Fees & Costs, Timeline, 
Conditions Precedent, Lender Contact Info.`;

  return await callClaude(prompt, system);
}

async function generateExecutiveSummary(deal:any): Promise<string> {
  const system = `You are a commercial real estate financing expert creating an executive summary for a loan submission package.
Write a compelling, professional executive summary in clean HTML.
Return ONLY HTML body content.`;
  
  const prompt = `Generate a commercial loan executive summary / deal memo for lender submission:

DEAL NAME: ${deal.deal_name}
BORROWER: ${deal.borrower_name} ${deal.borrower_entity ? '/ ' + deal.borrower_entity : ''}
PROPERTY: ${deal.property_address}, ${deal.property_city} ${deal.property_state}
PROPERTY TYPE: ${deal.property_type_name || 'Commercial'}
PRICE/VALUE: ${formatMoney(deal.purchase_price)}
LOAN REQUEST: ${formatMoney(deal.loan_amount)}
DOWN PAYMENT: ${formatMoney(deal.down_payment)} (${deal.ltv || 'TBD'}% LTV)
NOI: ${formatMoney(deal.noi)}
DSCR: ${deal.dscr || 'TBD'}
CAP RATE: ${deal.cap_rate || 'TBD'}%
OCCUPANCY: ${deal.occupancy_pct || 'TBD'}%
CREDIT SCORE: ${deal.credit_score || 'TBD'}
SPONSOR NET WORTH: ${formatMoney(deal.sponsor_net_worth)}
SPONSOR LIQUIDITY: ${formatMoney(deal.sponsor_liquidity)}
PROPERTY DESCRIPTION: ${deal.property_description || 'Commercial income-producing property'}
DEAL NOTES: ${deal.deal_notes || ''}

Submitted by: Rene Duarte, RFD Group LLC

Include: Executive Summary paragraph, Property Overview, Borrower/Sponsor Profile, 
Financial Analysis table, Investment Highlights, Loan Request Summary, 
Conclusion/Recommendation.`;

  return await callClaude(prompt, system);
}

Deno.serve(async (req:Request) => {
  if (req.method === 'OPTIONS') return new Response(null,{status:204,headers:cors});

  try {
    // GET — fetch deals or documents
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const action = url.searchParams.get('action');
      const dealId = url.searchParams.get('deal_id');
      const contactId = url.searchParams.get('contact_id');

      if (action === 'deals') {
        let q = sb.from('commercial_deals').select(`
          *, 
          property_types(name,category),
          loan_products(name,category)
        `).order('created_at',{ascending:false});
        if (contactId) q = q.eq('contact_id', contactId);
        const {data} = await q;
        return ok({deals: data || []});
      }

      if (action === 'documents' && dealId) {
        const {data} = await sb.from('commercial_documents')
          .select('*').eq('deal_id', dealId).order('created_at',{ascending:false});
        return ok({documents: data || []});
      }

      if (action === 'lenders') {
        const {data} = await sb.from('commercial_lender_profiles').select(`
          *,
          lenders(id,name,contact_name,contact_email,contact_phone,lender_portal,logo_url,rating,is_preferred,channel)
        `).order('closing_speed_days',{ascending:true});
        return ok({lenders: data || []});
      }

      if (action === 'form_data') {
        const token = url.searchParams.get('token');
        if (!token) return err('token required');
        const {data} = await sb.from('commercial_lender_submissions')
          .select('*, lenders(name,logo_url,website)')  
          .eq('form_token', token).single();
        return ok({submission: data});
      }

      return err('action required');
    }

    const body = await req.json();
    const {action} = body;

    // SAVE DEAL
    if (action === 'save_deal') {
      const deal = body.deal;
      if (!deal.deal_name) return err('deal_name required');
      const upsertData = {...deal, updated_at: new Date().toISOString()};
      const {data, error} = deal.id 
        ? await sb.from('commercial_deals').update(upsertData).eq('id',deal.id).select().single()
        : await sb.from('commercial_deals').insert(upsertData).select().single();
      if (error) return err(error.message);
      return ok({success:true, deal:data});
    }

    // GENERATE DOCUMENT
    if (action === 'generate_doc') {
      const {deal_id, doc_type, lender_id} = body;
      if (!deal_id || !doc_type) return err('deal_id and doc_type required');

      // Fetch deal with related data
      const {data:deal} = await sb.from('commercial_deals').select(`
        *, 
        property_types(name),
        loan_products(name)
      `).eq('id',deal_id).single();
      if (!deal) return err('Deal not found');

      // Enrich deal with type names
      const enriched = {
        ...deal,
        property_type_name: deal.property_types?.name,
        loan_product_name: deal.loan_products?.name,
      };

      // Fetch lender if specified
      let lender = null;
      if (lender_id) {
        const {data:l} = await sb.from('commercial_lender_profiles').select(`
          *, lenders(name,contact_name,contact_email,channel,lender_portal)
        `).eq('lender_id',lender_id).single();
        lender = l ? {...l, ...l.lenders} : null;
      }

      let html = '';
      let title = '';

      switch(doc_type) {
        case 'pre_approval':
          html = await generatePreApproval(enriched, lender);
          title = `Pre-Approval Letter — ${deal.deal_name}`;
          break;
        case 'loi':
          html = await generateLOI(enriched, lender);
          title = `Letter of Intent — ${deal.deal_name}`;
          break;
        case 'term_sheet':
          html = await generateTermSheet(enriched, lender);
          title = `Term Sheet — ${deal.deal_name}`;
          break;
        case 'executive_summary':
          html = await generateExecutiveSummary(enriched);
          title = `Executive Summary — ${deal.deal_name}`;
          break;
        default:
          return err('Unknown doc_type');
      }

      // Save document
      const {data:doc} = await sb.from('commercial_documents').insert({
        deal_id,
        lender_id: lender_id || null,
        contact_id: deal.contact_id,
        doc_type,
        title,
        content_html: html,
        status: 'draft',
        generated_by: 'ai',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).select().single();

      return ok({success:true, document:doc, html, title});
    }

    // MATCH LENDERS FOR DEAL
    if (action === 'match_deal') {
      const {deal_id} = body;
      const {data:deal} = await sb.from('commercial_deals').select('*').eq('id',deal_id).single();
      if (!deal) return err('Deal not found');

      // Fetch commercial lender profiles
      const {data:profiles} = await sb.from('commercial_lender_profiles').select(`
        *, lenders(id,name,contact_name,contact_email,contact_phone,lender_portal,logo_url,rating,is_preferred)
      `);

      const WEIGHTS = {loan_product:25,property_type:20,loan_amount:20,dscr:15,credit:10,ltv:5,state:5};
      const matches:any[] = [];

      for (const p of (profiles||[])) {
        const lender = p.lenders;
        if (!lender) continue;
        let score = 0;
        const reasons:string[] = [];
        const disq:string[] = [];

        if (p.min_loan_amount && deal.loan_amount < p.min_loan_amount) disq.push(`Min loan $${(p.min_loan_amount/1e6).toFixed(1)}M`);
        if (p.max_loan_amount && deal.loan_amount > p.max_loan_amount) disq.push(`Max loan $${(p.max_loan_amount/1e6).toFixed(1)}M`);
        if (deal.dscr && p.min_dscr && deal.dscr < p.min_dscr) disq.push(`Min DSCR ${p.min_dscr}`);
        if (deal.credit_score && p.min_credit_score && deal.credit_score < p.min_credit_score) disq.push(`Min credit ${p.min_credit_score}`);
        if (deal.ltv && p.max_ltv && deal.ltv > p.max_ltv) disq.push(`Max LTV ${p.max_ltv}%`);
        if (disq.length > 0) { matches.push({...lender,lender_id:lender.id,score:0,fit_pct:0,disqualifiers:disq,reasons:[],speed_days:p.closing_speed_days,rate_tier:p.rate_tier,min_loan_amount:p.min_loan_amount,max_loan_amount:p.max_loan_amount,min_dscr:p.min_dscr,max_ltv:p.max_ltv}); continue; }

        if (deal.loan_product_id && p.supported_loan_product_ids?.includes(deal.loan_product_id)) { score+=WEIGHTS.loan_product; reasons.push('✅ Supports loan product'); }
        if (deal.property_type_id && p.supported_property_type_ids?.includes(deal.property_type_id)) { score+=WEIGHTS.property_type; reasons.push('✅ Lends on property type'); }
        if ((!p.min_loan_amount||deal.loan_amount>=p.min_loan_amount)&&(!p.max_loan_amount||deal.loan_amount<=p.max_loan_amount)) { score+=WEIGHTS.loan_amount; reasons.push(`✅ Loan amount in range`); }
        if (!deal.dscr||!p.min_dscr||deal.dscr>=p.min_dscr) { score+=WEIGHTS.dscr; if(deal.dscr)reasons.push(`✅ DSCR ${deal.dscr} qualifies`); }
        if (!deal.credit_score||!p.min_credit_score||deal.credit_score>=p.min_credit_score) { score+=WEIGHTS.credit; }
        if (!deal.ltv||!p.max_ltv||deal.ltv<=p.max_ltv) { score+=WEIGHTS.ltv; }
        if (!deal.property_state||!p.states_covered?.length||p.states_covered.includes(deal.property_state)||p.states_covered.includes('Nationwide')) { score+=WEIGHTS.state; }
        if (lender.is_preferred) { score+=5; reasons.push('⭐ Preferred lender'); }

        matches.push({...lender,lender_id:lender.id,score,fit_pct:Math.min(Math.round(score),100),reasons,disqualifiers:[],speed_days:p.closing_speed_days,rate_tier:p.rate_tier,recourse_type:p.recourse_type,min_loan_amount:p.min_loan_amount,max_loan_amount:p.max_loan_amount,min_dscr:p.min_dscr,max_ltv:p.max_ltv});
      }

      const qualified = matches.filter(m=>m.disqualifiers.length===0).sort((a,b)=>b.score-a.score);
      
      // Save matches to deal
      await sb.from('commercial_deals').update({
        matched_lenders: qualified.slice(0,10).map(m=>({lender_id:m.lender_id,score:m.score,fit_pct:m.fit_pct})),
        updated_at: new Date().toISOString()
      }).eq('id',deal_id);

      return ok({success:true, matches:qualified, total:qualified.length});
    }

    // SUBMIT COMMERCIAL LENDER FORM
    if (action === 'submit_lender_form') {
      const {token, ...formData} = body;
      if (!token) return err('token required');
      const {data:sub} = await sb.from('commercial_lender_submissions')
        .select('id,lender_id').eq('form_token',token).single();
      if (!sub) return err('Invalid token');
      await sb.from('commercial_lender_submissions').update({
        ...formData,
        submitted_at: new Date().toISOString(),
        submission_data: formData
      }).eq('form_token',token);
      // Update commercial profile
      await sb.from('commercial_lender_profiles').upsert({
        lender_id: sub.lender_id,
        min_loan_amount: formData.min_loan_amount,
        max_loan_amount: formData.max_loan_amount,
        min_dscr: formData.min_dscr,
        min_credit_score: formData.min_credit_score,
        max_ltv: formData.max_ltv,
        states_covered: formData.states_covered,
        recourse_type: formData.recourse_type,
        closing_speed_days: formData.closing_speed_days,
        rate_tier: formData.rate_tier,
        updated_at: new Date().toISOString()
      },{onConflict:'lender_id'});
      return ok({success:true, message:'Thank you! Your information has been saved.'});
    }

    // GENERATE FORM TOKENS for commercial lenders
    if (action === 'generate_form_tokens') {
      const {data:lenders} = await sb.from('lenders').select('id').eq('is_commercial',true);
      let created = 0;
      for (const l of (lenders||[])) {
        const {data:existing} = await sb.from('commercial_lender_submissions').select('id').eq('lender_id',l.id).single();
        if (!existing) {
          await sb.from('commercial_lender_submissions').insert({lender_id:l.id});
          created++;
        }
      }
      return ok({success:true, created, total:lenders?.length||0});
    }

    return err('Unknown action');
  } catch(e:any) {
    return err(e.message||'Server error',500);
  }
});
