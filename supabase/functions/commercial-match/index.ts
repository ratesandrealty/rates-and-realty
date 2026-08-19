import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// ─── SCORING WEIGHTS ───────────────────────────────────────────────────────
const WEIGHTS = {
  loan_product_match:   30,  // exact loan product match
  property_type_match:  25,  // exact property type match
  loan_amount_in_range: 15,  // loan amount within min/max
  dscr_meets_min:       10,  // borrower DSCR >= lender min
  credit_score_meets:   10,  // borrower credit >= lender min
  ltv_within_max:        5,  // LTV within lender max
  state_covered:         5,  // state in lender coverage
};
// Total possible: 100 points

interface DealInput {
  property_type_id?: string;
  property_type_name?: string;
  loan_product_id?: string;
  loan_product_name?: string;
  loan_amount: number;
  dscr?: number;
  credit_score?: number;
  occupancy_pct?: number;
  ltv?: number;
  state?: string;
  recourse_preference?: string;
  max_closing_days?: number;
  limit?: number;
}

interface MatchResult {
  lender_id: string;
  lender_name: string;
  score: number;
  max_score: number;
  fit_pct: number;
  speed_days: number | null;
  rate_tier: string | null;
  recourse_type: string | null;
  reasons: string[];
  disqualifiers: string[];
  profile: any;
}

