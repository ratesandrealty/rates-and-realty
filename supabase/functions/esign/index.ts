import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { requireStaff } from '../_shared/require-staff.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PUBLIC_BASE = 'https://homes.ratesandrealty.com';
const PROCESSING_EMAIL = 'processing@ratesandrealty.com';
const OWNER_EMAIL = 'rene@ratesandrealty.com';
const BUCKET = 'esign';
const EXPIRES_DAYS = 14;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
};
const svc = () => createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (x: any) => String(x ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const genToken = () => { const a = new Uint8Array(24); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2,'0')).join(''); };
const clientIp = (req: Request) => (req.headers.get('x-forwarded-for')||'').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || '';
const userAgent = (req: Request) => req.headers.get('user-agent') || '';
const fmtTs = (t: any) => t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + ' PT' : '\u2014';

async function sha256Hex(str: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
}

async function requireAdmin(req: Request): Promise<{ ok: boolean; userId: string|null; status?: number; msg?: string }> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, userId: null, status: 401, msg: 'missing authorization' };
  if (token === SERVICE) return { ok: true, userId: null };
  try {
    const u = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
    const { data: { user } } = await u.auth.getUser();
    if (!user) return { ok: false, userId: null, status: 401, msg: 'invalid session' };
    const { data: isAdmin } = await u.rpc('is_admin');
    if (!isAdmin) return { ok: false, userId: user.id, status: 403, msg: 'admin only' };
    return { ok: true, userId: user.id };
  } catch (_e) { return { ok: false, userId: null, status: 401, msg: 'auth check failed' }; }
}

async function sendRaw(p: { to_email: string; subject: string; html: string; cc?: string; contact_id?: string|null }) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/email-service`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': SERVICE },
      body: JSON.stringify({ action: 'send', to_email: p.to_email, subject: p.subject, html: p.html, cc: p.cc, contact_id: p.contact_id || null })
    });
  } catch (_e) { /* non-fatal */ }
}

async function callEsignDocs(action: string, payload: any) {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/esign-docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE}`, 'apikey': SERVICE },
      body: JSON.stringify({ action, ...payload })
    });
    return await r.json().catch(() => null);
  } catch (_e) { return null; }
}

function inviteHtml(title: string, signerName: string, signingUrl: string) {
  const first = (signerName || '').trim().split(/\s+/)[0] || 'there';
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.5;">
  <h2 style="color:#1a1a1a;margin:0 0 14px;">Please sign: ${esc(title)}</h2>
  <p>Hi ${esc(first)},</p>
  <p>Rene Duarte has sent you a document to review and sign electronically: <strong>${esc(title)}</strong>.</p>
  <p style="text-align:center;margin:28px 0;"><a href="${signingUrl}" style="background:#C9A84C;color:#1a0e00;padding:12px 30px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Review &amp; Sign</a></p>
  <p style="font-size:13px;color:#666;">Or open this link in your browser:<br><a href="${signingUrl}">${signingUrl}</a></p>
  <p style="font-size:12px;color:#999;margin-top:22px;">This link is unique to you \u2014 please don't forward it. It expires in ${EXPIRES_DAYS} days.</p>
  <p style="margin-top:18px;">Thank you,<br>Rene Duarte<br><span style="color:#777;">RFD Group \u00b7 Rates &amp; Realty</span></p>
</div>`;
}

function cancelHtml(env: any, signerName: string, reason: string|null) {
  const first = (signerName || '').trim().split(/\s+/)[0] || 'there';
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.5;">
  <h2 style="color:#1a1a1a;margin:0 0 14px;">Signature request cancelled</h2>
  <p>Hi ${esc(first)},</p>
  <p>The request to sign <strong>${esc(env.document_title)}</strong> has been cancelled by Rene Duarte. No action is needed \u2014 the signing link is no longer active.</p>
  ${reason ? `<p style=\"background:#f7f4ec;border-left:3px solid #C9A84C;padding:10px 12px;color:#444;\"><strong>Note:</strong> ${esc(reason)}</p>` : ''}
  <p>If a new version needs to be signed, you'll receive a fresh link. Questions? Just reply to this email.</p>
  <p style="margin-top:18px;">Thank you,<br>Rene Duarte<br><span style="color:#777;">RFD Group \u00b7 Rates &amp; Realty</span></p>
</div>`;
}

async function sendLinkEmail(env: any, signer: any) {
  if (!signer.email) return;
  const signingUrl = `${PUBLIC_BASE}/sign.html?t=${signer.token}`;
  await sendRaw({ to_email: signer.email, subject: env.email_subject || `Please sign: ${env.document_title}`, html: inviteHtml(env.document_title, signer.name, signingUrl), contact_id: env.contact_id });
}

// ---- SMS the signing link via sms-service (Twilio). Gated by env.send_sms + signer.phone (force bypasses the gate). ----
async function sendLinkSms(env: any, signer: any, force = false) {
  if (!force && env.send_sms === false) return;
  if (signer.is_cc) return;
  const phone = signer.phone;
  if (!phone) return;
  const signingUrl = `${PUBLIC_BASE}/sign.html?t=${signer.token}`;
  const first = (signer.name || '').trim().split(/\s+/)[0] || 'there';
  const rawTitle = String(env.document_title || 'your document');
  const title = rawTitle.length > 60 ? rawTitle.slice(0, 57) + '\u2026' : rawTitle;
  const msg = `Hi ${first}, Rene Duarte (Rates & Realty) sent you a document to e-sign: ${title}. Review & sign here: ${signingUrl} Reply STOP to opt out.`;
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/sms-service`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SERVICE, 'Authorization': `Bearer ${SERVICE}` },
      body: JSON.stringify({ trigger: 'custom', to_phone: phone, params: { message: msg, firstName: first }, contact_id: signer.person_contact_id || env.contact_id || null, trigger_id: env.id })
    });
  } catch (_e) { /* non-fatal */ }
}

