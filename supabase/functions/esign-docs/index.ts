import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import fontkit from 'https://esm.sh/@pdf-lib/fontkit@1.1.1';
import { requireStaff } from '../_shared/require-staff.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'esign';
const OWNER_EMAIL = 'rene@ratesandrealty.com';
const PROCESSING_EMAIL = 'processing@ratesandrealty.com';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
};
const svc = () => createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const fmtTs = (t: any) => t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + ' PT' : '\u2014';

// ---- MERGE TAG SUPPORT ----
// Merge fields carry fill_by='merge' and value='{{tag}}'. Resolved via esign_merge_resolve RPC
// (loan snapshot + loan_borrowers for numbered borrowers + assigned lender card + defaults).
const MERGE_TAGS = ['borrower_name','co_borrower_name','borrower_email','borrower_phone','property_address','loan_number','loan_amount','loan_type','loan_purpose','purchase_price','employer_name','employer_phone','employer_address','employer_street','employer_city','employer_state','employer_zip','position_title','employment_start_date','employer2_name','employer2_phone','employer2_address','position2_title','co_borrower_employer','co_borrower_employer_phone','co_borrower_title','borrower1_name','borrower1_email','borrower1_phone','borrower1_employer_name','borrower1_employer_phone','borrower1_employer_address','borrower1_position_title','borrower1_employment_start_date','borrower2_name','borrower2_email','borrower2_phone','borrower2_employer_name','borrower2_employer_phone','borrower2_employer_address','borrower2_position_title','borrower2_employment_start_date','borrower3_name','borrower3_email','borrower3_phone','borrower3_employer_name','borrower3_employer_phone','borrower3_employer_address','borrower3_position_title','borrower3_employment_start_date','borrower4_name','borrower4_email','borrower4_phone','borrower4_employer_name','borrower4_employer_phone','borrower4_employer_address','borrower4_position_title','borrower4_employment_start_date','lender_name','lender_nmls','lender_address','mortgagee_clause','cpl_clause','lo_name','lo_nmls','lo_company','lo_company_nmls','today'];

async function fetchMergeMap(db: any, contactId: string | null, lenderId: string | null): Promise<Record<string,string>> {
  if (!contactId) return {};
  try {
    const { data, error } = await db.rpc('esign_merge_resolve', { p_contact_id: contactId, p_lender_id: lenderId || null });
    if (error || !data || !data.merge) return {};
    return data.merge as Record<string,string>;
  } catch (_e) { return {}; }
}

function resolveTags(value: string, map: Record<string,string>): string {
  if (!value) return '';
  return String(value).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, tag) => {
    const k = String(tag).toLowerCase();
    return (map[k] != null && map[k] !== '') ? String(map[k]) : '';
  });
}

// ---- cursive signature font (cached per warm isolate; falls back to Helvetica-Oblique) ----
let _scriptFontBytes: Uint8Array | null | undefined = undefined;
async function scriptFontBytes(): Promise<Uint8Array | null> {
  if (_scriptFontBytes !== undefined) return _scriptFontBytes;
  const urls = [
    'https://raw.githubusercontent.com/google/fonts/main/ofl/alexbrush/AlexBrush-Regular.ttf',
    'https://raw.githubusercontent.com/google/fonts/main/ofl/sacramento/Sacramento-Regular.ttf'
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (r.ok) { const b = new Uint8Array(await r.arrayBuffer()); if (b.length > 2000) { _scriptFontBytes = b; return b; } }
    } catch (_e) { /* try next */ }
  }
  _scriptFontBytes = null;
  return null;
}
async function embedScript(pdf: any, fallback: any) {
  try { const fb = await scriptFontBytes(); if (fb) { pdf.registerFontkit(fontkit); return await pdf.embedFont(fb); } } catch (_e) { /* fall back */ }
  return fallback;
}

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]+,/, '');
  const bin = atob(clean);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function normType(t: string): string { return t === 'ssn' ? 'ssn_last4' : t; }
