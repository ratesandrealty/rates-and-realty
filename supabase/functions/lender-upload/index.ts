import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

// ── lender-upload ────────────────────────────────────────────────────────────
// Token-gated mint endpoint for outside-lender guideline uploads.
//
// Replaces the old lender-form.html path, which POSTed the file straight at
// /storage/v1/object/lender-guidelines/... with `Bearer <SUPABASE_ANON_KEY>`.
// That only worked because the bucket carried INSERT/UPDATE policies granted TO
// public, i.e. anyone on the internet could write AND overwrite any object in
// the bucket. This function is the gate that lets those policies be locked to
// `authenticated`:
//
//   mint     → validate form_token, build the path SERVER-SIDE inside that
//              lender's own prefix, return a signed upload URL for that one path.
//   finalize → validate form_token again, confirm the object really landed
//              inside that lender's prefix, then insert the lender_guidelines
//              row with the service role.
//
// The client never chooses the storage path and never sees a key. An invalid,
// unknown, or blank token mints nothing.
//
// verify_jwt MUST stay false: outside lenders have no Supabase session. The
// form_token IS the credential. Every branch below therefore re-validates it.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

const BUCKET = 'lender-guidelines';

// Mirrors the bucket's allowed_mime_types. Checked here too so a bad type fails
// with a clear message at mint time instead of a bare 415 from storage later.
const ALLOWED_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/msword': 'doc',
  'image/jpeg': 'jpg',
  'image/png': 'png'
};

// Bucket file_size_limit is 50MB; reject earlier so the lender gets a real message.
const MAX_BYTES = 50 * 1024 * 1024;

// Abuse cap: a valid token is still an unauthenticated credential. One lender
// cannot flood the bucket beyond this many uploads per rolling hour.
const MAX_UPLOADS_PER_HOUR = 25;

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

function safeName(raw: string): string {
  // Strip any path structure the client tried to smuggle in, then reduce to a
  // conservative charset. Path traversal is impossible anyway because we only
  // ever concatenate this onto a server-chosen prefix, but keep it clean.
  const base = String(raw || 'file').split(/[\\/]/).pop() || 'file';
  return (base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._]+/, '') || 'file').slice(-120);
}

