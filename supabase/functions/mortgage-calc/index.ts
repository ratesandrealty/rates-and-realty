// mortgage-calc v2: pulls live market rate from app_config and applies the
// always-quote-0.5%-under rule, unless caller explicitly passes interest_rate.
// Also supports rent_vs_buy comparison.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { monthlyMI, miFactor } from "../_shared/mi-factors.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const PROGRAM_DEFAULTS: Record<string, any> = {
  conventional: { ltv_max: 0.97, dti_max: 0.50, fico_min: 620, rate_offset: 0.000 },
  fha:          { ltv_max: 0.965, dti_max: 0.5699, fico_min: 580, rate_offset: -0.0025 },
  va:           { ltv_max: 1.00, dti_max: 0.55, fico_min: 580, rate_offset: -0.0050 },
  usda:         { ltv_max: 1.00, dti_max: 0.46, fico_min: 640, rate_offset: -0.0025 },
  jumbo:        { ltv_max: 0.90, dti_max: 0.43, fico_min: 700, rate_offset: 0.0025 },
};

const COUNTY_TAX_RATES: Record<string, number> = {
  "orange": 0.0110, "los angeles": 0.0125, "riverside": 0.0125, "san bernardino": 0.0125,
  "san diego": 0.0118, "ventura": 0.0115, "kern": 0.0125, "fresno": 0.0125, "sacramento": 0.0125,
};
const DEFAULT_TAX_RATE = 0.0125;
const DEFAULT_INSURANCE_RATE = 0.0035;

async function getMarketRate(): Promise<{ market: number; quote_offset: number }> {
  const { data } = await sb.from("app_config").select("value").eq("key", "current_market_rate_30yr_fixed").maybeSingle();
  const v = data?.value || {};
  return {
    market: v.rate || 0.0700,
    quote_offset: v.discount_to_quote ?? 0.005,  // always quote 0.5% under market
  };
}

async function resolveRate(program: string, customRate: number | null): Promise<{ rate: number; basis: string }> {
  if (customRate) return { rate: customRate, basis: "caller-supplied" };
  const { market, quote_offset } = await getMarketRate();
  const programOffset = PROGRAM_DEFAULTS[program]?.rate_offset || 0;
  const rate = market - quote_offset + programOffset;
  return {
    rate,
    basis: `market ${(market * 100).toFixed(3)}% \u2212 ${(quote_offset * 100).toFixed(2)}% house discount + ${(programOffset * 100).toFixed(2)}% program offset = ${(rate * 100).toFixed(3)}%`,
  };
}

function calcPI(loanAmount: number, annualRate: number, termYears: number): number {
  const monthlyRate = annualRate / 12;
  const n = termYears * 12;
  if (monthlyRate === 0) return loanAmount / n;
  return loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, n)) / (Math.pow(1 + monthlyRate, n) - 1);
}

/* ONE TABLE - _shared/mi-factors.ts, for the MONTHLY factor. Upfront fees stay
   here: UFMIP / VA funding fee / USDA guarantee are one-time charges, not MI
   factors, and nothing else in the codebase computes them.

   NOTE: ltv here is a FRACTION (0.95), everywhere else it is a PERCENTAGE (95).
   Converted explicitly at the call rather than making the shared table guess.

   The FICO x LTV matrix this replaced was the most precise of the six, but it
   was also the only one that disagreed with every other surface, and credit
   score is not an input on the fee sheet or the loan summary — so keeping it
   would have meant one channel quoting a different premium from the document
   sent five minutes later. Precision lost, agreement gained, deliberately. */
function calcMI(program: string, loanAmount: number, ltv: number, fico: number) {
  const ltvPct = ltv <= 1 ? ltv * 100 : ltv;
  const monthly = monthlyMI({ product: program, ltv: ltvPct, loanAmount }) || 0;
  if (program === "fha")  return { monthly, upfront: loanAmount * 0.0175, type: "FHA MIP" };
  if (program === "va")   return { monthly: 0, upfront: loanAmount * 0.0215, type: "VA Funding Fee" };
  if (program === "usda") return { monthly, upfront: loanAmount * 0.01, type: "USDA Guarantee Fee" };
  if (monthly > 0) {
    const f = miFactor(program, ltvPct);
    return { monthly, upfront: 0, type: `Conv PMI (~${(f.rate * 100).toFixed(2)}%)` };
  }
  return { monthly: 0, upfront: 0, type: "None" };
}