async function sha256Hex(str: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function decodeEntities(s: string): string {
  return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/gi, '"').replace(/&bull;/gi, '\u2022').replace(/&middot;/gi, '\u00b7').replace(/&mdash;/gi, '\u2014');
}
function htmlToBlocks(html: string): string[] {
  let s = String(html || '');
  s = s.replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/table)\s*>/gi, '\n');
  s = s.replace(/<\s*li[^>]*>/gi, '\u2022 ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  const lines = s.split('\n').map(l => l.replace(/[\t ]+/g, ' ').trim());
  const out: string[] = [];
  for (const l of lines) { if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue; out.push(l); }
  return out;
}
function wrapText(text: string, font: any, size: number, maxWidth: number): string[] {
  const words = String(text).split(/\s+/);
  const lines: string[] = []; let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && cur) { lines.push(cur); cur = w; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
function humanizeEvent(t: string): string {
  const m: Record<string, string> = {
    created: 'Envelope created', sent: 'Sent to signer', viewed: 'Viewed by signer', signed: 'Signed',
    completed: 'Envelope completed', completed_emailed: 'Completed copies emailed', voided: 'Cancelled / Voided',
    declined: 'Declined', cancel_emailed: 'Cancellation emailed'
  };
  return m[t] || t;
}
const DISCLOSURE = 'By signing this document electronically, each signer agreed that their electronic signature is the legal equivalent of their manual signature, and consented to conduct business electronically under the U.S. ESIGN Act and applicable Uniform Electronic Transactions Act (UETA). Each signer accessed the document through a unique tokenized link sent to their email address, which served as their authentication. This certificate, together with the audit trail above, evidences the signing process and the integrity of the completed record.';

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

async function upload(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const { name, contact_id, request_id, pdf_base64, replace_document_id } = body;
  if (!pdf_base64) return json({ error: 'pdf_base64 required' }, 400);
  let bytes: Uint8Array;
  try { bytes = b64ToBytes(pdf_base64); } catch (_e) { return json({ error: 'invalid base64' }, 400); }
  if (bytes.length === 0) return json({ error: 'empty file' }, 400);
  if (bytes.length > 26214400) return json({ error: 'file exceeds 25MB' }, 400);
  let page_count = 0; const page_sizes: { w: number; h: number }[] = [];
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = pdf.getPages();
    page_count = pages.length;
    for (const p of pages) { const { width, height } = p.getSize(); page_sizes.push({ w: Math.round(width), h: Math.round(height) }); }
  } catch (_e) { return json({ error: 'could not read PDF (corrupt or not a PDF)' }, 400); }
  if (page_count === 0) return json({ error: 'PDF has no pages' }, 400);
  const db = svc();
  if (replace_document_id) {
    const { data: existing } = await db.from('esign_documents').select('*').eq('id', replace_document_id).maybeSingle();
    if (existing) {
      const up = await db.storage.from(BUCKET).upload(existing.storage_path, bytes, { contentType: 'application/pdf', upsert: true });
      if (up.error) return json({ error: 'storage upload failed: ' + up.error.message }, 500);
      await db.from('esign_documents').update({ name: name || existing.name, page_count, page_sizes }).eq('id', existing.id);
      return json({ document_id: existing.id, name: name || existing.name, page_count, page_sizes, replaced: true });
    }
  }
  const isLibrary = !!body.library;
  const docId = crypto.randomUUID();
  const path = `documents/${docId}.pdf`;
  const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true });
  if (up.error) return json({ error: 'storage upload failed: ' + up.error.message }, 500);
  const { data: row, error: insErr } = await db.from('esign_documents').insert({
    id: docId, name: name || 'Uploaded document', storage_path: path,
    page_count, page_sizes, source: 'upload', is_library: isLibrary,
    contact_id: isLibrary ? null : (contact_id ?? null), request_id: isLibrary ? null : (request_id ?? null), created_by: adm.userId
  }).select().single();
  if (insErr) { await db.storage.from(BUCKET).remove([path]); return json({ error: insErr.message }, 400); }
  return json({ document_id: row.id, name: row.name, page_count, page_sizes, is_library: isLibrary });
}

async function docUrl(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: doc } = await db.from('esign_documents').select('*').eq('id', body.document_id).maybeSingle();
  if (!doc) return json({ error: 'document not found' }, 404);
  const signed = await db.storage.from(BUCKET).createSignedUrl(doc.storage_path, 60 * 60);
  if (signed.error) return json({ error: 'could not sign url: ' + signed.error.message }, 500);
  return json({ url: signed.data.signedUrl, name: doc.name, page_count: doc.page_count, page_sizes: doc.page_sizes });
}

async function listDocuments(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  let q = db.from('esign_documents').select('id,name,page_count,created_at,request_id').eq('is_library', false).order('created_at', { ascending: false });
  if (body.contact_id) q = q.eq('contact_id', body.contact_id);
  if (body.only_unsent !== false) q = q.is('request_id', null);
  const { data: docs } = await q;
  const out: any[] = [];
  for (const d of (docs || [])) {
    const { count } = await db.from('esign_fields').select('id', { count: 'exact', head: true }).eq('document_id', d.id);
    out.push({ document_id: d.id, name: d.name, page_count: d.page_count, field_count: count || 0, created_at: d.created_at });
  }
  return json({ documents: out });
}

async function libraryList(req: Request, _body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: docs } = await db.from('esign_documents').select('id,name,page_count,page_sizes,created_at').eq('is_library', true).order('created_at', { ascending: false });
  const out: any[] = [];
  for (const d of (docs || [])) {
    const { count } = await db.from('esign_fields').select('id', { count: 'exact', head: true }).eq('document_id', d.id);
    out.push({ document_id: d.id, name: d.name, page_count: d.page_count, page_sizes: d.page_sizes, field_count: count || 0, created_at: d.created_at });
  }
  return json({ documents: out });
}

