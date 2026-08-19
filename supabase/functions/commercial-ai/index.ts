import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info' };
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const AI_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

const ok = (d:any) => new Response(JSON.stringify(d),{headers:{...cors,'Content-Type':'application/json'}});
const err = (m:string,s=400) => new Response(JSON.stringify({error:m}),{status:s,headers:{...cors,'Content-Type':'application/json'}});

// ── Core financial calculations ──────────────────────────────────────────────
function calcMonthlyPayment(principal:number, annualRate:number, years:number): number {
  if (!annualRate) return principal / (years * 12);
  const r = annualRate / 100 / 12;
  const n = years * 12;
  return principal * (r * Math.pow(1+r,n)) / (Math.pow(1+r,n)-1);
}

function calcMetrics(d: any) {
  const loanAmt = parseFloat(d.loan_amount)||0;
  const noi = parseFloat(d.noi)||0;
  const rate = parseFloat(d.interest_rate_est)||7.5;
  const amort = parseInt(d.amortization_years)||25;
  const purchasePrice = parseFloat(d.purchase_price)||0;
  const vacancy = parseFloat(d.vacancy_rate)||5;
  const opex = parseFloat(d.operating_expenses)||0;
  const gpr = parseFloat(d.gross_potential_rent)||0;
  const ioYears = parseInt(d.interest_only_period)||0;

  const monthlyPayment = calcMonthlyPayment(loanAmt, rate, amort);
  const annualDebtService = monthlyPayment * 12;
  const effectiveNOI = noi || (gpr * (1 - vacancy/100) - opex);
  const dscr = annualDebtService > 0 ? effectiveNOI / annualDebtService : 0;
  const debtYield = loanAmt > 0 ? (effectiveNOI / loanAmt) * 100 : 0;
  const capRate = purchasePrice > 0 ? (effectiveNOI / purchasePrice) * 100 : 0;
  const ltv = purchasePrice > 0 ? (loanAmt / purchasePrice) * 100 : 0;
  const equity = purchasePrice - loanAmt;
  const cashAfterDebt = effectiveNOI - annualDebtService;
  const coc = equity > 0 ? (cashAfterDebt / equity) * 100 : 0;
  const breakEven = annualDebtService > 0 && gpr > 0 ? ((annualDebtService + opex) / gpr) * 100 : 0;

  // IO payment
  const ioPayment = loanAmt * (rate/100/12);

  return {
    monthly_payment: Math.round(monthlyPayment),
    io_monthly_payment: Math.round(ioPayment),
    annual_debt_service: Math.round(annualDebtService),
    effective_noi: Math.round(effectiveNOI),
    dscr: parseFloat(dscr.toFixed(3)),
    debt_yield: parseFloat(debtYield.toFixed(3)),
    cap_rate: parseFloat(capRate.toFixed(3)),
    ltv: parseFloat(ltv.toFixed(2)),
    cash_on_cash: parseFloat(coc.toFixed(3)),
    break_even_occupancy: parseFloat(breakEven.toFixed(2)),
    equity,
    loan_to_cost: ltv,
  };
}