function round(n: number, places = 0): number {
  const factor = Math.pow(10, places);
  return Math.round(n * factor) / factor;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method !== "POST") return err("Method not allowed", 405);

  try {
    const body = await req.json();
    const action = (body.action || "payment").toLowerCase();

    // ============================================================ payment
    if (action === "payment" || action === "monthly_payment") {
      const purchasePrice = parseFloat(body.purchase_price) || 0;
      const downPaymentPct = parseFloat(body.down_payment_pct) || (body.down_payment_amount ? null : 0.20);
      const downPaymentAmount = body.down_payment_amount ? parseFloat(body.down_payment_amount) : null;
      const program = (body.program || "conventional").toLowerCase();
      const fico = parseInt(body.fico) || 740;
      const termYears = parseInt(body.term_years) || 30;
      const county = (body.county || "orange").toLowerCase();
      const hoa = parseFloat(body.hoa_monthly) || 0;
      const customRate = body.interest_rate ? parseFloat(body.interest_rate) : null;

      if (!purchasePrice || purchasePrice < 50000) return err("purchase_price required (>= 50000)");

      const { rate, basis } = await resolveRate(program, customRate);
      const dpAmount = downPaymentAmount !== null ? downPaymentAmount : purchasePrice * (downPaymentPct as number);
      const dpPct = dpAmount / purchasePrice;
      const baseLoan = purchasePrice - dpAmount;
      const ltv = baseLoan / purchasePrice;
      const mi = calcMI(program, baseLoan, ltv, fico);
      const totalLoan = baseLoan + mi.upfront;
      const pi = calcPI(totalLoan, rate, termYears);
      const taxRate = COUNTY_TAX_RATES[county] || DEFAULT_TAX_RATE;
      const monthlyTax = (purchasePrice * taxRate) / 12;
      const monthlyIns = (purchasePrice * DEFAULT_INSURANCE_RATE) / 12;
      const recalcMI = calcMI(program, totalLoan, ltv, fico);
      const monthlyMI = recalcMI.monthly;
      const piti = pi + monthlyTax + monthlyIns + monthlyMI + hoa;

      return ok({
        success: true,
        inputs: {
          purchase_price: purchasePrice, program, fico, term_years: termYears, county,
          down_payment_amount: round(dpAmount), down_payment_pct: round(dpPct * 100, 2),
          interest_rate_used: round(rate * 100, 3), rate_basis: basis,
        },
        loan: {
          base_loan: round(baseLoan), upfront_mi_financed: round(mi.upfront),
          total_loan: round(totalLoan), ltv: round(ltv * 100, 2),
        },
        monthly: {
          principal_interest: round(pi), property_tax: round(monthlyTax),
          homeowners_insurance: round(monthlyIns), mortgage_insurance: round(monthlyMI),
          mortgage_insurance_type: recalcMI.type, hoa: round(hoa), total_piti: round(piti),
        },
        cash_to_close_estimate: {
          down_payment: round(dpAmount), closing_costs_estimate: round(purchasePrice * 0.025),
          total: round(dpAmount + purchasePrice * 0.025),
          note: "Closing costs estimate ~2.5% of purchase price. Seller credits or lender credits can reduce this.",
        },
        disclaimer: `Estimate using ${program.toUpperCase()} at ${(rate * 100).toFixed(3)}% (illustrative \u2014 NOT a quote). Real rate depends on FICO, LTV, loan size, lock period, market conditions. Tax rate ${county} county at ${(taxRate * 100).toFixed(3)}%.`,
      });
    }

    // ============================================================ affordability
    if (action === "affordability" || action === "max_purchase") {
      const grossMonthlyIncome = parseFloat(body.monthly_income) || 0;
      const monthlyDebts = parseFloat(body.monthly_debts) || 0;
      const program = (body.program || "conventional").toLowerCase();
      const fico = parseInt(body.fico) || 740;
      const downPaymentPct = parseFloat(body.down_payment_pct) || (program === "fha" ? 0.035 : program === "va" ? 0 : program === "usda" ? 0 : 0.05);
      const termYears = parseInt(body.term_years) || 30;
      const county = (body.county || "orange").toLowerCase();
      const hoa = parseFloat(body.hoa_monthly) || 0;
      const customRate = body.interest_rate ? parseFloat(body.interest_rate) : null;

      if (!grossMonthlyIncome || grossMonthlyIncome < 1000) return err("monthly_income required");
      const { rate, basis } = await resolveRate(program, customRate);
      const dtiCap = PROGRAM_DEFAULTS[program]?.dti_max || 0.50;
      const taxRate = COUNTY_TAX_RATES[county] || DEFAULT_TAX_RATE;
      const maxPITI = grossMonthlyIncome * dtiCap - monthlyDebts;
      if (maxPITI <= 0) {
        return ok({ success: true, max_purchase_price: 0, reason: "existing debts exceed DTI cap" });
      }
      let lo = 50000, hi = 5000000;
      for (let i = 0; i < 40; i++) {
        const guess = (lo + hi) / 2;
        const dp = guess * downPaymentPct;
        const baseLoan = guess - dp;
        const ltv = baseLoan / guess;
        const mi = calcMI(program, baseLoan, ltv, fico);
        const totalLoan = baseLoan + mi.upfront;
        const pi = calcPI(totalLoan, rate, termYears);
        const tax = (guess * taxRate) / 12;
        const ins = (guess * DEFAULT_INSURANCE_RATE) / 12;
        const recalcMI = calcMI(program, totalLoan, ltv, fico);
        const piti = pi + tax + ins + recalcMI.monthly + hoa;
        if (piti < maxPITI) lo = guess; else hi = guess;
      }
      const maxPrice = round((lo + hi) / 2);
      const dp = maxPrice * downPaymentPct;
      return ok({
        success: true, max_purchase_price: maxPrice,
        down_payment_required: round(dp),
        cash_to_close_estimate: round(dp + maxPrice * 0.025),
        max_piti: round(maxPITI),
        inputs: { gross_monthly_income: grossMonthlyIncome, monthly_debts: monthlyDebts, program, fico, county, down_payment_pct: round(downPaymentPct * 100, 2), interest_rate_used: round(rate * 100, 3), rate_basis: basis },
        disclaimer: `Estimate at ${program.toUpperCase()} ${(rate * 100).toFixed(3)}% (illustrative). Final pre-approval depends on full income docs, employment, reserves, credit pull.`,
      });
    }

    // ============================================================ compare
    if (action === "compare") {
      const purchasePrice = parseFloat(body.purchase_price) || 0;
      const fico = parseInt(body.fico) || 740;
      const county = (body.county || "orange").toLowerCase();
      const programs = body.programs || ["conventional", "fha"];
      if (!purchasePrice) return err("purchase_price required");
      const results: any = {};
      for (const p of programs) {
        const program = p.toLowerCase();
        const { rate } = await resolveRate(program, null);
        const dpPct = program === "fha" ? 0.035 : program === "va" || program === "usda" ? 0 : 0.05;
        const dp = purchasePrice * dpPct;
        const baseLoan = purchasePrice - dp;
        const ltv = baseLoan / purchasePrice;
        const mi = calcMI(program, baseLoan, ltv, fico);
        const totalLoan = baseLoan + mi.upfront;
        const pi = calcPI(totalLoan, rate, 30);
        const tax = (purchasePrice * (COUNTY_TAX_RATES[county] || DEFAULT_TAX_RATE)) / 12;
        const ins = (purchasePrice * DEFAULT_INSURANCE_RATE) / 12;
        const recalcMI = calcMI(program, totalLoan, ltv, fico);
        results[program] = {
          down_payment: round(dp), base_loan: round(baseLoan), upfront_mi: round(mi.upfront),
          total_loan: round(totalLoan), rate_estimate: round(rate * 100, 3),
          monthly_pi: round(pi), monthly_mi: round(recalcMI.monthly),
          monthly_taxes: round(tax), monthly_insurance: round(ins),
          monthly_total: round(pi + tax + ins + recalcMI.monthly),
          cash_to_close_estimate: round(dp + purchasePrice * 0.025),
        };
      }
      return ok({ success: true, purchase_price: purchasePrice, comparison: results });
    }

    // ============================================================ rent_vs_buy
    if (action === "rent_vs_buy") {
      const monthlyRent = parseFloat(body.monthly_rent) || 0;
      const purchasePrice = parseFloat(body.purchase_price) || 0;
      const yearsHorizon = parseInt(body.years_horizon) || 5;
      const annualAppreciation = parseFloat(body.annual_appreciation) || 0.04;
      const annualRentIncrease = parseFloat(body.annual_rent_increase) || 0.04;
      const program = (body.program || "conventional").toLowerCase();
      const downPaymentPct = parseFloat(body.down_payment_pct) || (program === "fha" ? 0.035 : 0.10);
      const fico = parseInt(body.fico) || 740;
      const county = (body.county || "orange").toLowerCase();

      if (!monthlyRent || !purchasePrice) return err("monthly_rent and purchase_price both required");

      const { rate } = await resolveRate(program, body.interest_rate ? parseFloat(body.interest_rate) : null);
      const dp = purchasePrice * downPaymentPct;
      const baseLoan = purchasePrice - dp;
      const ltv = baseLoan / purchasePrice;
      const mi = calcMI(program, baseLoan, ltv, fico);
      const totalLoan = baseLoan + mi.upfront;
      const pi = calcPI(totalLoan, rate, 30);
      const tax = (purchasePrice * (COUNTY_TAX_RATES[county] || DEFAULT_TAX_RATE)) / 12;
      const ins = (purchasePrice * DEFAULT_INSURANCE_RATE) / 12;
      const recalcMI = calcMI(program, totalLoan, ltv, fico);
      const piti = pi + tax + ins + recalcMI.monthly;

      // Project N years
      let totalRentSpent = 0;
      let totalBuyCash = dp + purchasePrice * 0.025;  // close costs
      for (let y = 0; y < yearsHorizon; y++) {
        const yearlyRent = monthlyRent * Math.pow(1 + annualRentIncrease, y) * 12;
        totalRentSpent += yearlyRent;
        totalBuyCash += piti * 12;
      }
      const futureHomeValue = purchasePrice * Math.pow(1 + annualAppreciation, yearsHorizon);
      // Approximate remaining loan balance after N years
      const monthlyRate = rate / 12;
      const n = 30 * 12;
      let balance = totalLoan;
      for (let m = 0; m < yearsHorizon * 12; m++) {
        const interest = balance * monthlyRate;
        const principal = pi - interest;
        balance -= principal;
      }
      const equityBuilt = futureHomeValue - balance;
      const sellingCosts = futureHomeValue * 0.07;  // commissions + closing
      const netFromSale = equityBuilt - sellingCosts;
      const buyNetCost = totalBuyCash - netFromSale;
      const breakeven = totalRentSpent < buyNetCost ? "renting cheaper" : "buying cheaper";
      const savings = Math.abs(totalRentSpent - buyNetCost);

      return ok({
        success: true,
        years_horizon: yearsHorizon,
        monthly_rent_now: round(monthlyRent),
        monthly_buy_piti: round(piti),
        monthly_difference: round(piti - monthlyRent),
        rent_total_paid: round(totalRentSpent),
        buy_total_outlay: round(totalBuyCash),
        buy_future_home_value: round(futureHomeValue),
        buy_remaining_loan: round(balance),
        buy_equity_built: round(equityBuilt),
        buy_net_cost_after_sale: round(buyNetCost),
        winner: breakeven,
        winner_savings_over_horizon: round(savings),
        assumptions: {
          rate: round(rate * 100, 3),
          annual_appreciation_pct: round(annualAppreciation * 100, 2),
          annual_rent_increase_pct: round(annualRentIncrease * 100, 2),
          selling_cost_pct: 7,
          closing_cost_pct: 2.5,
          program, county, fico, down_payment_pct: round(downPaymentPct * 100, 2),
        },
        disclaimer: `Rent vs buy is highly sensitive to appreciation rate. OC has averaged 5-7% historically but can swing. Tax benefits of ownership not included (would tilt further toward buying for itemizers).`,
      });
    }

    return err(`Unknown action: ${action}. Valid: payment, affordability, compare, rent_vs_buy`);
  } catch (e: any) {
    return err(e.message || String(e), 500);
  }
});