async function librarySave(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: src } = await db.from('esign_documents').select('*').eq('id', body.document_id).maybeSingle();
  if (!src) return json({ error: 'document not found' }, 404);
  if (src.is_library) {
    if (body.name) await db.from('esign_documents').update({ name: String(body.name) }).eq('id', src.id);
    return json({ ok: true, document_id: src.id, already_library: true });
  }
  const dl = await db.storage.from(BUCKET).download(src.storage_path);
  if (dl.error || !dl.data) return json({ error: 'could not load source PDF' }, 500);
  const bytes = new Uint8Array(await dl.data.arrayBuffer());
  const newId = crypto.randomUUID();
  const path = `documents/${newId}.pdf`;
  const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true });
  if (up.error) return json({ error: 'library save upload failed: ' + up.error.message }, 500);
  const { data: row, error: insErr } = await db.from('esign_documents').insert({
    id: newId, name: body.name || src.name, storage_path: path,
    page_count: src.page_count, page_sizes: src.page_sizes, source: 'upload', is_library: true,
    contact_id: null, request_id: null, created_by: adm.userId
  }).select().single();
  if (insErr) { await db.storage.from(BUCKET).remove([path]); return json({ error: insErr.message }, 400); }
  const { data: fields } = await db.from('esign_fields').select('signer_index,type,page,x,y,w,h,required,fill_by,value').eq('document_id', src.id);
  if (fields && fields.length) {
    await db.from('esign_fields').insert(fields.map((f: any) => ({ ...f, document_id: newId })));
  }
  return json({ ok: true, document_id: row.id, field_count: (fields || []).length });
}

async function libraryRemove(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: doc } = await db.from('esign_documents').select('*').eq('id', body.document_id).eq('is_library', true).maybeSingle();
  if (!doc) return json({ ok: true, note: 'not a library document' });
  try { await db.storage.from(BUCKET).remove([doc.storage_path]); } catch (_e) { /* best effort */ }
  await db.from('esign_fields').delete().eq('document_id', doc.id);
  await db.from('esign_documents').delete().eq('id', doc.id);
  return json({ ok: true });
}

async function cloneDocument(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: src } = await db.from('esign_documents').select('*').eq('id', body.document_id).maybeSingle();
  if (!src) return json({ error: 'source document not found' }, 404);
  const dl = await db.storage.from(BUCKET).download(src.storage_path);
  if (dl.error || !dl.data) return json({ error: 'could not load source PDF' }, 500);
  const bytes = new Uint8Array(await dl.data.arrayBuffer());
  const newId = crypto.randomUUID();
  const path = `documents/${newId}.pdf`;
  const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true });
  if (up.error) return json({ error: 'clone upload failed: ' + up.error.message }, 500);
  const { data: row, error: insErr } = await db.from('esign_documents').insert({
    id: newId, name: body.name || src.name, storage_path: path,
    page_count: src.page_count, page_sizes: src.page_sizes, source: 'upload', is_library: false,
    contact_id: body.contact_id ?? null, request_id: body.request_id ?? null, created_by: adm.userId
  }).select().single();
  if (insErr) { await db.storage.from(BUCKET).remove([path]); return json({ error: insErr.message }, 400); }
  const { data: fields } = await db.from('esign_fields').select('signer_index,type,page,x,y,w,h,required,fill_by,value').eq('document_id', src.id);
  if (fields && fields.length) {
    const rows = fields.map((f: any) => ({ ...f, document_id: newId }));
    const { error: fErr } = await db.from('esign_fields').insert(rows);
    if (fErr) return json({ error: 'cloned doc but fields failed: ' + fErr.message }, 500);
  }
  return json({ document_id: row.id, name: row.name, page_count: row.page_count, page_sizes: row.page_sizes, field_count: (fields || []).length });
}

async function deleteDocument(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: doc } = await db.from('esign_documents').select('*').eq('id', body.document_id).maybeSingle();
  if (!doc) return json({ error: 'document not found' }, 404);
  try { await db.storage.from(BUCKET).remove([doc.storage_path]); } catch (_e) { /* best effort */ }
  await db.from('esign_documents').delete().eq('id', doc.id);
  return json({ ok: true });
}

async function saveFields(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { document_id, fields } = body;
  if (!document_id || !Array.isArray(fields)) return json({ error: 'document_id and fields[] required' }, 400);
  const { data: doc } = await db.from('esign_documents').select('id').eq('id', document_id).maybeSingle();
  if (!doc) return json({ error: 'document not found' }, 404);
  const allowed = ['signature','initials','date','name','ssn_last4','text','number'];
  const rows = fields.map((f: any) => {
    const t = normType(f.type);
    let fillBy = 'signer';
    if (f.fill_by === 'sender' || f.fill_by === 'merge') fillBy = f.fill_by;
    const hasVal = (fillBy === 'sender' || fillBy === 'merge') && f.value != null && String(f.value) !== '';
    return {
      document_id, signer_index: Math.max(1, parseInt(f.signer_index ?? 1) || 1),
      type: allowed.includes(t) ? t : 'text', fill_by: fillBy,
      value: hasVal ? String(f.value) : null,
      page: Math.max(1, parseInt(f.page ?? 1) || 1),
      x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h), required: f.required !== false
    };
  }).filter((r: any) => [r.x, r.y, r.w, r.h].every((n: number) => Number.isFinite(n)));
  await db.from('esign_fields').delete().eq('document_id', document_id);
  if (rows.length) { const { error } = await db.from('esign_fields').insert(rows); if (error) return json({ error: error.message }, 400); }
  return json({ ok: true, count: rows.length });
}

