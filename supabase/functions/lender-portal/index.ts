import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

async function logSubmission(lender_id: string, data: any, source: string) {
  try {
    await sb.from('lender_submissions').insert({
      lender_id,
      submitted_at: new Date().toISOString(),
      submission_data: data,
      source
    });
  } catch(e) {
    console.log('[lender-portal] submission log failed (non-fatal):', e);
  }
}

const ALLOWED_FIELDS = [
  'rep_name','rep_phone','rep_email','company_email','nmlsr_id',
  'contact_name','contact_email','contact_phone',
  'website','lender_portal','price_engine_url',
  'loan_types','loan_programs','programs',
  'min_credit','min_credit_score','max_ltv','min_loan_amount','max_loan_amount',
  'channel','states_licensed','specialty_notes','price_sheet_notes',
  'avg_app_to_fund','logo_url',
  'revenue_notes','fee_notes','epo_policy','broker_id',
  'cpl_clause','mortgagee_clause',
  'physical_address','physical_city','physical_state','physical_zip',
  'product_specialist_name','product_specialist_phone','product_specialist_email',
  'lock_desk_email','lock_desk_phone',
  'conditions_email','underwriting_email','closing_email','funding_email','submission_email',
  'min_days_to_close','max_days_to_close','underwriting_turn_time',
  'submission_checklist','guidelines_url','rate_sheet_link',
  'compensation_type','compensation_bps','compensation_min','compensation_max',
  'exception_process','key_overlays','appraisal_management',
  'appraisal_desk_review','escrow_waiver_allowed','non_warrantable_condo',
  'manufactured_home','rural_properties','down_to_500_credit',
  'recent_bk_ok','recent_foreclosure_ok','itin_ok','dba_ok',
  'last_submission_notes','notes'
];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const ok  = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const url = new URL(req.url);
    const urlToken = url.searchParams.get('token');
    const urlId    = url.searchParams.get('id');

    // ── GET ─────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (urlToken) {
        const { data, error } = await sb.from('lenders').select('*').eq('form_token', urlToken).single();
        if (error || !data) return err('Invalid or expired link', 404);
        return ok({ lender: data });
      }
      if (urlId) {
        const { data, error } = await sb.from('lenders').select('*').eq('id', urlId).single();
        if (error || !data) return err('Lender not found', 404);
        if (!data.form_token) {
          const newToken = generateToken();
          await sb.from('lenders').update({ form_token: newToken }).eq('id', urlId);
          data.form_token = newToken;
        }
        const { data: subs } = await sb.from('lender_submissions')
          .select('*').eq('lender_id', urlId)
          .order('submitted_at', { ascending: false }).limit(10);
        return ok({ lender: { ...data, form_url: `https://beta.ratesandrealty.com/public/lender-form.html?token=${data.form_token}` }, submissions: subs || [] });
      }
      return err('token or id required');
    }

    // ── POST ────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      let body: any = {};
      try {
        const text = await req.text();
        if (text && text.trim().startsWith('{')) body = JSON.parse(text);
      } catch(_) {}

      const action   = body.action;
      const lenderId = body.id || body.lender_id;
      const token    = urlToken || body.token;

      // ── action: get ──────────────────────────────────────────────────────────
      if (action === 'get' && token) {
        const { data, error } = await sb.from('lenders').select('*').eq('form_token', token).single();
        if (error || !data) return err('Invalid or expired link', 404);
        return ok({ success: true, lender: data });
      }

      // ── ensure_tokens ────────────────────────────────────────────────────
      if (action === 'ensure_tokens') {
        const { data: lenders } = await sb.from('lenders').select('id,name,form_token').is('form_token', null);
        let generated = 0;
        for (const l of (lenders || [])) {
          await sb.from('lenders').update({ form_token: generateToken() }).eq('id', l.id);
          generated++;
        }
        const { data: all } = await sb.from('lenders').select('id,name,form_token').order('name');
        return ok({ success: true, generated, total: all?.length || 0 });
      }

      // ── generate_token ───────────────────────────────────────────────────
      if (action === 'generate_token' && lenderId) {
        const newToken = generateToken();
        await sb.from('lenders').update({ form_token: newToken }).eq('id', lenderId);
        return ok({ success: true, form_token: newToken, form_url: `https://beta.ratesandrealty.com/public/lender-form.html?token=${newToken}` });
      }

      // ── upload_logo ──────────────────────────────────────────────────────
      if (action === 'upload_logo' && lenderId && body.logo_base64) {
        const mime = body.logo_mime || 'image/png';
        const ext  = body.logo_ext  || 'png';
        const fileName = `${lenderId}.${ext}`;
        const binary = Uint8Array.from(atob(body.logo_base64), c => c.charCodeAt(0));
        await sb.storage.from('lender-logos').remove([fileName]);
        const { error: upErr } = await sb.storage.from('lender-logos').upload(fileName, binary, { contentType: mime, upsert: true });
        if (upErr) return err('Logo upload failed: ' + upErr.message, 500);
        const { data: urlData } = sb.storage.from('lender-logos').getPublicUrl(fileName);
        const publicUrl = urlData.publicUrl + '?t=' + Date.now();
        await sb.from('lenders').update({ logo_url: publicUrl, updated_at: new Date().toISOString() }).eq('id', lenderId);
        return ok({ success: true, logo_url: publicUrl });
      }

      // ── update (CRM internal by lender ID) ─────────────────────────────────
      if (action === 'update' && lenderId && !token) {
        const safe: Record<string,any> = { updated_at: new Date().toISOString() };
        const extra = ['rating','is_preferred','is_favorite','scenario_notes','last_submission_notes',
          'logo_url','loan_types','loan_programs','key_overlays','specialty_notes','notes',
          'name','lender_type','status','priority','states_licensed'];
        [...ALLOWED_FIELDS, ...extra].forEach(k => { if (body[k] !== undefined) safe[k] = body[k]; });
        const { error } = await sb.from('lenders').update(safe).eq('id', lenderId);
        if (error) return err(error.message, 500);
        const { data: updated } = await sb.from('lenders').select('*').eq('id', lenderId).single();
        return ok({ success: true, lender: updated, form_url: updated?.form_token ? `https://beta.ratesandrealty.com/public/lender-form.html?token=${updated.form_token}` : null });
      }

      // ── update from lender-form.html (token + nested updates object) ─────────
      if (action === 'update' && token && body.updates) {
        const { data: lender, error: lErr } = await sb.from('lenders').select('id,name,form_token').eq('form_token', token).single();
        if (lErr || !lender) return err('Invalid or expired link', 404);
        const safe: Record<string,any> = { updated_at: new Date().toISOString() };
        const updates = body.updates;
        ALLOWED_FIELDS.forEach(k => { if (updates[k] !== undefined) safe[k] = updates[k]; });
        const { error: uErr } = await sb.from('lenders').update(safe).eq('id', lender.id);
        if (uErr) return err(uErr.message, 500);
        await logSubmission(lender.id, safe, 'public_form');
        return ok({ success: true, message: 'Thank you! Your information has been saved successfully.' });
      }

      // ── Public token-based submission (flat fields in body) ──────────────────
      if (token) {
        const { data: lender, error: lErr } = await sb.from('lenders').select('id,name,form_token').eq('form_token', token).single();
        if (lErr || !lender) return err('Invalid or expired link', 404);
        const hasUpdates = Object.keys(body).some(k => k !== 'token' && k !== 'action' && ALLOWED_FIELDS.includes(k));
        if (!hasUpdates) {
          const { data: full } = await sb.from('lenders').select('*').eq('id', lender.id).single();
          return ok({ success: true, lender: full });
        }
        const safe: Record<string,any> = { updated_at: new Date().toISOString() };
        ALLOWED_FIELDS.forEach(k => { if (body[k] !== undefined) safe[k] = body[k]; });
        const { error: uErr } = await sb.from('lenders').update(safe).eq('id', lender.id);
        if (uErr) return err(uErr.message, 500);
        await logSubmission(lender.id, safe, 'public_form');
        return ok({ success: true, message: 'Thank you! Your information has been saved successfully.' });
      }

      return err('action, id, or token required');
    }

    return err('Method not allowed', 405);

  } catch(e: any) {
    console.error('[lender-portal] error:', e);
    return new Response(JSON.stringify({ error: e.message || 'Server error' }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
});