// ── Sensitivity matrix ──────────────────────────────────────────────────────
function buildSensitivityMatrix(d: any) {
  const baseRate = parseFloat(d.interest_rate_est)||7.5;
  const baseVacancy = parseFloat(d.vacancy_rate)||5;
  const baseNOI = parseFloat(d.noi)||0;
  const loanAmt = parseFloat(d.loan_amount)||0;
  const amort = parseInt(d.amortization_years)||25;

  const rates = [baseRate-1, baseRate-0.5, baseRate, baseRate+0.5, baseRate+1];
  const vacancies = [0, 5, 10, 15, 20];

  return {
    rate_sensitivity: rates.map(r => {
      const pmt = calcMonthlyPayment(loanAmt, r, amort);
      const ads = pmt * 12;
      return {
        rate: r,
        monthly_payment: Math.round(pmt),
        annual_debt_service: Math.round(ads),
        dscr: parseFloat((baseNOI / ads).toFixed(3)),
        label: r === baseRate ? 'BASE' : r < baseRate ? `${(baseRate-r).toFixed(1)}% lower` : `${(r-baseRate).toFixed(1)}% higher`
      };
    }),
    vacancy_sensitivity: vacancies.map(v => {
      const gpr = parseFloat(d.gross_potential_rent)||0;
      const opex = parseFloat(d.operating_expenses)||0;
      const adjNOI = gpr > 0 ? gpr * (1 - v/100) - opex : baseNOI * (1 - (v - baseVacancy)/100);
      const ads = calcMonthlyPayment(loanAmt, baseRate, amort) * 12;
      return {
        vacancy: v,
        effective_noi: Math.round(adjNOI),
        dscr: parseFloat((adjNOI / ads).toFixed(3)),
        label: v === baseVacancy ? 'BASE' : `${v}% vacant`
      };
    }),
    noi_sensitivity: [-20,-10,0,10,20].map(pct => {
      const adjNOI = baseNOI * (1 + pct/100);
      const ads = calcMonthlyPayment(loanAmt, baseRate, amort) * 12;
      return {
        noi_change: pct,
        effective_noi: Math.round(adjNOI),
        dscr: parseFloat((adjNOI / ads).toFixed(3)),
        label: pct === 0 ? 'BASE' : pct > 0 ? `+${pct}% NOI` : `${pct}% NOI`
      };
    })
  };
}

// ── AI document generation ────────────────────────────────────────────────────
async function generateWithAI(systemPrompt: string, userContent: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AI_KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role:'user', content: systemPrompt + '\n\n' + userContent }]
    })
  });
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