async function getFields(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: doc } = await db.from('esign_documents').select('*').eq('id', body.document_id).maybeSingle();
  if (!doc) return json({ error: 'document not found' }, 404);
  const { data: fields } = await db.from('esign_fields').select('*').eq('document_id', body.document_id).order('page').order('created_at');
  return json({ document: { id: doc.id, name: doc.name, page_count: doc.page_count, page_sizes: doc.page_sizes }, fields: fields || [] });
}

async function resolveMerge(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const map = await fetchMergeMap(db, body.contact_id || null, body.lender_id || null);
  return json({ ok: true, merge: map, tags: MERGE_TAGS });
}

async function drawPreview(pdfBytes: Uint8Array, fields: any[], nameFor: (i: number) => string, mergeMap: Record<string,string> = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  const today = new Date().toLocaleDateString('en-US');
  for (const f of fields) {
    const idx = (Number(f.page) || 1) - 1;
    if (idx < 0 || idx >= pages.length) continue;
    const page = pages[idx];
    const { width: PW, height: PH } = page.getSize();
    const x = Number(f.x) * PW, w = Number(f.w) * PW, h = Number(f.h) * PH;
    const yPdf = PH - (Number(f.y) * PH) - h;
    const sName = nameFor(Number(f.signer_index) || 1);
    const t = normType(f.type);
    const fillBy = (f.fill_by === 'sender' || f.fill_by === 'merge') ? f.fill_by : 'signer';
    const rawVal = (f.value != null ? String(f.value) : '');
    const mergedVal = fillBy === 'merge' ? resolveTags(rawVal, mergeMap) : rawVal;
    page.drawRectangle({ x, y: yPdf, width: w, height: h, color: rgb(0.98, 0.94, 0.80), opacity: 0.55, borderColor: rgb(0.79, 0.66, 0.30), borderWidth: 0.75 });
    let text = ''; let font = reg; let color = rgb(0.10, 0.10, 0.42);
    if (fillBy === 'sender' || fillBy === 'merge') {
      if (mergedVal) { text = mergedVal; color = rgb(0.1,0.1,0.1); }
      else { text = fillBy === 'merge' ? (rawVal || 'merge') : (t === 'number' ? 'Number' : 'Text'); font = italic; color = rgb(0.5,0.5,0.5); }
    }
    else if (t === 'signature') { text = sName; font = italic; }
    else if (t === 'initials') { text = sName.split(/\s+/).map((p: string) => p[0] || '').join('').toUpperCase(); font = italic; }
    else if (t === 'date') { text = today; }
    else if (t === 'name') { text = sName; }
    else if (t === 'ssn_last4') { text = 'XXX-XX-0000'; }
    else if (t === 'text' || t === 'number') { text = (t === 'number' ? 'Number' : 'Text'); font = italic; color = rgb(0.5,0.5,0.5); }
    else { text = sName; }
    const maxLines = Math.max(1, Math.floor(h / 9));
    let ts = Math.min(h * 0.62, 14);
    if ((fillBy === 'sender' || fillBy === 'merge') && mergedVal && font.widthOfTextAtSize(text, ts) > w - 4) {
      ts = Math.min(9, h / Math.min(maxLines, 3));
      const lines = wrapText(text, font, ts, w - 4).slice(0, maxLines);
      const lineH = ts * 1.12;
      let ly = yPdf + h - lineH;
      for (const ln of lines) { page.drawText(ln, { x: x + 2, y: ly, size: ts, font, color }); ly -= lineH; }
      continue;
    }
    while (ts > 5 && font.widthOfTextAtSize(text, ts) > w - 4) ts -= 0.5;
    page.drawText(text, { x: x + 2, y: yPdf + (h - ts) / 2 + ts * 0.12, size: ts, font, color });
  }
  return await pdf.save();
}

