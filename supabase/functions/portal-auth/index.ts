// portal-auth v55 — Turnstile on login/signup (admin signups exempt) + admin_impersonate via GoTrue session (legacy static token deprecated).
// Note: this entire portal_users system is being replaced by Supabase Auth in upcoming work.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info' };
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MS_KEY = Deno.env.get('MAILERSEND_API_KEY');
const sb = createClient(SB_URL, SB_KEY);

/* Cloudflare Turnstile bot protection on the BORROWER-FACING login.
 *
 * This used to read `if (!TURNSTILE_SECRET) return true` — a bot check that
 * reported PASSED when it had not run. TURNSTILE_SECRET_KEY is in fact set
 * (digest 4078a665…, 2026-06-13), verified from the deployed secret list rather
 * than by throwing a login at the endpoint, so the branch never fired and the
 * portal has been protected throughout. The shape was still wrong.
 *
 * THREE OUTCOMES, NOT TWO — the same rule this repo already applies to health
 * checks: passed, failed, and COULD NOT RUN. The third must never read as the
 * first. It now fails CLOSED and says which of the three it was.
 *
 * The distinction is not pedantry, it decides what the caller is told. An
 * unconfigured secret rendered as "Verification failed. Please refresh and try
 * again." would send a borrower to retry something that cannot succeed, while
 * the real fault — a missing secret — appears nowhere. So `unconfigured`
 * returns 503 with its own message and a console.error, and only a genuine
 * Turnstile rejection returns 403. */
const TURNSTILE_SECRET = Deno.env.get('TURNSTILE_SECRET_KEY');
type TurnstileResult = { ok: boolean; unconfigured?: boolean };
async function verifyTurnstile(token: string | undefined, ip: string | null): Promise<TurnstileResult> {
  if (!TURNSTILE_SECRET) {
    console.error('[portal-auth] TURNSTILE_SECRET_KEY is not set — REFUSING. Bot protection cannot run; this is a configuration fault, not a failed challenge.');
    return { ok: false, unconfigured: true };
  }
  if (!token) return { ok: false };
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: ip || '' })
    });
    const d = await r.json();
    return { ok: !!d.success };
  } catch { return { ok: false }; }
}

// Admin exemption: a valid GoTrue session (only admins have these) bypasses Turnstile / authorizes admin actions.
async function verifyAdminJwt(jwt: string | undefined): Promise<boolean> {
  if (!jwt) return false;
  try {
    const { data, error } = await sb.auth.getUser(jwt);
    return !!(data && data.user) && !error;
  } catch { return false; }
}

async function hashPassword(p: string) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return btoa(JSON.stringify({ salt: Array.from(salt), hash: Array.from(new Uint8Array(bits)) }));
}
async function verifyPassword(p: string, stored: string) {
  try {
    const { salt, hash } = JSON.parse(atob(stored));
    const enc = new TextEncoder();
    const km = await crypto.subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new Uint8Array(salt), iterations: 100000, hash: 'SHA-256' }, km,256);
    return JSON.stringify(Array.from(new Uint8Array(bits))) === JSON.stringify(hash);
  } catch { return false; }
}
function genToken(len = 32) { return Array.from(crypto.getRandomValues(new Uint8Array(len))).map(b => b.toString(16).padStart(2, '0')).join(''); }
function genTempPw() { const c = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; return Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => c[b % c.length]).join(''); }

async function sendEmail(to: string, toName: string, subject: string, html: string): Promise<{ sent: boolean; error?: string }> {
  if (!MS_KEY) return { sent: false, error: 'MAILERSEND_API_KEY not set' };
  try {
    const res = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${MS_KEY}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ from: { email: 'rene@ratesandrealty.com', name: 'Rene Duarte | Rates & Realty' }, to: [{ email: to, name: toName }], subject, html })
    });
    const txt = await res.text();
    console.log('MailerSend response:', res.status, txt.substring(0,200));
    return { sent: res.ok, error: res.ok ? undefined : txt };
  } catch (e: any) { return { sent: false, error: e.message }; }
}