Deno.serve(async (req: Request) => {
  if (req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  try {
    const body = await req.json();
    const { action, deal } = body;

    // ── CALCULATE METRICS ──────────────────────────────────────────────────
    if (action === 'calculate') {
      const metrics = calcMetrics(deal);
      return ok({ success:true, metrics });
    }

    // ── SENSITIVITY ANALYSIS ────────────────────────────────────────────────
    if (action === 'sensitivity') {
      const matrix = buildSensitivityMatrix(deal);
      const metrics = calcMetrics(deal);
      return ok({ success:true, base_metrics: metrics, sensitivity: matrix });
    }

    // ── DEAL SCORE & ANALYSIS ──────────────────────────────────────────────
    if (action === 'score_deal') {
      const metrics = calcMetrics(deal);
      const scores: any[] = [];
      let total = 0;
      const max = 100;

      // DSCR score (25 pts)
      let dscrScore = 0;
      if (metrics.dscr >= 1.35) dscrScore = 25;
      else if (metrics.dscr >= 1.25) dscrScore = 20;
      else if (metrics.dscr >= 1.15) dscrScore = 12;
      else if (metrics.dscr >= 1.0) dscrScore = 5;
      scores.push({ category:'DSCR', score:dscrScore, max:25, value:`${metrics.dscr}x`, note: metrics.dscr>=1.25?'Strong':'Needs improvement' });

      // LTV score (20 pts)
      let ltvScore = 0;
      if (metrics.ltv <= 55) ltvScore = 20;
      else if (metrics.ltv <= 65) ltvScore = 16;
      else if (metrics.ltv <= 70) ltvScore = 12;
      else if (metrics.ltv <= 75) ltvScore = 7;
      else if (metrics.ltv <= 80) ltvScore = 3;
      scores.push({ category:'LTV', score:ltvScore, max:20, value:`${metrics.ltv.toFixed(1)}%`, note: metrics.ltv<=65?'Conservative':'Review with lender' });

      // Debt Yield score (20 pts)
      let dyScore = 0;
      if (metrics.debt_yield >= 10) dyScore = 20;
      else if (metrics.debt_yield >= 8) dyScore = 15;
      else if (metrics.debt_yield >= 7) dyScore = 10;
      else if (metrics.debt_yield >= 6) dyScore = 5;
      scores.push({ category:'Debt Yield', score:dyScore, max:20, value:`${metrics.debt_yield.toFixed(2)}%`, note: metrics.debt_yield>=8?'Agency-grade':'Bridge/HM territory' });

      // Cap Rate score (15 pts)
      let crScore = 0;
      if (metrics.cap_rate >= 7) crScore = 15;
      else if (metrics.cap_rate >= 5.5) crScore = 11;
      else if (metrics.cap_rate >= 4.5) crScore = 7;
      else if (metrics.cap_rate >= 3.5) crScore = 3;
      scores.push({ category:'Cap Rate', score:crScore, max:15, value:`${metrics.cap_rate.toFixed(2)}%`, note: metrics.cap_rate>=6?'Strong yield':'Compressed market' });

      // Cash-on-Cash score (10 pts)
      let cocScore = 0;
      if (metrics.cash_on_cash >= 9) cocScore = 10;
      else if (metrics.cash_on_cash >= 7) cocScore = 7;
      else if (metrics.cash_on_cash >= 5) cocScore = 5;
      else if (metrics.cash_on_cash >= 3) cocScore = 2;
      scores.push({ category:'Cash-on-Cash', score:cocScore, max:10, value:`${metrics.cash_on_cash.toFixed(2)}%`, note: metrics.cash_on_cash>=7?'Good returns':'Below market target' });

      // Credit score (10 pts)
      const credit = parseInt(deal.credit_score)||0;
      let creditScore = 0;
      if (credit >= 740) creditScore = 10;
      else if (credit >= 700) creditScore = 7;
      else if (credit >= 660) creditScore = 5;
      else if (credit >= 620) creditScore = 2;
      scores.push({ category:'Credit Score', score:creditScore, max:10, value:credit||'N/A', note: credit>=700?'Qualified':'May limit options' });

      total = scores.reduce((s,x)=>s+x.score,0);
      const grade = total>=80?'A':total>=65?'B':total>=50?'C':total>=35?'D':'F';
      const lenderReadiness = total>=75?'Ready to submit':'Needs strengthening';

      const recommendations: string[] = [];
      if (metrics.dscr < 1.25) recommendations.push('Increase NOI or reduce loan amount to achieve 1.25x+ DSCR');
      if (metrics.ltv > 70) recommendations.push('Consider larger down payment to reduce LTV below 70%');
      if (metrics.debt_yield < 8) recommendations.push('Debt yield below 8% — agency lenders will push back; target bridge/debt fund');
      if (credit < 700) recommendations.push('Credit score below 700 limits agency options; focus on debt funds');
      if (metrics.break_even_occupancy > 85) recommendations.push('High break-even occupancy creates risk — stress test vacancy assumptions');

      return ok({ success:true, metrics, scores, total, max, grade, lender_readiness:lenderReadiness, recommendations });
    }

    // ── GENERATE PRE-APPROVAL ──────────────────────────────────────────────
    if (action === 'generate_preapproval') {
      const metrics = calcMetrics(deal);
      const today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
      const expiry = new Date(Date.now()+90*86400000).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});

      const system = `You are a senior commercial mortgage broker at Rates & Realty (RFD Group LLC) writing a professional pre-approval letter. 
Write in formal business letter format. Be specific, authoritative, and use industry-standard language.
This letter should make a lender want to fund this deal. Include all key deal metrics.
Return clean HTML formatted text suitable for a PDF — use proper paragraph breaks, bold for key terms.`;

      const prompt = `Generate a commercial mortgage pre-approval letter with these details:

BORROWER: ${deal.borrower_name || 'Borrower'} ${deal.borrower_entity ? '/ '+deal.borrower_entity : ''}
CREDIT SCORE: ${deal.credit_score || 'N/A'}
SPONSOR NET WORTH: ${deal.sponsor_net_worth ? '$'+Number(deal.sponsor_net_worth).toLocaleString() : 'N/A'}
SPONSOR LIQUIDITY: ${deal.sponsor_liquidity ? '$'+Number(deal.sponsor_liquidity).toLocaleString() : 'N/A'}

PROPERTY: ${deal.property_address || 'Subject Property'}
PROPERTY TYPE: ${deal.property_type || 'Commercial'}
PURCHASE PRICE: $${Number(deal.purchase_price||0).toLocaleString()}
LOAN AMOUNT: $${Number(deal.loan_amount||0).toLocaleString()}
LTV: ${metrics.ltv.toFixed(1)}%

FINANCIALS:
NOI: $${Number(metrics.effective_noi||0).toLocaleString()}
DSCR: ${metrics.dscr}x
Cap Rate: ${metrics.cap_rate.toFixed(2)}%
Debt Yield: ${metrics.debt_yield.toFixed(2)}%
Est. Rate: ${deal.interest_rate_est||7.5}%
Amortization: ${deal.amortization_years||25} years
Est. Monthly Payment: $${Number(metrics.monthly_payment||0).toLocaleString()}

Date: ${today}
Expires: ${expiry}`;

      const html = await generateWithAI(system, prompt);

      // Save to deal
      if (deal.id) {
        await sb.from('commercial_deals').update({ preapproval_generated_at: new Date().toISOString() }).eq('id', deal.id);
      }

      return ok({ success:true, html, metrics, generated_at: today, expires: expiry });
    }

    // ── GENERATE LOI ────────────────────────────────────────────────────────
    if (action === 'generate_loi') {
      const metrics = calcMetrics(deal);
      const today = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});

      const system = `You are a senior commercial real estate attorney and broker writing a Letter of Intent (LOI) for a commercial mortgage transaction.
This is a binding-intent document. Use precise legal and financial language.
Format as a proper LOI with numbered sections. Be specific about all terms.
Include: Property description, Loan terms, Key conditions, Timeline, Governing law, Signatures.
Return clean HTML with proper formatting.`;

      const prompt = `Generate a commercial mortgage LOI with these terms:

LENDER: [Lender Name TBD]
BORROWER/SPONSOR: ${deal.borrower_name||'Borrower'} ${deal.borrower_entity?'/ '+deal.borrower_entity:''}
DATE: ${today}

PROPERTY:
Address: ${deal.property_address||'Subject Property'}
Type: ${deal.property_type||'Commercial Real Estate'}
Year Built: ${deal.year_built||'N/A'}
Property Class: ${deal.property_class||'N/A'}

PROPOSED LOAN TERMS:
Loan Amount: $${Number(deal.loan_amount||0).toLocaleString()}
Purchase Price / Value: $${Number(deal.purchase_price||0).toLocaleString()}
LTV: ${metrics.ltv.toFixed(1)}%
Interest Rate: ${deal.interest_rate_est||'TBD'}% (estimated — subject to market at closing)
Amortization: ${deal.amortization_years||25} years
Loan Term: ${deal.loan_term||'5/25'}
Prepayment: ${deal.prepayment_structure||'Step-down or yield maintenance'}
Recourse: ${deal.recourse_preference||'Non-Recourse with standard carve-outs'}

KEY METRICS:
NOI: $${Number(metrics.effective_noi||0).toLocaleString()}
DSCR: ${metrics.dscr}x
Debt Yield: ${metrics.debt_yield.toFixed(2)}%
Cap Rate: ${metrics.cap_rate.toFixed(2)}%

BORROWER PROFILE:
Credit Score: ${deal.credit_score||'N/A'}
Net Worth: $${Number(deal.sponsor_net_worth||0).toLocaleString()}
Liquidity: $${Number(deal.sponsor_liquidity||0).toLocaleString()}
Experience: ${deal.sponsor_experience||'Experienced sponsor'}`;

      const html = await generateWithAI(system, prompt);

      if (deal.id) {
        await sb.from('commercial_deals').update({ loi_generated_at: new Date().toISOString() }).eq('id', deal.id);
      }

      return ok({ success:true, html, metrics });
    }

    // ── GENERATE LENDER PACKAGE (EXECUTIVE SUMMARY) ──────────────────────
    if (action === 'generate_lender_package') {
      const metrics = calcMetrics(deal);
      const sensitivity = buildSensitivityMatrix(deal);

      const system = `You are a top-tier commercial mortgage broker preparing a lender submission package / executive summary.
This document is what gets deals funded. Write it to excite lenders while being precise about risks.
Structure: Executive Summary, Property Overview, Market Overview, Financial Analysis, Borrower Profile, Sources & Uses, Request.
Use professional formatting with clear sections. Be specific with numbers. Highlight strengths.
Return clean HTML ready for PDF conversion.`;

      const prompt = `Generate a professional commercial lender submission package:

DEAL OVERVIEW:
Property: ${deal.property_address||'Subject Property'}
Type: ${deal.property_type||'Commercial'} | Class ${deal.property_class||'B'}
Year Built: ${deal.year_built||'N/A'} | ${deal.units_or_sf||''}
Market: ${deal.market_area||deal.property_state||'N/A'} | ${deal.submarket||''}

FINANCING REQUEST:
Loan Amount: $${Number(deal.loan_amount||0).toLocaleString()}
Purchase Price: $${Number(deal.purchase_price||0).toLocaleString()}
LTV: ${metrics.ltv.toFixed(1)}% | Debt Yield: ${metrics.debt_yield.toFixed(2)}%
Rate: ${deal.interest_rate_est||7.5}% | Amortization: ${deal.amortization_years||25} yrs
Recourse: ${deal.recourse_preference||'Non-Recourse'}

FINANCIAL PERFORMANCE:
Gross Potential Rent: $${Number(deal.gross_potential_rent||0).toLocaleString()}
Vacancy Allowance: ${deal.vacancy_rate||5}%
Operating Expenses: $${Number(deal.operating_expenses||0).toLocaleString()}
Net Operating Income: $${Number(metrics.effective_noi||0).toLocaleString()}
Annual Debt Service: $${Number(metrics.annual_debt_service||0).toLocaleString()}
DSCR: ${metrics.dscr}x | Cap Rate: ${metrics.cap_rate.toFixed(2)}%
Cash-on-Cash: ${metrics.cash_on_cash.toFixed(2)}%
Break-Even Occupancy: ${metrics.break_even_occupancy.toFixed(1)}%

SPONSOR:
Name: ${deal.borrower_name||'N/A'} | Entity: ${deal.borrower_entity||'N/A'}
Credit: ${deal.credit_score||'N/A'} | Net Worth: $${Number(deal.sponsor_net_worth||0).toLocaleString()}
Liquidity: $${Number(deal.sponsor_liquidity||0).toLocaleString()}
Experience: ${deal.sponsor_experience||'N/A'}
Portfolio: ${deal.portfolio_units||'N/A'} units / $${Number(deal.portfolio_value||0).toLocaleString()}

DEAL NOTES:
${deal.deal_notes||'Strong asset with stable cash flows.'}`;

      const html = await generateWithAI(system, prompt);
      return ok({ success:true, html, metrics, sensitivity });
    }

    // ── SAVE DEAL ──────────────────────────────────────────────────────────
    if (action === 'save_deal') {
      const metrics = calcMetrics(deal);
      const payload = {
        ...deal,
        dscr: metrics.dscr,
        ltv: metrics.ltv,
        debt_yield: metrics.debt_yield,
        cash_on_cash_return: metrics.cash_on_cash,
        break_even_occupancy: metrics.break_even_occupancy,
        annual_debt_service: metrics.annual_debt_service,
        updated_at: new Date().toISOString()
      };
      delete payload.id; // avoid conflict
      
      if (deal.id) {
        const { data, error } = await sb.from('commercial_deals').update(payload).eq('id',deal.id).select().single();
        if (error) return err(error.message);
        return ok({ success:true, deal:data, metrics });
      } else {
        payload.created_at = new Date().toISOString();
        const { data, error } = await sb.from('commercial_deals').insert(payload).select().single();
        if (error) return err(error.message);
        return ok({ success:true, deal:data, metrics });
      }
    }

    // ── GET SAVED DEALS ────────────────────────────────────────────────────
    if (action === 'get_deals') {
      const { contact_id } = deal || body;
      let q = sb.from('commercial_deals').select('*').order('created_at',{ascending:false});
      if (contact_id) q = q.eq('contact_id', contact_id);
      const { data, error } = await q.limit(20);
      if (error) return err(error.message);
      return ok({ success:true, deals: data||[] });
    }

    return err('Unknown action');
  } catch(e:any) {
    console.error('commercial-ai error:', e);
    return err(e.message||'Server error', 500);
  }
});