async function drawFinal(pdfBytes: Uint8Array, fields: any[], signerForIndex: (i: number) => any, mergeMap: Record<string,string> = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const oblique = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const script = await embedScript(pdf, oblique);
  const pages = pdf.getPages();
  const INK = rgb(0.08, 0.10, 0.32);
  const BLACK = rgb(0.10, 0.10, 0.10);
  for (const f of fields) {
    const idx = (Number(f.page) || 1) - 1;
    if (idx < 0 || idx >= pages.length) continue;
    const page = pages[idx];
    const { width: PW, height: PH } = page.getSize();
    const x = Number(f.x) * PW, w = Number(f.w) * PW, h = Number(f.h) * PH;
    const yPdf = PH - (Number(f.y) * PH) - h;
    const t = normType(f.type);
    const fillBy = (f.fill_by === 'sender' || f.fill_by === 'merge') ? f.fill_by : 'signer';
    const signer = signerForIndex(Number(f.signer_index) || 1) || {};
    const fv = (signer.field_values && typeof signer.field_values === 'object') ? signer.field_values : {};
    const dateStr = signer.signed_at ? new Date(signer.signed_at).toLocaleDateString('en-US') : '';

    if (fillBy === 'sender' || fillBy === 'merge') {
      const raw = (f.value != null ? String(f.value) : '');
      const text = fillBy === 'merge' ? resolveTags(raw, mergeMap) : raw;
      if (!text) continue;
      const maxLines = Math.max(1, Math.floor(h / 9));
      let ts = Math.min(h * 0.7, 14);
      if (reg.widthOfTextAtSize(text, ts) > w - 4) {
        ts = Math.min(9, h / Math.min(maxLines, 3));
        const lines = wrapText(text, reg, ts, w - 4).slice(0, maxLines);
        const lineH = ts * 1.12;
        let ly = yPdf + h - lineH;
        for (const ln of lines) { page.drawText(ln, { x: x + 2, y: ly, size: ts, font: reg, color: BLACK }); ly -= lineH; }
      } else {
        page.drawText(text, { x: x + 2, y: yPdf + (h - ts) / 2 + ts * 0.12, size: ts, font: reg, color: BLACK });
      }
      continue;
    }

    if ((t === 'signature' || t === 'initials') && signer.signature_data && signer.signature_type === 'drawn' && /^data:image\//i.test(signer.signature_data)) {
      try {
        const isJpg = /^data:image\/jpe?g/i.test(signer.signature_data);
        const img = isJpg ? await pdf.embedJpg(b64ToBytes(signer.signature_data)) : await pdf.embedPng(b64ToBytes(signer.signature_data));
        let iw = img.width, ih = img.height;
        const r = Math.min(w / iw, h / ih);
        iw *= r; ih *= r;
        page.drawImage(img, { x: x + 1, y: yPdf + (h - ih) / 2, width: iw, height: ih });
        continue;
      } catch (_e) { /* fall through to text */ }
    }

    let text = ''; let font = reg; let color = INK; let cursive = false;
    if (t === 'signature') { text = (signer.signature_type === 'typed' && signer.signature_data) ? String(signer.signature_data) : (signer.name || ''); font = script; cursive = true; }
    else if (t === 'initials') { const base = (fv.initials || signer.name || ''); text = String(base).split(/\s+/).map((p: string) => p[0] || '').join('').toUpperCase(); font = script; cursive = true; }
    else if (t === 'date') { text = dateStr; color = BLACK; }
    else if (t === 'name') { text = signer.name || ''; color = BLACK; }
    else if (t === 'ssn_last4') { const last4 = fv.ssn_last4 ? String(fv.ssn_last4) : '0000'; text = 'XXX-XX-' + last4; color = BLACK; }
    else if (t === 'text' || t === 'number') { text = String(fv[f.id] ?? fv[String(f.id)] ?? ''); color = BLACK; }
    else { text = signer.name || ''; }
    if (!text) continue;
    let ts = cursive ? Math.min(h * 1.35, 26) : Math.min(h * 0.7, 18);
    while (ts > 5 && font.widthOfTextAtSize(text, ts) > w - 4) ts -= 0.5;
    const yText = cursive ? (yPdf + h * 0.5 - ts * 0.34) : (yPdf + (h - ts) / 2 + ts * 0.12);
    page.drawText(text, { x: x + 2, y: yText, size: ts, font, color });
  }
  return await pdf.save();
}

async function stampPreview(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: doc } = await db.from('esign_documents').select('*').eq('id', body.document_id).maybeSingle();
  if (!doc) return json({ error: 'document not found' }, 404);
  const { data: fields } = await db.from('esign_fields').select('*').eq('document_id', doc.id);
  if (!fields || !fields.length) {
    const signed0 = await db.storage.from(BUCKET).createSignedUrl(doc.storage_path, 60 * 30);
    if (signed0.error) return json({ error: signed0.error.message }, 500);
    return json({ url: signed0.data.signedUrl, field_count: 0, no_fields: true });
  }
  const dl = await db.storage.from(BUCKET).download(doc.storage_path);
  if (dl.error || !dl.data) return json({ error: 'could not load original PDF' }, 500);
  const bytes = new Uint8Array(await dl.data.arrayBuffer());
  const names: string[] = Array.isArray(body.signers) ? body.signers : [];
  const nameFor = (i: number) => names[i - 1] || ('Signer ' + i);
  const contactId = body.contact_id || doc.contact_id || null;
  const mergeMap = await fetchMergeMap(db, contactId, body.lender_id || null);
  let out: Uint8Array;
  try { out = await drawPreview(bytes, fields, nameFor, mergeMap); } catch (e: any) { return json({ error: 'stamping failed: ' + (e?.message || 'error') }, 500); }
  const path = `previews/${doc.id}.pdf`;
  const up = await db.storage.from(BUCKET).upload(path, out, { contentType: 'application/pdf', upsert: true });
  if (up.error) return json({ error: 'preview upload failed: ' + up.error.message }, 500);
  const signed = await db.storage.from(BUCKET).createSignedUrl(path, 60 * 30);
  if (signed.error) return json({ error: signed.error.message }, 500);
  return json({ url: signed.data.signedUrl, field_count: fields.length, merge_used: Object.keys(mergeMap).length > 0 });
}