async function phonesForSigners(db: any, signers: any[]): Promise<Record<string,string>> {
  const cids = [...new Set(signers.map((s: any) => s.person_contact_id).filter(Boolean))];
  const out: Record<string,string> = {};
  if (!cids.length) return out;
  const { data: cs } = await db.from('contacts').select('id,phone,secondary_phone').in('id', cids);
  for (const c of (cs || [])) { const p = c.phone || c.secondary_phone; if (p) out[c.id] = p; }
  return out;
}

function buildCertificate(env: any, signers: any[], events: any[], hash: string) {
  const ev = (sid: string, type: string) => {
    const e = events.find(x => x.signer_id === sid && x.event_type === type);
    return e ? fmtTs(e.occurred_at) + (e.ip ? ' \u00b7 IP ' + e.ip : '') : '\u2014';
  };
  const rows = signers.map(s => `<tr>
      <td style="padding:7px 10px;border-bottom:1px solid #eee;vertical-align:top;"><strong>${esc(s.name)}</strong><br><span style="color:#666;font-size:12px;">${esc(s.email)} \u00b7 ${esc(s.role || '')}</span></td>
      <td style="padding:7px 10px;border-bottom:1px solid #eee;font-size:12px;color:#444;">Sent: ${ev(s.id,'sent')}<br>Viewed: ${ev(s.id,'viewed')}<br>Signed: ${ev(s.id,'signed')}</td>
    </tr>`).join('');
  return `<div style="border:1px solid #ddd;border-radius:8px;padding:16px;margin:18px 0;font-family:Arial,sans-serif;">
    <div style="font-size:15px;font-weight:bold;margin-bottom:4px;color:#1a1a1a;">Certificate of Completion</div>
    <div style="font-size:12px;color:#666;margin-bottom:12px;">Envelope ${esc(env.id)}<br>${esc(env.document_title)}<br>Broker: E Mortgage Capital, Inc. (DBA EMC) \u00b7 NMLS #1416824<br>Loan Officer: Rene Duarte \u00b7 NMLS #1795044</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">${rows}</table>
    <div style="font-size:11px;color:#888;margin-top:12px;">Each signer consented to the use of electronic records and signatures (ESIGN/UETA). Document integrity (SHA-256):<br><code style="font-size:10px;word-break:break-all;color:#555;">${hash}</code></div>
  </div>`;
}