// Resolve a form_token to its lender. Single source of truth for "is this
// caller allowed to touch anything at all", used by every action.
async function lenderForToken(token: unknown) {
  if (typeof token !== 'string') return null;
  const t = token.trim();
  // form_token is a 36-char UUID-shaped hex string from 16 CSPRNG bytes.
  // Refuse anything that isn't shaped like one so a blank/short/garbage value
  // can never reach the DB as a wildcard-ish filter.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return null;
  const { data, error } = await sb
    .from('lenders')
    .select('id,name,form_token')
    .eq('form_token', t)
    .maybeSingle();
  if (error || !data || !data.form_token) return null;
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const ok = (d: unknown) =>
    new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) =>
    new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  if (req.method !== 'POST') return err('Method not allowed', 405);

  try {
    let body: Record<string, unknown> = {};
    try {
      const text = await req.text();
      if (text && text.trim().startsWith('{')) body = JSON.parse(text);
    } catch (_) { /* fall through to the action check below */ }

    const action = String(body.action || '');

    // ── mint ────────────────────────────────────────────────────────────────
    // Validate the token, then hand back a signed upload URL for exactly one
    // path inside that lender's prefix.
    if (action === 'mint') {
      const lender = await lenderForToken(body.token);
      if (!lender) return err('Invalid or unrecognized upload link', 403);

      const mime = String(body.content_type || '');
      if (!ALLOWED_MIME[mime]) {
        return err('Unsupported file type. Allowed: PDF, Word, Excel, JPG, PNG.', 415);
      }

      const size = Number(body.size || 0);
      if (size > MAX_BYTES) return err('File too large (50MB max).', 413);

      const since = new Date(Date.now() - 3600_000).toISOString();
      const { count } = await sb
        .from('lender_guidelines')
        .select('id', { count: 'exact', head: true })
        .eq('lender_id', lender.id)
        .gte('created_at', since);
      if ((count || 0) >= MAX_UPLOADS_PER_HOUR) {
        return err('Too many uploads in the last hour. Please try again later.', 429);
      }

      // Path is chosen HERE, never by the caller. Anchored to lender.id, which
      // came from the token lookup — so a signed URL can only ever write into
      // the prefix belonging to the token's own lender.
      const path = `${lender.id}/${Date.now()}_${safeName(String(body.file_name || ''))}`;

      const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error || !data) return err('Could not prepare upload: ' + (error?.message || 'unknown'), 500);

      return ok({
        success: true,
        path,
        signed_url: data.signedUrl,
        token: data.token,
        lender_id: lender.id
      });
    }

    // ── finalize ────────────────────────────────────────────────────────────
    // Called after the PUT succeeds. Re-validates the token, proves the object
    // exists inside this lender's prefix, then writes the row. Doing the insert
    // here (service role) also fixes a second silent failure: the old client
    // INSERT into lender_guidelines with the anon key was already being denied
    // by RLS (42501), so lender uploads landed in storage but never registered.
    if (action === 'finalize') {
      const lender = await lenderForToken(body.token);
      if (!lender) return err('Invalid or unrecognized upload link', 403);

      const path = String(body.path || '');
      const prefix = `${lender.id}/`;
      // Re-derive the authorization decision from the token, not from the path.
      if (!path.startsWith(prefix) || path.includes('..')) {
        return err('Path outside this lender\'s scope', 403);
      }

      // Confirm the object actually exists before creating a row that points at
      // it — otherwise a caller could register arbitrary file_url values.
      const objName = path.slice(prefix.length);
      const { data: listed } = await sb.storage.from(BUCKET).list(lender.id, {
        limit: 1,
        search: objName
      });
      if (!listed || !listed.some((o) => o.name === objName)) {
        return err('Uploaded file not found in storage', 404);
      }

      // file_name is lender-supplied and gets interpolated into innerHTML by the
      // admin doc lists (lenders.html, guideline-ai.html) without escaping, so
      // strip HTML-significant characters here at the point of trust rather than
      // relying on every downstream renderer. Spaces/parens stay for readability.
      const displayName = String(body.file_name || objName)
        .replace(/[<>"'`\\]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300) || objName;
      const fileName = safeName(displayName);
      const publicUrl = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/${BUCKET}/${path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;

      const { data: row, error: insErr } = await sb
        .from('lender_guidelines')
        .insert({
          lender_id: lender.id,
          file_name: displayName,
          file_url: publicUrl,
          storage_path: path,
          source_type: 'lender',
          ocr_status: 'pending',
          upload_source: 'lender_portal',
          is_active: true,
          title: fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || fileName,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select('id')
        .single();

      if (insErr) return err('Could not record upload: ' + insErr.message, 500);
      return ok({ success: true, id: row?.id, path, file_url: publicUrl });
    }

    // ── list ────────────────────────────────────────────────────────────────
    // The "Previously uploaded" panel used an anon-key REST select against
    // lender_guidelines, which RLS answers with [] (the table's only policy is
    // admin_all_lender_guidelines). So the panel silently rendered nothing.
    // Serve it here instead, scoped by the token's own lender_id.
    if (action === 'list') {
      const lender = await lenderForToken(body.token);
      if (!lender) return err('Invalid or unrecognized upload link', 403);

      const { data, error } = await sb
        .from('lender_guidelines')
        .select('id,file_name,file_url,created_at')
        .eq('lender_id', lender.id)
        .neq('is_active', false)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) return err(error.message, 500);
      return ok({ success: true, docs: data || [] });
    }

    return err('Unknown action');
  } catch (e) {
    console.error('[lender-upload] error:', e);
    return err((e as Error)?.message || 'Server error', 500);
  }
});