async function buildFinal(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: env } = await db.from('signature_requests').select('*').eq('id', body.envelope_id).maybeSingle();
  if (!env) return json({ error: 'envelope not found' }, 404);
  const { data: docs } = await db.from('esign_documents').select('*').eq('request_id', env.id).eq('source', 'upload').order('sort_order').order('created_at');
  if (!docs || !docs.length) return json({ skip: true, reason: 'no uploaded PDF linked to this envelope' });
  const { data: signers } = await db.from('signature_signers').select('*').eq('request_id', env.id).eq('is_cc', false).order('routing_order');
  const byIndex = (i: number) => (signers || [])[i - 1] || null;

  const mergeMap = await fetchMergeMap(db, env.contact_id || null, (env.merge_data && env.merge_data.lender_id) || null);

  const perDoc: any[] = [];
  const signedBytesList: Uint8Array[] = [];
  for (const doc of docs) {
    const { data: fields } = await db.from('esign_fields').select('*').eq('document_id', doc.id);
    const dl = await db.storage.from(BUCKET).download(doc.storage_path);
    if (dl.error || !dl.data) { perDoc.push({ document_id: doc.id, name: doc.name, error: 'could not load original PDF' }); continue; }
    const bytes = new Uint8Array(await dl.data.arrayBuffer());
    let out: Uint8Array;
    try { out = (fields && fields.length) ? await drawFinal(bytes, fields, byIndex, mergeMap) : bytes; }
    catch (e: any) { perDoc.push({ document_id: doc.id, name: doc.name, error: 'final stamping failed: ' + (e?.message || 'error') }); continue; }
    const path = `signed/${env.id}/${doc.id}.pdf`;
    const up = await db.storage.from(BUCKET).upload(path, out, { contentType: 'application/pdf', upsert: true });
    if (up.error) { perDoc.push({ document_id: doc.id, name: doc.name, error: 'final upload failed: ' + up.error.message }); continue; }
    const signed = await db.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 30);
    const url = signed.error ? null : signed.data.signedUrl;
    await db.from('esign_documents').update({ final_pdf_path: path, final_pdf_url: url }).eq('id', doc.id);
    signedBytesList.push(out);
    perDoc.push({ document_id: doc.id, name: doc.name, path, url, field_count: (fields || []).length });
  }

  let combinedPath: string | null = null, combinedUrl: string | null = null;
  if (signedBytesList.length) {
    try {
      const merged = await PDFDocument.create();
      for (const b of signedBytesList) {
        const src = await PDFDocument.load(b, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        for (const p of pages) merged.addPage(p);
      }
      const mergedBytes = await merged.save();
      const cPath = `signed/${env.id}_combined.pdf`;
      const up = await db.storage.from(BUCKET).upload(cPath, mergedBytes, { contentType: 'application/pdf', upsert: true });
      if (!up.error) {
        combinedPath = cPath;
        const signed = await db.storage.from(BUCKET).createSignedUrl(cPath, 60 * 60 * 24 * 30);
        combinedUrl = signed.error ? null : signed.data.signedUrl;
      }
    } catch (_e) { combinedPath = null; combinedUrl = null; }
  }

  const backPath = combinedPath || (perDoc[0] && perDoc[0].path) || null;
  const backUrl = combinedUrl || (perDoc[0] && perDoc[0].url) || null;
  await db.from('signature_requests').update({ combined_pdf_path: combinedPath, combined_pdf_url: combinedUrl, final_pdf_path: backPath, final_pdf_url: backUrl }).eq('id', env.id);

  return json({ ok: true, documents: perDoc, combined_path: combinedPath, combined_url: combinedUrl, path: backPath, url: backUrl, signers: (signers || []).length });
}

async function finalUrl(req: Request, body: any) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: env } = await db.from('signature_requests').select('id,final_pdf_path,combined_pdf_path,document_title').eq('id', body.envelope_id).maybeSingle();
  if (!env) return json({ error: 'envelope not found' }, 404);
  const combinedPath = env.combined_pdf_path || env.final_pdf_path;
  if (!combinedPath) return json({ error: 'no final PDF for this envelope' }, 404);
  const signedC = await db.storage.from(BUCKET).createSignedUrl(combinedPath, 60 * 60);
  if (signedC.error) return json({ error: signedC.error.message }, 500);
  const base = (env.document_title || 'document').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
  const { data: docs } = await db.from('esign_documents').select('id,name,final_pdf_path,sort_order').eq('request_id', env.id).eq('source','upload').order('sort_order').order('created_at');
  const documents: any[] = [];
  for (const d of (docs || [])) {
    if (!d.final_pdf_path) continue;
    const s = await db.storage.from(BUCKET).createSignedUrl(d.final_pdf_path, 60 * 60);
    documents.push({ document_id: d.id, name: d.name, url: s.error ? null : s.data.signedUrl, filename: (d.name || 'document').replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'') + '_signed.pdf' });
  }
  return json({ url: signedC.data.signedUrl, combined_url: signedC.data.signedUrl, filename: base + '_signed.pdf', documents });
}