function buildWelcomeEmail(firstName: string, email: string, tempPw: string, crmId: string, portalUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome to Rates &amp; Realty</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a0a;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
<div style="display:none;font-size:1px;color:#0a0a0a;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">Your personalized mortgage portal is ready, ${firstName}. Here are your login details.</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;min-height:100vh">
<tr><td align="center" style="padding:32px 16px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px">
  <tr><td style="background:#1a1408;border-radius:14px 14px 0 0;padding:28px 36px;border-bottom:2px solid #C9A84C">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td><div style="font-size:1.4rem;font-weight:800;color:#C9A84C;letter-spacing:-.02em">Rates &amp; Realty</div><div style="font-size:.7rem;color:#888;text-transform:uppercase;letter-spacing:.15em;margin-top:2px">AI-Powered Mortgage</div></td>
        <td align="right"><div style="background:#C9A84C;color:#000;font-size:.68rem;font-weight:800;padding:5px 12px;border-radius:20px;text-transform:uppercase;letter-spacing:.08em">Portal Ready</div></td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="background:#111111;padding:40px 36px 28px">
    <div style="font-size:.8rem;color:#C9A84C;font-weight:700;text-transform:uppercase;letter-spacing:.12em;margin-bottom:12px">Welcome aboard</div>
    <h1 style="margin:0 0 14px;font-size:2rem;font-weight:800;color:#ffffff;line-height:1.15">Hey ${firstName},<br>your home buying<br><span style="color:#C9A84C">journey starts now.</span></h1>
    <p style="margin:0 0 28px;font-size:.92rem;color:#999;line-height:1.75">I set up your personal borrower portal so we can stay connected through every step of your mortgage process.</p>
    <a href="${portalUrl}" style="display:inline-block;background:#C9A84C;color:#000000;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:800;font-size:.95rem">Open My Portal &rarr;</a>
  </td></tr>
  <tr><td style="background:#111111;padding:0 36px 32px">
    <div style="background:#16120a;border:1px solid #3a2e10;border-radius:12px;padding:22px 24px">
      <div style="font-size:.68rem;font-weight:800;color:#C9A84C;text-transform:uppercase;letter-spacing:.1em;margin-bottom:14px">Your Login Details</div>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:6px 0;border-bottom:1px solid #2a2a2a"><span style="font-size:.75rem;color:#666;display:inline-block;width:90px">Email</span><span style="font-size:.82rem;color:#ddd;font-weight:600">${email}</span></td></tr>
        <tr><td style="padding:6px 0;border-bottom:1px solid #2a2a2a"><span style="font-size:.75rem;color:#666;display:inline-block;width:90px">Password</span><span style="font-size:.88rem;color:#C9A84C;font-weight:800;font-family:Courier,monospace;background:#2a1f05;padding:3px 10px;border-radius:5px">${tempPw}</span></td></tr>
        <tr><td style="padding:6px 0"><span style="font-size:.75rem;color:#666;display:inline-block;width:90px">Your ID</span><span style="font-size:.88rem;color:#C9A84C;font-weight:800;font-family:Courier,monospace;background:#2a1f05;padding:3px 10px;border-radius:5px">${crmId}</span></td></tr>
      </table>
    </div>
  </td></tr>
  <tr><td style="background:#0d0d0d;padding:22px 36px;border-top:1px solid #1a1a1a">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right:14px;vertical-align:top"><div style="width:44px;height:44px;background:#C9A84C;border-radius:50%;text-align:center;line-height:44px;font-weight:800;font-size:1rem;color:#000">RD</div></td>
      <td style="vertical-align:top">
        <div style="font-size:.85rem;font-weight:700;color:#eee">Rene Duarte</div>
        <div style="font-size:.72rem;color:#666">Mortgage Loan Officer &bull; NMLS #1795044</div>
        <div style="margin-top:6px"><a href="tel:7144728508" style="font-size:.72rem;color:#C9A84C;text-decoration:none">(714) 472-8508</a> &bull; <a href="mailto:rene@ratesandrealty.com" style="font-size:.72rem;color:#C9A84C;text-decoration:none">rene@ratesandrealty.com</a></div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#080808;padding:16px 36px;border-radius:0 0 14px 14px;border-top:1px solid #131313">
    <p style="margin:0;font-size:.65rem;color:#333;text-align:center">&copy; 2026 Rates &amp; Realty &bull; NMLS #1795044 &bull; Equal Housing Lender</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildPasswordResetEmail(firstName: string, email: string, newPw: string, borrowerId: string, portalUrl: string, adminOverride: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Password Reset</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a">
<tr><td align="center" style="padding:32px 16px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px">
  <tr><td style="background:#1a1408;border-radius:14px 14px 0 0;padding:24px 32px;border-bottom:2px solid #C9A84C">
    <div style="font-size:1.2rem;font-weight:800;color:#C9A84C">Rates &amp; Realty</div>
    <div style="font-size:.65rem;color:#666;text-transform:uppercase;letter-spacing:.12em;margin-top:2px">AI-Powered Mortgage</div>
  </td></tr>
  <tr><td style="background:#111;padding:36px 32px 24px">
    <h2 style="margin:0 0 10px;font-size:1.4rem;font-weight:800;color:#fff">Password Reset</h2>
    <p style="margin:0 0 24px;font-size:.88rem;color:#999;line-height:1.75">${adminOverride ? 'Hi ' + firstName + ', Rene has reset your portal password.' : 'Hi ' + firstName + ', your password reset was successful.'}</p>
    <div style="background:#16120a;border:1px solid #3a2e10;border-radius:10px;padding:20px;margin-bottom:24px">
      <div style="font-size:.68rem;font-weight:800;color:#C9A84C;text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px">Your New Credentials</div>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:5px 0;border-bottom:1px solid #2a2a2a"><span style="font-size:.74rem;color:#666;display:inline-block;width:80px">Email</span><span style="font-size:.82rem;color:#ddd">${email}</span></td></tr>
        <tr><td style="padding:5px 0"><span style="font-size:.74rem;color:#666;display:inline-block;width:80px">New Password</span><span style="font-size:.9rem;color:#C9A84C;font-weight:800;font-family:Courier,monospace;background:#2a1f05;padding:3px 10px;border-radius:5px">${newPw}</span></td></tr>
      </table>
    </div>
    <a href="${portalUrl}" style="display:block;text-align:center;background:#C9A84C;color:#000;text-decoration:none;padding:14px;border-radius:10px;font-weight:800;font-size:.92rem">Sign In to My Portal &rarr;</a>
    <p style="margin:16px 0 0;font-size:.75rem;color:#555;text-align:center">Your ID: <strong style="color:#888;font-family:monospace">${borrowerId}</strong></p>
  </td></tr>
  <tr><td style="background:#0d0d0d;padding:18px 32px;border-top:1px solid #1a1a1a">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right:12px"><div style="width:36px;height:36px;background:#C9A84C;border-radius:50%;text-align:center;line-height:36px;font-weight:800;color:#000;font-size:.85rem">RD</div></td>
      <td><div style="font-size:.8rem;font-weight:700;color:#eee">Rene Duarte &bull; NMLS #1795044</div><div style="font-size:.7rem;color:#666"><a href="tel:7144728508" style="color:#C9A84C;text-decoration:none">(714) 472-8508</a> &bull; <a href="mailto:rene@ratesandrealty.com" style="color:#C9A84C;text-decoration:none">rene@ratesandrealty.com</a></div></td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#080808;padding:14px 32px;border-radius:0 0 14px 14px;border-top:1px solid #131313">
    <p style="margin:0;font-size:.63rem;color:#333;text-align:center">&copy; 2026 Rates &amp; Realty &bull; NMLS #1795044 &bull; Equal Housing Lender</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

async function logActivity(p: { contact_id?: string | null; portal_user_id?: string | null; crm_id?: string | null; type: string; channel: string; title: string; description?: string; status?: string; email_subject?: string; email_html?: string; email_to?: string; sms_body?: string; sms_to?: string; metadata?: any; }) {
  try {
    await sb.from('activity_events').insert({
      contact_id: p.contact_id || null, portal_user_id: p.portal_user_id || null, crm_id: p.crm_id || null,
      type: p.type, channel: p.channel, title: p.title, description: p.description || null,
      status: p.status || 'sent', email_subject: p.email_subject || null, email_html: p.email_html || null,
      email_to: p.email_to || null, email_from: 'rene@ratesandrealty.com',
      sms_body: p.sms_body || null, sms_to: p.sms_to || null,
      metadata: p.metadata ? JSON.stringify(p.metadata) : null, created_at: new Date().toISOString()
    });
  } catch (e) { console.error('logActivity:', e); }
}

async function safeUpsertContact(p: { email?: string; phone?: string; first_name?: string; last_name?: string; source?: string; portal_user_id?: string; borrower_id?: string; }) {
  try {
    const { data, error } = await sb.rpc('upsert_contact_safe', { p_email: p.email || null, p_phone: p.phone || null, p_first_name: p.first_name || null, p_last_name: p.last_name || null, p_source: p.source || null, p_portal_user_id: p.portal_user_id || null, p_borrower_id: p.borrower_id || null });
    if (error) throw error;
    return data;
  } catch (e) { console.error('safeUpsertContact:', e); return null; }
}

const respond = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

/* Keeps both Turnstile call sites to one line while keeping "failed" and
 * "could not run" distinguishable to the caller. 503 is deliberate: the fault
 * is ours, and it must not read to a borrower as something a refresh fixes. */
const turnstileRefusal = (t: TurnstileResult) => t.unconfigured
  ? respond({ error: 'Sign-in is temporarily unavailable. Please try again shortly.', code: 'VERIFICATION_UNAVAILABLE' }, 503)
  : respond({ error: 'Verification failed. Please refresh and try again.' }, 403);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const body = await req.json();
    const { action } = body;

    if (action === 'admin_verify') {
      const { token } = body;
      if (!token) return respond({ error: 'Token required' }, 400);
      const { data: at } = await sb.from('admin_tokens').select('admin_email,expires_at,is_active').eq('token', token).single();
      if (!at || !at.is_active || new Date(at.expires_at) < new Date()) return respond({ error: 'Invalid or expired token' }, 401);
      return respond({ valid: true, admin_email: at.admin_email });
    }

    if (action === 'admin_impersonate') {
      const { token, portal_user_id, borrower_id, email } = body;
      let _imp_authed = await verifyAdminJwt(body.admin_jwt);
      if (!_imp_authed && token) {
        const { data: at } = await sb.from('admin_tokens').select('is_active,expires_at').eq('token', token).single();
        _imp_authed = !!at && at.is_active && new Date(at.expires_at) >= new Date();
      }
      if (!_imp_authed) return respond({ error: 'Admin authentication required' }, 401);
      let query = sb.from('portal_users').select('id,email,first_name,last_name,phone,borrower_id,created_at,last_login,source,contact_id');
      if (portal_user_id) query = query.eq('id', portal_user_id);
      else if (borrower_id) query = query.eq('borrower_id', borrower_id);
      else if (email) query = query.eq('email', email.toLowerCase().trim());
      else return respond({ error: 'portal_user_id, borrower_id, or email required' }, 400);
      const { data: user } = await query.single();
      if (!user) return respond({ error: 'User not found' }, 404);
      await logActivity({ contact_id: user.contact_id, portal_user_id: user.id, crm_id: user.borrower_id, type: 'portal', channel: 'portal', title: 'Admin Portal View', description: 'Rene viewed portal as ' + user.first_name + ' ' + user.last_name, status: 'success', metadata: { admin_action: 'impersonate' } });
      return respond({ success: true, user, admin_session: true });
    }

    if (action === 'signup') {
      /* Admin JWT still short-circuits and never reaches Turnstile — an admin
       * creating an account is exempt, exactly as before. */
      if (!(await verifyAdminJwt(body.admin_jwt))) {
        const t = await verifyTurnstile(body.turnstileToken, req.headers.get('cf-connecting-ip'));
        if (!t.ok) return turnstileRefusal(t);
      }
      const { email, first_name, last_name, phone, password } = body;
      if (!email || !first_name) return respond({ error: 'Email and first name required' }, 400);
      const ec = email.toLowerCase().trim();
      const { data: existing } = await sb.from('portal_users').select('id,email,borrower_id').eq('email', ec).single();
      if (existing) return respond({ error: 'Account already exists. Please sign in.', code: 'EXISTS' }, 409);
      const tempPw = password || genTempPw();
      const pwHash = await hashPassword(tempPw);
      const { data: user, error: createErr } = await sb.from('portal_users').insert({ email: ec, first_name: first_name.trim(), last_name: last_name?.trim() || '', phone: phone?.trim() || '', password_hash: pwHash, temp_password: password ? null : tempPw, verification_token: genToken(), source: body.source || 'search_portal' }).select().single();
      if (createErr) throw createErr;
      const contactId = await safeUpsertContact({ email: ec, phone: phone?.trim(), first_name: first_name.trim(), last_name: last_name?.trim() || '', source: 'portal_signup', portal_user_id: user.id, borrower_id: user.borrower_id });
      if (contactId) await sb.from('portal_users').update({ contact_id: contactId }).eq('id', user.id);
      let crmId = user.borrower_id;
      if (contactId) { const { data: c } = await sb.from('contacts').select('crm_id').eq('id', contactId).single(); if (c?.crm_id) crmId = c.crm_id; }
      const portalUrl = 'https://beta.ratesandrealty.com/public/unified-portal.html';
      const subj = 'Your Rates & Realty Portal is Ready, ' + first_name + '!';
      const html = buildWelcomeEmail(first_name, ec, tempPw, crmId || user.borrower_id, portalUrl);
      const emailResult = await sendEmail(ec, first_name, subj, html);
      await logActivity({ contact_id: contactId, portal_user_id: user.id, crm_id: crmId, type: 'email', channel: 'email', title: 'Welcome Email Sent', description: 'Portal account created. Welcome email sent to ' + ec, status: emailResult.sent ? 'sent' : 'failed', email_subject: subj, email_html: html, email_to: ec, metadata: { action: 'portal_signup', borrower_id: user.borrower_id, email_error: emailResult.error } });
      const { password_hash: _h, temp_password: _t, verification_token: _v, reset_token: _r, reset_token_expires: _re, ...safeUser } = user;
      return respond({ success: true, user: safeUser, message: 'Account created! Check your email.' });
    }

    if (action === 'login') {
      const t = await verifyTurnstile(body.turnstileToken, req.headers.get('cf-connecting-ip'));
      if (!t.ok) return turnstileRefusal(t);
      const { email, password } = body;
      if (!email || !password) return respond({ error: 'Email and password required' }, 400);
      const ec = email.toLowerCase().trim();
      const { data: user, error } = await sb.from('portal_users').select('*').eq('email', ec).single();
      if (error || !user) return respond({ error: 'No account found with that email.' }, 404);
      const valid = await verifyPassword(password, user.password_hash);
      const tempValid = user.temp_password && password === user.temp_password;
      if (!valid && !tempValid) return respond({ error: 'Incorrect password.' }, 401);
      await sb.from('portal_users').update({ last_login: new Date().toISOString() }).eq('id', user.id);
      await logActivity({ contact_id: user.contact_id, portal_user_id: user.id, crm_id: user.borrower_id, type: 'portal', channel: 'portal', title: 'Portal Login', description: user.first_name + ' ' + user.last_name + ' logged into borrower portal', status: 'success', metadata: { email: ec, is_temp_password: tempValid } });
      const { password_hash, temp_password, verification_token, reset_token, reset_token_expires, ...safeUser } = user;
      return respond({ success: true, user: safeUser, is_temp_password: tempValid });
    }

    if (action === 'change_password') {
      const { user_id, new_password } = body;
      if (!user_id || !new_password) return respond({ error: 'Missing fields' }, 400);
      const hash = await hashPassword(new_password);
      await sb.from('portal_users').update({ password_hash: hash, temp_password: null }).eq('id', user_id);
      const { data: u } = await sb.from('portal_users').select('contact_id,borrower_id,email').eq('id', user_id).single();
      await logActivity({ contact_id: u?.contact_id, portal_user_id: user_id, crm_id: u?.borrower_id, type: 'portal', channel: 'portal', title: 'Password Changed', status: 'success', metadata: { email: u?.email } });
      return respond({ success: true });
    }

    if (action === 'send_reset') {
      const { email, admin_override } = body;
      if (!email) return respond({ error: 'Email required' }, 400);
      const ec = email.toLowerCase().trim();
      const { data: user } = await sb.from('portal_users').select('id,first_name,email,borrower_id,contact_id').eq('email', ec).single();
      if (!user) return respond({ error: 'No account found with that email.' }, 404);
      const newPw = genTempPw();
      const newHash = await hashPassword(newPw);
      await sb.from('portal_users').update({ temp_password: newPw, password_hash: newHash, reset_token: genToken(), reset_token_expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }).eq('id', user.id);
      const portalUrl = 'https://beta.ratesandrealty.com/public/unified-portal.html';
      const resetSubj = 'Your Rates & Realty Password Has Been Reset';
      const resetHtml = buildPasswordResetEmail(user.first_name, ec, newPw, user.borrower_id || '', portalUrl, !!admin_override);
      const emailResult = await sendEmail(ec, user.first_name, resetSubj, resetHtml);
      await logActivity({ contact_id: user.contact_id, portal_user_id: user.id, crm_id: user.borrower_id, type: 'email', channel: 'email', title: admin_override ? 'Password Reset (by Rene)' : 'Password Reset Requested', description: 'Password reset email sent to ' + ec, status: emailResult.sent ? 'sent' : 'failed', email_subject: resetSubj, email_to: ec, metadata: { admin_override, new_temp_pw: newPw, email_error: emailResult.error } });
      return respond({ success: true, message: 'Reset email sent to ' + ec });
    }

    if (action === 'log_activity') {
      const { contact_id, portal_user_id, crm_id, type, channel, title, description, status, email_subject, email_html, email_to, sms_body, sms_to, metadata } = body;
      await logActivity({ contact_id, portal_user_id, crm_id, type: type || 'system', channel: channel || 'system', title: title || 'Event', description, status: status || 'sent', email_subject, email_html, email_to, sms_body, sms_to, metadata });
      return respond({ success: true });
    }

    if (action === 'get_user') {
      const { user_id, borrower_id, email } = body;
      let query = sb.from('portal_users').select('id,email,first_name,last_name,phone,borrower_id,created_at,last_login,source,temp_password,contact_id');
      if (user_id) query = query.eq('id', user_id);
      else if (borrower_id) query = query.eq('borrower_id', borrower_id);
      else if (email) query = query.eq('email', email.toLowerCase().trim());
      else return respond({ error: 'user_id, borrower_id, or email required' }, 400);
      const { data: user } = await query.single();
      if (!user) return respond({ error: 'User not found' }, 404);
      return respond({ user });
    }

    if (action === 'upsert_contact') {
      const { email, phone, first_name, last_name, source } = body;
      if (!email && !phone) return respond({ error: 'email or phone required' }, 400);
      const contactId = await safeUpsertContact({ email: email?.toLowerCase().trim(), phone: phone?.trim(), first_name: first_name?.trim(), last_name: last_name?.trim(), source: source || 'form' });
      if (contactId && (first_name || email)) { await logActivity({ contact_id: contactId, type: 'system', channel: 'form', title: 'New Lead: ' + (source || 'Form Submission'), description: ((first_name || '') + ' ' + (last_name || '') + ' ' + (email || phone || '')).trim(), status: 'received', metadata: { email, phone, source } }); }
      return respond({ success: true, contact_id: contactId });
    }

    if (action === 'sync_chat') {
      const { session_id, guest_email, guest_phone, guest_name, messages, page_url, lead_captured } = body;
      let contactId = null;
      if (guest_email) { const { data: c } = await sb.from('contacts').select('id').eq('email', guest_email.toLowerCase().trim()).single(); contactId = c?.id || null; }
      if (!contactId && guest_phone) { const { data: c } = await sb.from('contacts').select('id').eq('phone', guest_phone).single(); contactId = c?.id || null; }
      if (contactId && session_id) { await sb.from('chat_conversations').update({ contact_id: contactId }).eq('session_id', session_id); }
      const msgArr = Array.isArray(messages) ? messages : [];
      const msgCount = msgArr.length;
      const lastMsg = msgArr.length > 0 ? msgArr[msgArr.length - 1] : null;
      const preview = lastMsg && lastMsg.content ? String(lastMsg.content).substring(0, 120) : '';
      await logActivity({ contact_id: contactId, type: 'chat', channel: 'chat', title: 'AI Chat: ' + (guest_name || guest_email || 'Visitor'), description: msgCount + ' messages' + (preview ? ' \u2014 ' + preview : ''), status: lead_captured ? 'lead_captured' : 'completed', metadata: { session_id, guest_email, guest_phone, guest_name, page_url, message_count: msgCount, lead_captured } });
      return respond({ success: true, contact_id: contactId });
    }

    return respond({ error: 'Unknown action' }, 400);
  } catch (e: any) {
    console.error('portal-auth error:', e);
    return respond({ error: e.message || 'Server error' }, 500);
  }
});