function completionEmailHtml(env: any, signers: any[], signedDoc: string, certificate: string) {
  const names = signers.map(s => esc(s.name)).join(', ');
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;color:#222;line-height:1.5;">
    <h2 style="color:#1a1a1a;">Document completed &amp; signed</h2>
    <p><strong>${esc(env.document_title)}</strong> has been signed by ${names}. A copy is below for your records.</p>
    ${certificate}
    <div style="font-size:12px;color:#666;margin:6px 0 8px;font-weight:bold;">Signed document</div>
    <div style="border:1px solid #ddd;border-radius:8px;padding:8px;background:#fff;">${signedDoc}</div>
    <p style="font-size:12px;color:#999;margin-top:18px;">RFD Group \u00b7 Rates &amp; Realty</p>
  </div>`;
}

function completionEmailPdfHtml(env: any, signers: any[], finalUrl: string|null) {
  const names = signers.filter((s: any) => !s.is_cc).map((s: any) => esc(s.name)).join(', ');
  const btn = finalUrl
    ? `<p style="text-align:center;margin:26px 0;"><a href="${finalUrl}" style="background:#C9A84C;color:#1a0e00;padding:12px 30px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Download signed PDF</a></p><p style="font-size:13px;color:#666;">Or open this link in your browser:<br><a href="${finalUrl}">${finalUrl}</a></p>`
    : `<p style="color:#666;">The signed PDF is being generated and will be available shortly in your dashboard.</p>`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#222;line-height:1.5;">
    <h2 style="color:#1a1a1a;">Document completed &amp; signed</h2>
    <p><strong>${esc(env.document_title)}</strong> has been signed by ${names}. The completed PDF with all signatures is available at the link below.</p>
    ${btn}
    <p style="font-size:12px;color:#999;margin-top:18px;">RFD Group \u00b7 Rates &amp; Realty</p>
  </div>`;
}

/* ── THE COMPLETION RECORD PDF ──────────────────────────────────────────────
 *
 * Generated HERE, at completion, so the artifact is contemporaneous with the
 * signature it attests to. Before 2026-08-09 it was only ever written as a side
 * effect of a human clicking Download, which is why eight completed requests
 * have no record PDF and the four that do were created 14 minutes to 5 days
 * after completion.
 *
 * THIS FUNCTION CANNOT THROW, AND MUST NOT.
 *
 * finalizeAndNotify's job is completion. A signature that completed is more
 * important than a PDF of it: if this fails, the completion still stands and
 * the emails still go, because the signer already signed and the record of that
 * lives in signature_events, signature_signers and document_hash regardless.
 * Blocking or rolling back a completed signature over a failed PDF render would
 * be the worse outcome by a wide margin.
 *
 * But it must not fail QUIETLY either — that is how the eight got here. So
 * every outcome writes a signature_events row, which is the envelope's own
 * audit trail, is rendered into the record PDF itself, and is the place someone
 * looking at this envelope will actually be. Plus console.error for the logs.
 *
 * Event types (both new):
 *   record_generated — detail { path, reused_existing }
 *   record_failed    — detail { error }
 * `reused_existing` matters because esign-docs never overwrites: a true there
 * means the object was already present and was deliberately left alone. */
async function buildRecordSafely(db: any, env: any): Promise<{ ok: boolean; path?: string; existed?: boolean; error?: string }> {
  try {
    const r = await callEsignDocs('build_record', { envelope_id: env.id });
    if (r && r.path && !r.error) {
      await logEvent(db, env.id, null, 'record_generated', null, 'system',
        { path: r.path, reused_existing: !!r.existed });
      return { ok: true, path: r.path, existed: !!r.existed };
    }
    const why = (r && r.error) ? String(r.error) : 'esign-docs build_record returned no path';
    console.error(`[esign] record PDF FAILED envelope=${env.id}: ${why}`);
    await logEvent(db, env.id, null, 'record_failed', null, 'system', { error: why.slice(0, 400) });
    return { ok: false, error: why };
  } catch (e) {
    /* Even the failure logging is wrapped: a completion must survive a dead
     * signature_events insert too. */
    const why = String(e).slice(0, 400);
    console.error(`[esign] record PDF THREW envelope=${env.id}: ${why}`);
    try { await logEvent(db, env.id, null, 'record_failed', null, 'system', { error: why }); } catch (_) {}
    return { ok: false, error: why };
  }
}

async function finalizeAndNotify(db: any, env: any, force = false) {
  if (!force) {
    const { data: already } = await db.from('signature_events').select('id').eq('request_id', env.id).eq('event_type', 'completed_emailed').limit(1);
    if (already && already.length) return { emailed: false, reason: 'already emailed' };
  }

  if (env.document_type === 'pdf') {
    /* Record first, emails after. buildRecordSafely never throws, so putting it
       first cannot stop the email — and it means the record exists by the time
       anyone reads the notification. */
    const rec = await buildRecordSafely(db, env);
    const fin = await callEsignDocs('build_final', { envelope_id: env.id });
    const finalUrl = (fin && (fin.combined_url || fin.url)) ? (fin.combined_url || fin.url) : (env.combined_pdf_url || env.final_pdf_url || null);
    const { data: signers } = await db.from('signature_signers').select('*').eq('request_id', env.id).order('routing_order');
    const html = completionEmailPdfHtml(env, signers || [], finalUrl);
    for (const s of (signers || [])) {
      if (!s.email) continue;
      await sendRaw({ to_email: s.email, subject: `Signed: ${env.document_title}`, html, contact_id: env.contact_id });
    }
    await sendRaw({ to_email: OWNER_EMAIL, cc: PROCESSING_EMAIL, subject: `Completed & signed: ${env.document_title}`, html, contact_id: env.contact_id });
    await logEvent(db, env.id, null, 'completed_emailed', null, 'system', { recipients: (signers || []).length, processing: PROCESSING_EMAIL, pdf: true, final_pdf: !!finalUrl });
    return { emailed: true, pdf: true, final_pdf: !!finalUrl, recipients: (signers || []).length + 1, record: rec };
  }

  const { data: signers } = await db.from('signature_signers').select('*').eq('request_id', env.id).order('routing_order');
  const { data: events } = await db.from('signature_events').select('*').eq('request_id', env.id).order('occurred_at');
  const signedDoc = renderDocument(env.document_html, signers || []);
  const hash = await sha256Hex(signedDoc);
  await db.from('signature_requests').update({ document_hash: hash }).eq('id', env.id);
  /* AFTER document_hash is stored: the record PDF prints that hash as its
     integrity line, so building it first would stamp a hash computed inside
     esign-docs instead of the one persisted here. Same value today, but the
     ordering is the thing that keeps it true. */
  const rec = await buildRecordSafely(db, { ...env, document_hash: hash });
  const certificate = buildCertificate(env, signers || [], events || [], hash);
  const html = completionEmailHtml(env, signers || [], signedDoc, certificate);
  for (const s of (signers || [])) {
    if (!s.email) continue;
    await sendRaw({ to_email: s.email, subject: `Signed: ${env.document_title}`, html, contact_id: env.contact_id });
  }
  await sendRaw({ to_email: OWNER_EMAIL, cc: PROCESSING_EMAIL, subject: `Completed & signed: ${env.document_title}`, html, contact_id: env.contact_id });
  await logEvent(db, env.id, null, 'completed_emailed', null, 'system', { recipients: (signers || []).length, processing: PROCESSING_EMAIL });
  return { emailed: true, recipients: (signers || []).length + 1, record: rec };
}

function signerBlock(tpl: any, signer: { id: string; name: string }) {
  return String(tpl.signer_block_html)
    .replaceAll('{{signature}}', `{{s:${signer.id}:signature}}`)
    .replaceAll('{{printed_name}}', esc(signer.name))
    .replaceAll('{{signed_date}}', `{{s:${signer.id}:signed_date}}`)
    .replaceAll('{{ssn_last4}}', `{{s:${signer.id}:ssn_last4}}`);
}

function renderDocument(html: string, signers: any[]) {
  let out = html;
  for (const s of signers) {
    let sig = '';
    if (s.status === 'signed') {
      sig = s.signature_type === 'typed'
        ? `<span style="font-family:'Brush Script MT','Segoe Script',cursive;font-size:26px;">${esc(s.signature_data)}</span>`
        : `<img src="${s.signature_data}" style="max-height:46px" />`;
    }
    const date = s.signed_at ? new Date(s.signed_at).toLocaleDateString('en-US') : '';
    const ssn = s.field_values?.ssn_last4 ? '\u2022\u2022\u2022\u2022\u2022 ' + s.field_values.ssn_last4 : '';
    out = out.replaceAll(`{{s:${s.id}:signature}}`, sig)
             .replaceAll(`{{s:${s.id}:signed_date}}`, esc(date))
             .replaceAll(`{{s:${s.id}:ssn_last4}}`, esc(ssn));
  }
  return out;
}

async function logEvent(db: any, request_id: string, signer_id: string|null, event_type: string, req: Request|null, actor?: string, detail: any = {}) {
  await db.from('signature_events').insert({ request_id, signer_id, event_type, actor: actor ?? null, ip: req ? clientIp(req) : null, user_agent: req ? userAgent(req) : null, detail });
}

// ---- PDF envelope: create from one or more uploaded esign_documents + their placed fields ----
async function createPdf(req: Request, body: any, adm: any, db: any) {
  const { contact_id, lead_id, signers, order_mode, email_subject, email_message, processing_item_id, document_title } = body;
  let docIds: string[] = Array.isArray(body.document_ids) ? body.document_ids.filter(Boolean) : [];
  if (!docIds.length && body.document_id) docIds = [body.document_id];
  if (!docIds.length) return json({ error: 'document_id or document_ids[] required' }, 400);
  if (!Array.isArray(signers) || signers.length === 0) return json({ error: 'signers[] required' }, 400);

  const { data: docs } = await db.from('esign_documents').select('*').in('id', docIds);
  const orderedDocs = docIds.map((id: string) => (docs || []).find((d: any) => d.id === id)).filter(Boolean);
  if (orderedDocs.length !== docIds.length) return json({ error: 'one or more documents not found' }, 404);
  for (const d of orderedDocs) if (d.request_id) return json({ error: `document "${d.name}" has already been sent` }, 409);

  const { data: allFields } = await db.from('esign_fields').select('id,document_id,signer_index,fill_by').in('document_id', docIds);
  const fieldsByDoc: Record<string, any[]> = {};
  for (const f of (allFields || [])) (fieldsByDoc[f.document_id] = fieldsByDoc[f.document_id] || []).push(f);
  for (const d of orderedDocs) if (!(fieldsByDoc[d.id] && fieldsByDoc[d.id].length)) return json({ error: `place at least one field on "${d.name}" before sending` }, 400);

  // Only signer-fill fields determine how many signers are required. Sender (literal) and merge
  // (data-resolved) fields are stamped automatically and need no signer.
  const signerFields = (allFields || []).filter((f: any) => f.fill_by !== 'sender' && f.fill_by !== 'merge');
  const maxIdx = signerFields.length ? Math.max(...signerFields.map((f: any) => Number(f.signer_index) || 1)) : 1;
  const nonCc = signers.filter((s: any) => !s.is_cc);
  if (signerFields.length && nonCc.length < maxIdx) return json({ error: `documents have signer fields for ${maxIdx} signer(s) but only ${nonCc.length} signer(s) were provided` }, 400);

  const mode = order_mode === 'sequential' ? 'sequential' : 'parallel';
  const expires_at = new Date(Date.now() + EXPIRES_DAYS * 864e5).toISOString();
  const title = document_title || (orderedDocs.length === 1 ? orderedDocs[0].name : `${orderedDocs.length} documents`) || 'Document';
  const firstContact = contact_id ?? orderedDocs[0].contact_id ?? null;

  const { data: env, error: envErr } = await db.from('signature_requests').insert({
    contact_id: firstContact, lead_id: lead_id ?? null, template_key: null,
    document_type: 'pdf', document_title: title, status: 'sent', order_mode: mode, created_by: adm.userId,
    email_subject: email_subject || `Please sign: ${title}`, email_message: email_message || null,
    merge_data: (body.merge_data && typeof body.merge_data === 'object') ? body.merge_data : {}, processing_item_id: processing_item_id ?? null, expires_at, document_html: '',
    send_sms: body.send_sms !== false
  }).select().single();
  if (envErr) return json({ error: envErr.message }, 400);

  for (let i = 0; i < orderedDocs.length; i++) {
    await db.from('esign_documents').update({ request_id: env.id, contact_id: firstContact, sort_order: i }).eq('id', orderedDocs[i].id);
  }

  const phoneByCid = await phonesForSigners(db, signers);
  let idx = 0;
  const rows = signers.map((s: any) => {
    const isCc = !!s.is_cc;
    return {
      request_id: env.id, person_contact_id: s.person_contact_id ?? null,
      name: s.name, email: s.email, role: s.role ?? 'borrower',
      phone: s.phone ?? (s.person_contact_id ? (phoneByCid[s.person_contact_id] ?? null) : null),
      routing_order: isCc ? 999 : (++idx), is_cc: isCc, token: genToken(), status: 'pending'
    };
  });
  const liveOrders = rows.filter((r: any) => !r.is_cc).map((r: any) => r.routing_order);
  const minOrder = liveOrders.length ? Math.min(...liveOrders) : 1;
  for (const r of rows) if (!r.is_cc && (mode === 'parallel' || r.routing_order === minOrder)) r.status = 'sent';
  const { data: ins, error: sErr } = await db.from('signature_signers').insert(rows).select();
  if (sErr) return json({ error: sErr.message }, 400);

  await logEvent(db, env.id, null, 'created', req, 'admin', { document_ids: docIds, documents: orderedDocs.length, signers: ins.length, pdf: true, send_sms: env.send_sms });
  for (const s of ins) if (s.status === 'sent') await logEvent(db, env.id, s.id, 'sent', req, 'admin');
  for (const s of ins) if (s.status === 'sent' && !s.is_cc) { await sendLinkEmail(env, s); await sendLinkSms(env, s); }

  return json({
    envelope_id: env.id, status: 'sent', order_mode: mode, mode: 'pdf', send_sms: env.send_sms,
    document_id: orderedDocs[0].id, document_ids: orderedDocs.map((d: any) => d.id), documents: orderedDocs.length,
    signers: ins.map((s: any) => ({ id: s.id, name: s.name, email: s.email, phone: s.phone, role: s.role, is_cc: s.is_cc, status: s.status,
      signing_url: s.is_cc ? null : `${PUBLIC_BASE}/sign.html?t=${s.token}` }))
  });
}

async function create(req: Request, body: any) {
  const adm = await requireStaff(req, { what: 'Creating an e-signature request' });
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  if (body.document_id || (Array.isArray(body.document_ids) && body.document_ids.length)) return await createPdf(req, body, adm, db);
  const { template_key, contact_id, lead_id, signers, order_mode, email_subject, email_message, processing_item_id } = body;
  if (!template_key || !Array.isArray(signers) || signers.length === 0) return json({ error: 'template_key and signers[] required' }, 400);

  const { data: tpl } = await db.from('signature_templates').select('*').eq('key', template_key).eq('active', true).maybeSingle();
  if (!tpl) return json({ error: 'template not found' }, 404);

  const lender = body.merge?.lender ?? tpl.defaults?.lender ?? '';
  const loan_number = body.merge?.loan_number ?? '';
  const mode = order_mode === 'sequential' ? 'sequential' : 'parallel';
  const expires_at = new Date(Date.now() + EXPIRES_DAYS * 864e5).toISOString();

  const { data: env, error: envErr } = await db.from('signature_requests').insert({
    contact_id: contact_id ?? null, lead_id: lead_id ?? null, template_key,
    document_type: tpl.document_type, document_title: body.document_title || tpl.name,
    status: 'sent', order_mode: mode, created_by: adm.userId,
    email_subject: email_subject || `Please sign: ${tpl.name}`, email_message: email_message || null,
    merge_data: { lender, loan_number }, processing_item_id: processing_item_id ?? null,
    expires_at, document_html: '', send_sms: body.send_sms !== false
  }).select().single();
  if (envErr) return json({ error: envErr.message }, 400);

  const phoneByCid = await phonesForSigners(db, signers);
  const rows = signers.map((s: any, i: number) => ({
    request_id: env.id, person_contact_id: s.person_contact_id ?? null,
    name: s.name, email: s.email, role: s.role ?? 'borrower',
    phone: s.phone ?? (s.person_contact_id ? (phoneByCid[s.person_contact_id] ?? null) : null),
    routing_order: s.routing_order ?? (mode === 'sequential' ? i + 1 : 1),
    is_cc: !!s.is_cc, token: genToken(), status: 'pending'
  }));
  const minOrder = Math.min(...rows.filter(r => !r.is_cc).map(r => r.routing_order));
  for (const r of rows) if (!r.is_cc && (mode === 'parallel' || r.routing_order === minOrder)) r.status = 'sent';
  const { data: ins, error: sErr } = await db.from('signature_signers').insert(rows).select();
  if (sErr) return json({ error: sErr.message }, 400);

  let merged = String(tpl.body_html).replaceAll('{{lender}}', esc(lender)).replaceAll('{{loan_number}}', esc(loan_number));
  const blocks = ins.filter((s: any) => !s.is_cc).sort((a: any,b: any)=>a.routing_order-b.routing_order).map((s: any) => signerBlock(tpl, s)).join('\n');
  merged = merged.split('{{SIGNERS}}').join(blocks);
  await db.from('signature_requests').update({ document_html: merged }).eq('id', env.id);

  await logEvent(db, env.id, null, 'created', req, 'admin', { template_key, signers: ins.length, send_sms: env.send_sms });
  for (const s of ins) if (s.status === 'sent') await logEvent(db, env.id, s.id, 'sent', req, 'admin');
  for (const s of ins) if (s.status === 'sent' && !s.is_cc) { await sendLinkEmail(env, s); await sendLinkSms(env, s); }

  return json({
    envelope_id: env.id, status: 'sent', order_mode: mode, send_sms: env.send_sms,
    signers: ins.map((s: any) => ({ id: s.id, name: s.name, email: s.email, phone: s.phone, role: s.role, is_cc: s.is_cc, status: s.status,
      signing_url: s.is_cc ? null : `${PUBLIC_BASE}/sign.html?t=${s.token}` }))
  });
}

async function view(req: Request, body: any) {
  const db = svc();
  const token = body.token;
  if (!token) return json({ error: 'token required' }, 400);
  const { data: signer } = await db.from('signature_signers').select('*, env:signature_requests(*)').eq('token', token).maybeSingle();
  if (!signer) return json({ error: 'invalid link' }, 404);
  const env = signer.env;
  if (env.status === 'voided' || env.status === 'declined') return json({ state: 'voided', message: 'This document is no longer available for signing.' });
  if (env.expires_at && new Date(env.expires_at) < new Date()) return json({ state: 'expired', message: 'This signing link has expired.' });
  if (signer.status === 'pending') return json({ state: 'waiting', message: 'It is not your turn to sign yet. You will be notified when the document is ready for you.' });
  if (signer.status === 'declined') return json({ state: 'declined', message: 'You declined to sign this document.' });

  if (signer.status === 'sent') {
    await db.from('signature_signers').update({ status: 'viewed', viewed_at: new Date().toISOString() }).eq('id', signer.id);
    await logEvent(db, env.id, signer.id, 'viewed', req, signer.name);
  }

  if (env.document_type === 'pdf') {
    const { data: docs } = await db.from('esign_documents').select('*').eq('request_id', env.id).eq('source', 'upload').order('sort_order').order('created_at');
    if (!docs || !docs.length) return json({ error: 'document not available' }, 500);
    const myIdx = signer.routing_order;
    const documents: any[] = [];
    for (const doc of docs) {
      const su = await db.storage.from(BUCKET).createSignedUrl(doc.storage_path, 60 * 60);
      const { data: fields } = await db.from('esign_fields').select('*').eq('document_id', doc.id).order('page');
      const outFields = (fields || []).map((f: any) => ({
        id: f.id, type: f.type, page: Number(f.page) || 1,
        x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h),
        required: f.required !== false, fill_by: f.fill_by,
        mine: (f.fill_by !== 'sender' && f.fill_by !== 'merge') && (Number(f.signer_index) || 1) === myIdx,
        value: (f.fill_by === 'sender') ? (f.value ?? null) : null
      }));
      documents.push({ document_id: doc.id, name: doc.name, page_count: doc.page_count, page_sizes: doc.page_sizes, url: su.error ? null : su.data.signedUrl, fields: outFields });
    }
    const first = documents[0];
    return json({
      state: signer.status === 'signed' ? 'signed' : 'ready',
      mode: 'pdf',
      envelope: { id: env.id, title: env.document_title, status: env.status, holder: 'RFD Group / Rates & Realty', document_count: documents.length },
      signer: { id: signer.id, name: signer.name, email: signer.email, role: signer.role, status: signer.status, signer_index: myIdx },
      documents,
      pdf: { url: first.url, name: first.name, page_count: first.page_count, page_sizes: first.page_sizes },
      fields: first.fields
    });
  }

  const { data: allSigners } = await db.from('signature_signers').select('*').eq('request_id', env.id);
  const { data: tpl } = await db.from('signature_templates').select('collects').eq('key', env.template_key).maybeSingle();
  return json({
    state: signer.status === 'signed' ? 'signed' : 'ready',
    envelope: { id: env.id, title: env.document_title, status: env.status, holder: 'RFD Group / Rates &amp; Realty' },
    signer: { id: signer.id, name: signer.name, email: signer.email, role: signer.role, status: signer.status, collects: tpl?.collects ?? [] },
    document_html: renderDocument(env.document_html, allSigners || [])
  });
}

async function submit(req: Request, body: any) {
  const db = svc();
  const { token, signature_data, signature_type, ssn_last4, decline, decline_reason } = body;
  if (!token) return json({ error: 'token required' }, 400);
  const { data: signer } = await db.from('signature_signers').select('*, env:signature_requests(*)').eq('token', token).maybeSingle();
  if (!signer) return json({ error: 'invalid link' }, 404);
  const env = signer.env;
  if (!['sent','viewed'].includes(signer.status)) return json({ error: `cannot sign (status: ${signer.status})` }, 409);
  if (env.expires_at && new Date(env.expires_at) < new Date()) return json({ error: 'link expired' }, 410);

  if (decline) {
    await db.from('signature_signers').update({ status: 'declined', decline_reason: decline_reason || null }).eq('id', signer.id);
    await db.from('signature_requests').update({ status: 'declined' }).eq('id', env.id);
    await logEvent(db, env.id, signer.id, 'declined', req, signer.name, { reason: decline_reason || null });
    return json({ ok: true, declined: true });
  }

  if (!signature_data) return json({ error: 'signature required' }, 400);
  let fieldValues: any = {};
  if (env.document_type === 'pdf') {
    if (body.field_values && typeof body.field_values === 'object') fieldValues = { ...body.field_values };
    if (ssn_last4 && /^\d{4}$/.test(String(ssn_last4))) fieldValues.ssn_last4 = String(ssn_last4);
  } else {
    const { data: tpl } = await db.from('signature_templates').select('collects').eq('key', env.template_key).maybeSingle();
    if ((tpl?.collects || []).includes('ssn_last4')) {
      if (!/^\d{4}$/.test(String(ssn_last4 || ''))) return json({ error: 'last 4 of SSN required (4 digits)' }, 400);
      fieldValues.ssn_last4 = String(ssn_last4);
    }
  }

  await db.from('signature_signers').update({
    status: 'signed', signed_at: new Date().toISOString(), signed_ip: clientIp(req), user_agent: userAgent(req),
    signature_data, signature_type: signature_type === 'typed' ? 'typed' : 'drawn', field_values: fieldValues
  }).eq('id', signer.id);
  await logEvent(db, env.id, signer.id, 'signed', req, signer.name);

  const { data: all } = await db.from('signature_signers').select('*').eq('request_id', env.id).eq('is_cc', false);
  const remaining = (all || []).filter((s: any) => s.status !== 'signed');
  let completed = false;
  if (remaining.length === 0) {
    await db.from('signature_requests').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', env.id);
    await logEvent(db, env.id, null, 'completed', req, 'system');
    completed = true;
    const { data: freshEnv } = await db.from('signature_requests').select('*').eq('id', env.id).maybeSingle();
    await finalizeAndNotify(db, freshEnv || env);
  } else if (env.order_mode === 'sequential') {
    const nextOrder = Math.min(...remaining.map((s: any) => s.routing_order));
    for (const s of remaining.filter((r: any) => r.routing_order === nextOrder && r.status === 'pending')) {
      await db.from('signature_signers').update({ status: 'sent' }).eq('id', s.id);
      await logEvent(db, env.id, s.id, 'sent', req, 'system');
      await sendLinkEmail(env, s); await sendLinkSms(env, s);
    }
  }
  return json({ ok: true, signed: true, completed });
}

async function resend(req: Request, body: any) {
  const adm = await requireStaff(req, { what: 'Resending a signing link' });
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const channel = ['email','sms','both'].includes(body.channel) ? body.channel : 'both';

  let env: any = null;
  let targets: any[] = [];
  if (body.token) {
    const { data: s } = await db.from('signature_signers').select('*, env:signature_requests(*)').eq('token', body.token).maybeSingle();
    if (!s) return json({ error: 'invalid link' }, 404);
    env = s.env; delete s.env; targets = [s];
  } else if (body.signer_id) {
    const { data: s } = await db.from('signature_signers').select('*').eq('id', body.signer_id).maybeSingle();
    if (!s) return json({ error: 'signer not found' }, 404);
    const { data: e } = await db.from('signature_requests').select('*').eq('id', s.request_id).maybeSingle();
    env = e; targets = [s];
  } else if (body.envelope_id) {
    const { data: e } = await db.from('signature_requests').select('*').eq('id', body.envelope_id).maybeSingle();
    if (!e) return json({ error: 'not found' }, 404);
    env = e;
    const { data: ss } = await db.from('signature_signers').select('*').eq('request_id', env.id).eq('is_cc', false).order('routing_order');
    targets = ss || [];
  } else {
    return json({ error: 'envelope_id, signer_id, or token required' }, 400);
  }
  if (!env) return json({ error: 'envelope not found' }, 404);
  if (['completed','voided','declined'].includes(env.status)) return json({ error: `cannot resend \u2014 envelope is ${env.status}` }, 409);
  if (env.expires_at && new Date(env.expires_at) < new Date()) return json({ error: 'link expired' }, 410);

  // optional phone override / set (single-target only)
  if (body.phone && targets.length === 1) {
    const p = String(body.phone).trim();
    await db.from('signature_signers').update({ phone: p }).eq('id', targets[0].id);
    targets[0].phone = p;
  }

  const resent: any[] = []; const skipped: any[] = [];
  for (const s of targets) {
    if (s.is_cc) { skipped.push({ id: s.id, reason: 'cc' }); continue; }
    if (!['sent','viewed'].includes(s.status)) { skipped.push({ id: s.id, reason: `status ${s.status}` }); continue; }
    let emailed = false, texted = false;
    if ((channel === 'both' || channel === 'email') && s.email) { await sendLinkEmail(env, s); emailed = true; }
    if ((channel === 'both' || channel === 'sms') && s.phone) { await sendLinkSms(env, s, true); texted = true; }
    await logEvent(db, env.id, s.id, 'resent', req, 'admin', { channel, emailed, texted });
    resent.push({ id: s.id, name: s.name, email: emailed ? s.email : null, phone: texted ? s.phone : null });
  }
  return json({ ok: true, channel, resent, skipped });
}

async function notify(req: Request, body: any) {
  const db = svc();
  let env: any = null;
  if (body.envelope_id) {
    const adm = await requireAdmin(req);
    if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
    const { data } = await db.from('signature_requests').select('*').eq('id', body.envelope_id).maybeSingle();
    env = data;
  } else if (body.token) {
    const { data: s } = await db.from('signature_signers').select('*, env:signature_requests(*)').eq('token', body.token).maybeSingle();
    if (s) env = s.env;
  }
  if (!env) return json({ error: 'not found' }, 404);
  if (env.status !== 'completed') return json({ error: `envelope not completed (status: ${env.status})` }, 409);
  const r = await finalizeAndNotify(db, env, !!body.force);
  return json({ ok: true, ...r });
}

async function voidEnvelope(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: env } = await db.from('signature_requests').select('*').eq('id', body.envelope_id).maybeSingle();
  if (!env) return json({ error: 'not found' }, 404);
  if (['completed','voided','declined'].includes(env.status)) return json({ error: `cannot cancel \u2014 envelope is ${env.status}` }, 409);
  const reason = (body.reason != null ? String(body.reason) : '').slice(0, 500) || null;
  await db.from('signature_requests').update({ status: 'voided', voided_at: new Date().toISOString(), void_reason: reason }).eq('id', env.id);
  await logEvent(db, env.id, null, 'voided', req, 'admin', { reason });

  const { data: signers } = await db.from('signature_signers').select('*').eq('request_id', env.id).eq('is_cc', false);
  let notified = 0;
  const doNotify = body.notify !== false;
  if (doNotify) {
    for (const s of (signers || [])) {
      if (!s.email) continue;
      if (!['sent','viewed'].includes(s.status)) continue; // only those with a live, unsigned link
      await sendRaw({ to_email: s.email, subject: `Cancelled: ${env.document_title}`, html: cancelHtml(env, s.name, reason), contact_id: env.contact_id });
      await logEvent(db, env.id, s.id, 'cancel_emailed', req, 'system');
      notified++;
    }
  }
  return json({ ok: true, voided: true, notified });
}

async function preview(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: env } = await db.from('signature_requests').select('*').eq('id', body.envelope_id).maybeSingle();
  if (!env) return json({ error: 'not found' }, 404);
  const { data: signers } = await db.from('signature_signers').select('*').eq('request_id', env.id).order('routing_order');
  const { data: events } = await db.from('signature_events').select('*').eq('request_id', env.id).order('occurred_at');
  if (env.document_type === 'pdf') {
    const fin = await callEsignDocs('final_url', { envelope_id: env.id });
    const { data: docRows } = await db.from('esign_documents').select('id,name,page_count,sort_order,final_pdf_url').eq('request_id', env.id).eq('source','upload').order('sort_order').order('created_at');
    return json({
      envelope: { id: env.id, title: env.document_title, status: env.status, created_at: env.created_at, completed_at: env.completed_at, document_type: 'pdf', document_count: (docRows || []).length },
      final_pdf_url: (fin && (fin.combined_url || fin.url)) ? (fin.combined_url || fin.url) : (env.combined_pdf_url || env.final_pdf_url || null),
      documents: (docRows || []).map((d: any) => ({ document_id: d.id, name: d.name, page_count: d.page_count, final_pdf_url: d.final_pdf_url })),
      certificate_html: buildCertificate(env, signers || [], events || [], env.document_hash || ''),
      signers: (signers || []).map((s: any) => ({ name: s.name, email: s.email, role: s.role, status: s.status, signed_at: s.signed_at }))
    });
  }
  const signedDoc = renderDocument(env.document_html, signers || []);
  const hash = env.document_hash || await sha256Hex(signedDoc);
  const certificate = buildCertificate(env, signers || [], events || [], hash);
  return json({
    envelope: { id: env.id, title: env.document_title, status: env.status, created_at: env.created_at, completed_at: env.completed_at, document_hash: hash },
    document_html: signedDoc,
    certificate_html: certificate,
    signers: (signers || []).map((s: any) => ({ name: s.name, email: s.email, role: s.role, status: s.status, signed_at: s.signed_at }))
  });
}

async function templatePreview(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: tpl } = await db.from('signature_templates').select('*').eq('key', body.template_key).maybeSingle();
  if (!tpl) return json({ error: 'template not found' }, 404);
  const lender = body.merge?.lender ?? tpl.defaults?.lender ?? '';
  const loan_number = body.merge?.loan_number ?? '';
  const collectsSsn = (tpl.collects || []).includes('ssn_last4');
  const names = (Array.isArray(body.signers) && body.signers.length) ? body.signers : [{ name: 'Signer 1' }];
  let merged = String(tpl.body_html).replaceAll('{{lender}}', esc(lender)).replaceAll('{{loan_number}}', esc(loan_number));
  const blocks = names.map((s: any, i: number) => String(tpl.signer_block_html)
    .replaceAll('{{signature}}', '<span style="color:#b08d2e;font-style:italic;">Awaiting signature</span>')
    .replaceAll('{{printed_name}}', esc(s.name || `Signer ${i + 1}`))
    .replaceAll('{{signed_date}}', '____________')
    .replaceAll('{{ssn_last4}}', collectsSsn ? '\u2022\u2022\u2022\u2022\u2022 ____' : '')
  ).join('\n');
  merged = merged.split('{{SIGNERS}}').join(blocks);
  return json({ document_html: merged, title: tpl.name, collects: tpl.collects || [] });
}

async function status(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: env } = await db.from('signature_requests').select('*').eq('id', body.envelope_id).maybeSingle();
  if (!env) return json({ error: 'not found' }, 404);
  const { data: signers } = await db.from('signature_signers').select('id,name,email,phone,role,routing_order,is_cc,status,sent_at,viewed_at,signed_at,signed_ip').eq('request_id', env.id).order('routing_order');
  const { data: events } = await db.from('signature_events').select('event_type,actor,ip,occurred_at').eq('request_id', env.id).order('occurred_at');
  const { data: docRows } = await db.from('esign_documents').select('id,name,page_count,sort_order,final_pdf_url').eq('request_id', env.id).eq('source','upload').order('sort_order').order('created_at');
  return json({ envelope: { id: env.id, title: env.document_title, status: env.status, document_type: env.document_type, created_at: env.created_at, completed_at: env.completed_at, document_hash: env.document_hash, final_pdf_url: env.combined_pdf_url || env.final_pdf_url, document_count: (docRows || []).length, send_sms: env.send_sms }, documents: (docRows || []).map((d: any) => ({ document_id: d.id, name: d.name, page_count: d.page_count, final_pdf_url: d.final_pdf_url })), signers, events });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || new URL(req.url).searchParams.get('action');
    switch (action) {
      case 'create': return await create(req, body);
      case 'view':   return await view(req, body);
      case 'submit': return await submit(req, body);
      case 'resend': return await resend(req, body);
      case 'notify': return await notify(req, body);
      case 'void':   return await voidEnvelope(req, body);
      case 'preview': return await preview(req, body);
      case 'template_preview': return await templatePreview(req, body);
      case 'status': return await status(req, body);
      default: return json({ error: 'unknown action', actions: ['create','view','submit','resend','notify','void','preview','template_preview','status'] }, 400);
    }
  } catch (e: any) {
    return json({ error: e?.message || 'error' }, 500);
  }
});