async function matchLenders(deal: DealInput): Promise<MatchResult[]> {
  // Load all commercial lender profiles with lender data
  const { data: profiles, error } = await sb
    .from('commercial_lender_profiles')
    .select(`
      *,
      lenders (
        id, name, rating, is_preferred, contact_name, contact_email,
        contact_phone, lender_portal, website, channel, logo_url
      )
    `);

  if (error || !profiles) return [];

  const results: MatchResult[] = [];

  for (const profile of profiles) {
    const lender = profile.lenders;
    if (!lender) continue;

    let score = 0;
    const reasons: string[] = [];
    const disqualifiers: string[] = [];

    // ── HARD DISQUALIFIERS (automatic fail) ────────────────────────
    // Loan amount
    if (profile.min_loan_amount && deal.loan_amount < profile.min_loan_amount) {
      disqualifiers.push(`Loan amount $${deal.loan_amount.toLocaleString()} below minimum $${profile.min_loan_amount.toLocaleString()}`);
    }
    if (profile.max_loan_amount && deal.loan_amount > profile.max_loan_amount) {
      disqualifiers.push(`Loan amount $${deal.loan_amount.toLocaleString()} exceeds maximum $${profile.max_loan_amount.toLocaleString()}`);
    }
    // DSCR
    if (deal.dscr && profile.min_dscr && deal.dscr < profile.min_dscr) {
      disqualifiers.push(`DSCR ${deal.dscr} below minimum ${profile.min_dscr}`);
    }
    // Credit score
    if (deal.credit_score && profile.min_credit_score && deal.credit_score < profile.min_credit_score) {
      disqualifiers.push(`Credit score ${deal.credit_score} below minimum ${profile.min_credit_score}`);
    }
    // LTV
    if (deal.ltv && profile.max_ltv && deal.ltv > profile.max_ltv) {
      disqualifiers.push(`LTV ${deal.ltv}% exceeds maximum ${profile.max_ltv}%`);
    }
    // State
    if (deal.state && profile.states_covered?.length > 0) {
      if (!profile.states_covered.includes(deal.state) && !profile.states_covered.includes('All') && !profile.states_covered.includes('Nationwide')) {
        disqualifiers.push(`State ${deal.state} not in lender coverage`);
      }
    }
    // Closing speed
    if (deal.max_closing_days && profile.closing_speed_days && profile.closing_speed_days > deal.max_closing_days) {
      disqualifiers.push(`Closing speed ${profile.closing_speed_days} days exceeds required ${deal.max_closing_days} days`);
    }

    // Skip if any hard disqualifier
    if (disqualifiers.length > 0) {
      results.push({
        lender_id: lender.id,
        lender_name: lender.name,
        score: 0,
        max_score: 100,
        fit_pct: 0,
        speed_days: profile.closing_speed_days,
        rate_tier: profile.rate_tier,
        recourse_type: profile.recourse_type,
        reasons: [],
        disqualifiers,
        profile
      });
      continue;
    }

    // ── SCORING ────────────────────────────────────────────────────
    // Loan product match
    if (deal.loan_product_id && profile.supported_loan_product_ids?.includes(deal.loan_product_id)) {
      score += WEIGHTS.loan_product_match;
      reasons.push('✅ Supports requested loan product');
    } else if (deal.loan_product_id) {
      reasons.push('⚠️ Loan product not confirmed for this lender');
    }

    // Property type match
    if (deal.property_type_id && profile.supported_property_type_ids?.includes(deal.property_type_id)) {
      score += WEIGHTS.property_type_match;
      reasons.push('✅ Lends on this property type');
    } else if (deal.property_type_id) {
      reasons.push('⚠️ Property type not confirmed for this lender');
    }

    // Loan amount in range
    const minOk = !profile.min_loan_amount || deal.loan_amount >= profile.min_loan_amount;
    const maxOk = !profile.max_loan_amount || deal.loan_amount <= profile.max_loan_amount;
    if (minOk && maxOk) {
      score += WEIGHTS.loan_amount_in_range;
      reasons.push(`✅ Loan amount $${deal.loan_amount.toLocaleString()} within range`);
    }

    // DSCR
    if (!deal.dscr || !profile.min_dscr || deal.dscr >= profile.min_dscr) {
      score += WEIGHTS.dscr_meets_min;
      if (deal.dscr) reasons.push(`✅ DSCR ${deal.dscr} meets minimum ${profile.min_dscr || 'N/A'}`);
    }

    // Credit score
    if (!deal.credit_score || !profile.min_credit_score || deal.credit_score >= profile.min_credit_score) {
      score += WEIGHTS.credit_score_meets;
      if (deal.credit_score) reasons.push(`✅ Credit ${deal.credit_score} meets minimum ${profile.min_credit_score || 'N/A'}`);
    }

    // LTV
    if (!deal.ltv || !profile.max_ltv || deal.ltv <= profile.max_ltv) {
      score += WEIGHTS.ltv_within_max;
      if (deal.ltv) reasons.push(`✅ LTV ${deal.ltv}% within max ${profile.max_ltv || 'N/A'}%`);
    }

    // State
    if (!deal.state || !profile.states_covered?.length || 
        profile.states_covered.includes(deal.state) || 
        profile.states_covered.includes('All') || 
        profile.states_covered.includes('Nationwide')) {
      score += WEIGHTS.state_covered;
      if (deal.state) reasons.push(`✅ Lends in ${deal.state}`);
    }

    // Preferred lender bonus (+5 to score, not counted in max)
    if (lender.is_preferred) {
      score += 5;
      reasons.push('⭐ Preferred lender relationship');
    }

    results.push({
      lender_id: lender.id,
      lender_name: lender.name,
      score,
      max_score: 100,
      fit_pct: Math.min(Math.round((score / 100) * 100), 100),
      speed_days: profile.closing_speed_days,
      rate_tier: profile.rate_tier,
      recourse_type: profile.recourse_type,
      reasons,
      disqualifiers,
      profile: {
        ...profile,
        lender_name: lender.name,
        lender_portal: lender.lender_portal,
        contact_name: lender.contact_name,
        contact_email: lender.contact_email,
        contact_phone: lender.contact_phone,
        logo_url: lender.logo_url,
        is_preferred: lender.is_preferred,
        rating: lender.rating,
      }
    });
  }

  // Sort: qualified first by score desc, then speed, then rate tier priority
  const RATE_ORDER: Record<string, number> = { 'Agency': 1, 'Life Co': 2, 'Bank': 3, 'Debt Fund': 4, 'Bridge': 5, 'Hard Money': 6 };
  
  return results
    .filter(r => r.disqualifiers.length === 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aSpeed = a.speed_days ?? 999;
      const bSpeed = b.speed_days ?? 999;
      if (aSpeed !== bSpeed) return aSpeed - bSpeed;
      const aRate = RATE_ORDER[a.rate_tier || ''] ?? 99;
      const bRate = RATE_ORDER[b.rate_tier || ''] ?? 99;
      return aRate - bRate;
    })
    .slice(0, deal.limit || 20);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const url = new URL(req.url);

  // GET /commercial-match?action=loan_products|property_types|filters
  if (req.method === 'GET') {
    const action = url.searchParams.get('action');

    if (action === 'loan_products') {
      const { data } = await sb.from('loan_products').select('*').eq('is_active', true).order('category').order('name');
      return ok({ loan_products: data || [] });
    }

    if (action === 'property_types') {
      const { data } = await sb.from('property_types').select('*').eq('is_active', true).order('category').order('name');
      return ok({ property_types: data || [] });
    }

    if (action === 'filters') {
      const [lp, pt, profiles] = await Promise.all([
        sb.from('loan_products').select('id,name,category').eq('is_active', true).order('category').order('name'),
        sb.from('property_types').select('id,name,category').eq('is_active', true).order('category').order('name'),
        sb.from('commercial_lender_profiles').select('rate_tier,recourse_type,closing_speed_days,min_loan_amount,max_loan_amount').not('lender_id', 'is', null),
      ]);
      const rate_tiers = [...new Set((profiles.data||[]).map((p:any) => p.rate_tier).filter(Boolean))];
      const recourse_types = [...new Set((profiles.data||[]).map((p:any) => p.recourse_type).filter(Boolean))];
      const loan_amounts = (profiles.data||[]).reduce((acc:any, p:any) => ({
        min: Math.min(acc.min, p.min_loan_amount || Infinity),
        max: Math.max(acc.max, p.max_loan_amount || 0)
      }), { min: Infinity, max: 0 });
      return ok({ loan_products: lp.data, property_types: pt.data, rate_tiers, recourse_types, loan_amounts });
    }

    if (action === 'lenders') {
      // Filter commercial lenders by query params
      const loan_product_id = url.searchParams.get('loan_product_id');
      const property_type_id = url.searchParams.get('property_type_id');
      const min_loan = url.searchParams.get('min_loan');
      const max_loan = url.searchParams.get('max_loan');
      const min_dscr = url.searchParams.get('min_dscr');
      const recourse = url.searchParams.get('recourse');
      const rate_tier = url.searchParams.get('rate_tier');
      const max_speed = url.searchParams.get('max_speed');
      const state = url.searchParams.get('state');

      let query = sb.from('commercial_lender_profiles').select(`
        *, lenders (id, name, rating, is_preferred, contact_name, contact_email, lender_portal, logo_url)
      `);

      if (loan_product_id) query = query.contains('supported_loan_product_ids', [loan_product_id]);
      if (property_type_id) query = query.contains('supported_property_type_ids', [property_type_id]);
      if (min_loan) query = query.gte('max_loan_amount', parseFloat(min_loan));
      if (max_loan) query = query.lte('min_loan_amount', parseFloat(max_loan));
      if (min_dscr) query = query.lte('min_dscr', parseFloat(min_dscr));
      if (recourse) query = query.or(`recourse_type.eq.${recourse},recourse_type.eq.Both`);
      if (rate_tier) query = query.eq('rate_tier', rate_tier);
      if (max_speed) query = query.lte('closing_speed_days', parseInt(max_speed));
      if (state) query = query.or(`states_covered.cs.{${state}},states_covered.cs.{All},states_covered.cs.{Nationwide}`);

      const { data, error } = await query;
      if (error) return err(error.message);
      return ok({ lenders: data || [], count: data?.length || 0 });
    }

    return err('Use action: loan_products | property_types | filters | lenders');
  }

  // POST /commercial-match — run matching algorithm
  if (req.method === 'POST') {
    const body = await req.json();
    const { action } = body;

    // Match deals to lenders
    if (action === 'match' || !action) {
      const deal: DealInput = body.deal || body;
      if (!deal.loan_amount) return err('loan_amount is required');

      const matches = await matchLenders(deal);

      // Optionally save match results
      if (body.save && body.contact_id) {
        await sb.from('commercial_deal_matches').insert({
          contact_id: body.contact_id,
          application_id: body.application_id,
          property_type_id: deal.property_type_id,
          loan_amount: deal.loan_amount,
          dscr: deal.dscr,
          credit_score: deal.credit_score,
          occupancy_pct: deal.occupancy_pct,
          ltv: deal.ltv,
          state: deal.state,
          loan_product_id: deal.loan_product_id,
          match_results: matches.map(m => ({ lender_id: m.lender_id, score: m.score, fit_pct: m.fit_pct, reasons: m.reasons }))
        });
      }

      return ok({
        success: true,
        deal,
        total_matches: matches.length,
        matches: matches.map(m => ({
          lender_id: m.lender_id,
          lender_name: m.lender_name,
          score: m.score,
          fit_pct: m.fit_pct,
          speed_days: m.speed_days,
          rate_tier: m.rate_tier,
          recourse_type: m.recourse_type,
          reasons: m.reasons,
          contact_name: m.profile.contact_name,
          contact_email: m.profile.contact_email,
          contact_phone: m.profile.contact_phone,
          lender_portal: m.profile.lender_portal,
          logo_url: m.profile.logo_url,
          is_preferred: m.profile.is_preferred,
          rating: m.profile.rating,
          min_loan_amount: m.profile.min_loan_amount,
          max_loan_amount: m.profile.max_loan_amount,
          min_dscr: m.profile.min_dscr,
          max_ltv: m.profile.max_ltv,
        }))
      });
    }

    // Upsert a commercial lender profile
    if (action === 'upsert_profile') {
      const { lender_id, ...profile } = body.profile;
      if (!lender_id) return err('lender_id required');
      const { data, error } = await sb.from('commercial_lender_profiles')
        .upsert({ lender_id, ...profile, updated_at: new Date().toISOString() }, { onConflict: 'lender_id' })
        .select().single();
      if (error) return err(error.message);
      // Mark lender as commercial
      await sb.from('lenders').update({ is_commercial: true }).eq('id', lender_id);
      return ok({ success: true, profile: data });
    }

    return err('Use action: match | upsert_profile');
  }

  return err('Method not allowed', 405);
});