async function download(req: Request, body: any) {
  /* STAFF, not admin. This is the action the VOE composer calls to attach the
   * signed Borrower Authorization, and the VA sends VOEs — she is the primary
   * loan-processing user. requireAdmin() refused her with "admin only", so the
   * order was placed and the email never went out.
   *
   * The DB layer was already staff-aware: voe_borrower_auth_request,
   * voe_request_log, voe_email_get, voe_orders_awaiting_reply and voe_log_inbound
   * all admit current_app_role() in ('va','loa','agent','staff'). Only this edge
   * function disagreed, so a guard admitted her to pick the employer and refused
   * her to send — inconsistent by construction.
   *
   * Scoped to THIS action deliberately. requireAdmin() is shared by 15 actions in
   * this file, several of them destructive (delete_document, library_remove) or
   * configuration (save_fields, library_save). Widening the shared helper would
   * grant all of them in one edit; the reported break is the download path. */
  const adm = await requireStaff(req, { what: 'Signed document download' });
  if (!adm.ok) return json({ error: adm.msg }, adm.status || 403);
  const db = svc();
  const { data: env } = await db.from('signature_requests').select('*').eq('id', body.envelope_id).maybeSingle();
  if (!env) return json({ error: 'not found' }, 404);
  const { data: signers } = await db.from('signature_signers').select('*').eq('request_id', env.id).order('routing_order');
  const { data: events } = await db.from('signature_events').select('*').eq('request_id', env.id).order('occurred_at');
  const { data: tpl } = await db.from('signature_templates').select('*').eq('key', env.template_key).maybeSingle();

  const pdf = await PDFDocument.create();
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const script = await embedScript(pdf, italic);
  const GRAY = rgb(0.42, 0.42, 0.42); const DARK = rgb(0.12, 0.12, 0.12); const GOLD = rgb(0.62, 0.50, 0.18);
  const M = 54, PW = 612, PH = 792, CW = PW - M * 2;
  let page = pdf.addPage([PW, PH]); let y = PH - M;
  const ensure = (sp: number) => { if (y - sp < M) { page = pdf.addPage([PW, PH]); y = PH - M; } };
  const text = (str: string, o: any = {}) => {
    const f = o.font || reg, size = o.size || 10, color = o.color || DARK, maxW = (o.maxW || CW) - (o.indent || 0), lh = o.lh || size * 1.4, indent = o.indent || 0;
    for (const para of String(str).split('\n')) {
      for (const ln of wrapText(para, f, size, maxW)) { ensure(lh); page.drawText(ln, { x: M + indent, y: y - size, size, font: f, color }); y -= lh; }
    }
  };
  const gap = (h: number) => { ensure(h); y -= h; };
  const rule = () => { ensure(8); page.drawLine({ start: { x: M, y: y - 2 }, end: { x: PW - M, y: y - 2 }, thickness: 0.5, color: rgb(0.82, 0.82, 0.82) }); y -= 8; };

  text(env.document_title || 'Document', { font: bold, size: 16 });
  gap(4); text('Holder: RFD Group / Rates & Realty', { size: 9, color: GRAY }); gap(8); rule(); gap(4);
  let proseHtml = '';
  if (tpl && tpl.body_html) {
    const lender = env.merge_data?.lender ?? tpl.defaults?.lender ?? '';
    const loan_number = env.merge_data?.loan_number ?? '';
    proseHtml = String(tpl.body_html).replaceAll('{{lender}}', lender).replaceAll('{{loan_number}}', loan_number).split('{{SIGNERS}}')[0];
  } else {
    proseHtml = String(env.document_html || '');
  }
  for (const b of htmlToBlocks(proseHtml)) { if (b === '') gap(5); else { text(b, { size: 10 }); gap(2); } }

  gap(8); rule(); gap(2); text('Signatures', { font: bold, size: 12 }); gap(6);
  for (const s of (signers || [])) {
    if (s.is_cc) continue;
    ensure(64);
    text(s.name + (s.role ? ('   \u00b7   ' + s.role) : ''), { font: bold, size: 10 });
    if (s.email) text(s.email, { size: 8.5, color: GRAY });
    gap(2);
    if (s.status === 'signed' && s.signature_data) {
      if (s.signature_type === 'typed') { text(String(s.signature_data), { font: script, size: 24, color: rgb(0.1, 0.1, 0.35) }); }
      else {
        try {
          const png = await pdf.embedPng(b64ToBytes(s.signature_data));
          let w = png.width, h = png.height; const r = Math.min(200 / w, 40 / h, 1); w *= r; h *= r;
          ensure(h + 4); page.drawImage(png, { x: M, y: y - h, width: w, height: h }); y -= (h + 2);
        } catch (_e) { text('[signature on file]', { font: italic, size: 11 }); }
      }
    } else { text('(not signed)', { font: italic, size: 9, color: rgb(0.6, 0.3, 0.3) }); }
    const det: string[] = [];
    if (s.signed_at) det.push('Signed: ' + fmtTs(s.signed_at));
    if (s.signed_ip) det.push('IP: ' + s.signed_ip);
    if (s.field_values?.ssn_last4) det.push('SSN: \u2022\u2022\u2022\u2022\u2022 ' + s.field_values.ssn_last4);
    if (det.length) text(det.join('     '), { size: 8, color: GRAY });
    gap(10);
  }

  page = pdf.addPage([PW, PH]); y = PH - M;
  text('Certificate of Completion', { font: bold, size: 18, color: DARK }); gap(6);
  text('Envelope Id: ' + env.id, { size: 9, color: GRAY });
  text('Subject: ' + (env.document_title || ''), { size: 9, color: GRAY });
  text('Status: ' + String(env.status || '').toUpperCase(), { size: 9, color: GOLD });
  text('Holder: RFD Group / Rates & Realty  \u00b7  ' + OWNER_EMAIL, { size: 9, color: GRAY });
  gap(8); rule(); gap(2);
  text('Record Tracking', { font: bold, size: 11 }); gap(4);
  text('Created: ' + fmtTs(env.created_at), { size: 9 });
  if (env.completed_at) text('Completed: ' + fmtTs(env.completed_at), { size: 9 });
  if (env.voided_at) text('Cancelled: ' + fmtTs(env.voided_at) + (env.void_reason ? ('  \u2014  ' + env.void_reason) : ''), { size: 9 });
  gap(8); rule(); gap(2);
  text('Signer Events', { font: bold, size: 11 }); gap(4);
  const evOf = (sid: string, type: string) => { const e = (events || []).find((x: any) => x.signer_id === sid && x.event_type === type); return e ? fmtTs(e.occurred_at) + (e.ip ? '  \u00b7  IP ' + e.ip : '') : '\u2014'; };
  for (const s of (signers || [])) {
    if (s.is_cc) continue;
    ensure(56);
    text(s.name, { font: bold, size: 10 });
    text((s.email || '') + (s.role ? ('  \u00b7  ' + s.role) : ''), { size: 8.5, color: GRAY });
    text('Sent: ' + evOf(s.id, 'sent'), { size: 8.5 });
    text('Viewed: ' + evOf(s.id, 'viewed'), { size: 8.5 });
    text('Signed: ' + evOf(s.id, 'signed'), { size: 8.5 });
    text('Authentication: Email delivery, unique tokenized link', { size: 8, color: GRAY });
    gap(7);
  }
  const ccs = (signers || []).filter((s: any) => s.is_cc);
  ensure(30); rule(); gap(2); text('Carbon Copy Events', { font: bold, size: 11 }); gap(4);
  text(PROCESSING_EMAIL + '  \u00b7  copied on completion', { size: 8.5 });
  for (const c of ccs) text((c.email || '') + '  \u00b7  cc', { size: 8.5 });
  gap(8); rule(); gap(2);
  text('Envelope Summary Events', { font: bold, size: 11 }); gap(4);
  for (const e of (events || [])) {
    text(fmtTs(e.occurred_at) + '   ' + humanizeEvent(e.event_type) + (e.actor ? ('  \u00b7  ' + e.actor) : '') + (e.ip ? ('  \u00b7  IP ' + e.ip) : ''), { size: 8.5, color: rgb(0.3, 0.3, 0.3) });
  }
  gap(8); rule(); gap(2);
  text('Electronic Record and Signature Disclosure', { font: bold, size: 11 }); gap(4);
  text(DISCLOSURE, { size: 8.5, color: GRAY, lh: 12 });
  gap(8);
  const signedHtml = String(env.document_html || '');
  const hash = env.document_hash || await sha256Hex(signedHtml);
  text('Document integrity (SHA-256):', { size: 8.5, color: GRAY });
  text(hash, { size: 7.5, color: GRAY });

  const out = await pdf.save();
  const path = `signed/${env.id}_record.pdf`;
  const up = await db.storage.from(BUCKET).upload(path, out, { contentType: 'application/pdf', upsert: true });
  if (up.error) return json({ error: 'could not save signed PDF: ' + up.error.message }, 500);
  const signed = await db.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
  if (signed.error) return json({ error: signed.error.message }, 500);
  const fname = (env.document_title || 'document').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') + '_record.pdf';
  return json({ url: signed.data.signedUrl, filename: fname });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || new URL(req.url).searchParams.get('action');
    switch (action) {
      case 'upload': return await upload(req, body);
      case 'doc_url': return await docUrl(req, body);
      case 'list_documents': return await listDocuments(req, body);
      case 'library_list': return await libraryList(req, body);
      case 'library_save': return await librarySave(req, body);
      case 'library_remove': return await libraryRemove(req, body);
      case 'clone_document': return await cloneDocument(req, body);
      case 'delete_document': return await deleteDocument(req, body);
      case 'save_fields': return await saveFields(req, body);
      case 'get_fields': return await getFields(req, body);
      case 'resolve_merge': return await resolveMerge(req, body);
      case 'stamp_preview': return await stampPreview(req, body);
      case 'build_final': return await buildFinal(req, body);
      case 'final_url': return await finalUrl(req, body);
      case 'download': return await download(req, body);
      default: return json({ error: 'unknown action', actions: ['upload','doc_url','list_documents','library_list','library_save','library_remove','clone_document','delete_document','save_fields','get_fields','resolve_merge','stamp_preview','build_final','final_url','download'] }, 400);
    }
  } catch (e: any) {
    return json({ error: e?.message || 'error' }, 500);
  }
});
