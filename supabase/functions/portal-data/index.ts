import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * portal-data edge function
 * Serves all data needed by the borrower portal + CRM showings page
 * Uses service role key — bypasses Cloudflare Worker API key interception
 *
 * Actions:
 * - get_showings: fetch showings by portal_user_id, email, or borrower_id
 * - get_application: fetch mortgage application by email/borrower_id/portal_user_id
 * - get_saved_homes: fetch saved listings
 * - get_all_showings: fetch all showings (admin CRM use)
 * - get_documents: fetch uploaded documents for the portal_user's own contact
 *   (portal_user_id ONLY since 2026-08-12 — contact_id/email/lead_id are no
 *   longer accepted as identity; see the block comment on the action)
 */

/* ── CALLER SCOPING FOR THE SHOWINGS ACTIONS ───────────────────────────────
 *
 * SAY IT PLAINLY: this is NARROWING, not authentication. The portal issues no
 * session, so nothing in this function can tell a signed-in borrower from
 * anyone who knows the right uuid or email address. Only the Supabase Auth
 * migration fixes that — docs/PORTAL-IDENTITY-2026-08-12.md.
 *
 * What it DOES buy, today: the write actions below can only touch rows that
 * match the caller's own portal_user_id or email. The path they replace —
 * unified-portal.html PATCHing /rest/v1/showings directly with the public anon
 * key — could touch ANY row, with no identity supplied at all. That is the
 * difference this makes, and it is worth having on its own.
 *
 * IT MATCHES ON EITHER portal_user_id OR email, deliberately. Only 16 of 41
 * showings carry a portal_user_id; all 41 carry an email. Scoping on
 * portal_user_id alone would silently make 25 rows unmanageable from the portal,
 * which is how a security change turns into a support ticket nobody connects
 * back to it. get_showings already ORs the same two fields.
 *
 * BOTH INPUTS ARE VALIDATED BEFORE THEY REACH A FILTER STRING. PostgREST's
 * `or=` takes a comma-separated expression, so an unvalidated email containing
 * a comma or a quote would let the caller rewrite the predicate and widen their
 * own scope. Anything not matching these shapes is refused rather than escaped. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s,"'()]+@[^\s,"'()]+\.[^\s,"'()]+$/;

/* Returns the query narrowed to the caller, or null when no usable identity was
   supplied — the caller must treat null as a refusal, never as "no filter". */
function scopeToCaller(q: any, body: any): any | null {
  const pid = String(body?.portal_user_id || '').trim();
  const em = String(body?.email || '').toLowerCase().trim();
  const okPid = pid && UUID_RE.test(pid);
  const okEm = em && EMAIL_RE.test(em);
  if (okPid && okEm) return q.or(`portal_user_id.eq.${pid},email.eq."${em}"`);
  if (okPid) return q.eq('portal_user_id', pid);
  if (okEm) return q.eq('email', em);
  return null;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const url = new URL(req.url);
    const contentType = req.headers.get('content-type') || '';
    const qsAction = url.searchParams.get('action');

    // ─── UPLOAD DOCUMENT (multipart/form-data) ───────────────────────────
    // Client posts FormData with fields: file, contact_id, portal_user_id, category
    if (req.method === 'POST' && contentType.includes('multipart/form-data')) {
      if (qsAction !== 'upload_document') return err('Unsupported multipart action');
      const form = await req.formData();
      const file = form.get('file') as File | null;
      if (!file) return err('file required');
      const portal_user_id = (form.get('portal_user_id') as string) || '';
      let contact_id = (form.get('contact_id') as string) || '';
      const category = (form.get('category') as string) || 'general';

      // Resolve contact_id from portal_user_id if missing
      if (!contact_id && portal_user_id) {
        const { data: pu } = await sb.from('portal_users').select('contact_id').eq('id', portal_user_id).maybeSingle();
        if (pu?.contact_id) contact_id = pu.contact_id;
      }
      if (!contact_id) return err('Could not resolve contact_id', 400);

      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');

      /* SERVER-SIDE DUPLICATE CHECK.
       *
       * The client guard below stops the double-tap, but it cannot stop the case
       * that actually matters: a borrower on a phone with a flaky connection
       * whose upload succeeded while the response was lost, who then reloads and
       * sends the same file again. By then the client's in-flight state is gone.
       * Only the server still knows.
       *
       * Matched on (contact_id, file_name, file_size) within 10 minutes —
       * identical name AND identical byte count from the same borrower in that
       * window is a retry, not a second document. A genuinely different file
       * differs in size; a genuinely re-sent one is the same file and does not
       * need storing twice. */
      const DUP_WINDOW_MIN = 10;
      const dupSince = new Date(Date.now() - DUP_WINDOW_MIN * 60_000).toISOString();
      const { data: dupRow } = await sb.from('uploaded_documents')
        .select('id, file_path, uploaded_at')
        .eq('contact_id', contact_id)
        .eq('file_name', file.name)
        .eq('file_size', file.size)
        .gte('uploaded_at', dupSince)
        .order('uploaded_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (dupRow) {
        console.log('[portal-data] duplicate upload suppressed:', contact_id, file.name, file.size);
        const { data: sd } = await sb.storage.from('borrower-documents').createSignedUrl(dupRow.file_path, 3600);
        // 200, not an error: from the borrower's side the file IS on their file.
        return ok({ success: true, duplicate: true, document_id: dupRow.id, file_url: sd?.signedUrl || null,
                    message: 'That file is already uploaded.' });
      }

      const storage_path = `${contact_id}/${Date.now()}_${safeName}`;
      const bytes = new Uint8Array(await file.arrayBuffer());

      const { error: upErr } = await sb.storage
        .from('borrower-documents')
        .upload(storage_path, bytes, { contentType: file.type || 'application/octet-stream', upsert: true });
      if (upErr) return err('Storage upload failed: ' + upErr.message, 500);

      // Private bucket: persist the PATH only (never a public/signed URL). Sign a short-lived
      // URL just for the immediate response so the just-uploaded doc renders without a reload.
      const { data: signedNew } = await sb.storage.from('borrower-documents').createSignedUrl(storage_path, 3600);
      const file_url = signedNew?.signedUrl || null;

      const { data: inserted, error: dbErr } = await sb.from('uploaded_documents').insert({
        contact_id,
        document_type: category,
        type: category,
        file_name: file.name,
        file_path: storage_path,
        file_url: null,
        file_size: file.size,
        status: 'received',
        uploaded_at: new Date().toISOString(),
      }).select().maybeSingle();
      if (dbErr) return err('DB insert failed: ' + dbErr.message, 500);

      // Trigger gdrive-sync synchronously with an 8s timeout so the doc
      // lands in Drive before the upload response returns. Failures here
      // are non-fatal — the DB row is already saved and a later
      // sync_all_pending run will pick it up.
      try {
        const syncUrl = Deno.env.get('SUPABASE_URL') + '/functions/v1/gdrive-sync';
        const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        try {
          await fetch(syncUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + serviceKey },
            body: JSON.stringify({ action: 'sync_document', document_id: inserted?.id }),
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (syncErr: any) {
        console.warn('[portal-data] gdrive-sync trigger failed (non-fatal):', syncErr?.message);
      }

      return ok({ success: true, document: inserted, file_url });
    }

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const action = body.action || qsAction;

    // ─── GET SHOWINGS (portal) ───────────────────────────────────────────
    if (action === 'get_showings') {
      const { portal_user_id, email, borrower_id } = body;
      if (!portal_user_id && !email && !borrower_id) return err('portal_user_id, email or borrower_id required');

      let query = sb.from('showings').select('*').order('created_at', { ascending: false });

      if (portal_user_id) {
        query = sb.from('showings').select('*')
          .or(`portal_user_id.eq.${portal_user_id},email.eq.${email || ''},borrower_id.eq.${borrower_id || ''}`)
          .order('created_at', { ascending: false });
      } else if (email) {
        query = sb.from('showings').select('*')
          .eq('email', email.toLowerCase().trim())
          .order('created_at', { ascending: false });
      } else if (borrower_id) {
        query = sb.from('showings').select('*')
          .eq('borrower_id', borrower_id)
          .order('created_at', { ascending: false });
      }

      const { data, error } = await query;
      if (error) return err(error.message, 500);
      return ok({ showings: data || [], count: data?.length || 0 });
    }

    // ─── GET ALL SHOWINGS (CRM admin) ────────────────────────────────────
    /* REMOVED 2026-08-12: action 'get_all_showings'.
     *
     * It took NO identity parameter of any kind — not a weak check, none — and
     * returned up to 200 showings joined to contacts(first_name, last_name,
     * email, phone, crm_id). On a verify_jwt=false function using the service
     * role, that was a 200-contact PII dump available to anyone who could POST.
     *
     * It read like a leftover admin action on a public function. Confirmed to
     * have no caller FOUR ways before removal, because "no caller found" has
     * been wrong three times on this project:
     *   - repo grep (html/js/ts/mjs/sql/json), excluding its own file
     *   - all 11 n8n workflows read node-by-node: none calls portal-data at
     *     all; n8n touches only gdrive-proxy, post-close-followups, refi-watch,
     *     critical-date-reminders and email-service
     *   - cron.job: 0 commands reference portal-data
     *   - pg_proc: 0 database functions reference portal-data
     *
     * An unknown action now falls through to the 400 at the end of the handler,
     * so a forgotten caller gets a clear error rather than silence. */

    // ─── GET APPLICATION ─────────────────────────────────────────────────
    if (action === 'get_application') {
      const { email, borrower_id, portal_user_id } = body;
      if (!email && !borrower_id && !portal_user_id) return err('email, borrower_id or portal_user_id required');

      let data = null;

      if (email) {
        const res = await sb.from('mortgage_applications')
          .select('*').or(`email.eq.${email},borrower_email.eq.${email}`)
          .order('updated_at', { ascending: false }).limit(1).maybeSingle();
        data = res.data;
      }
      if (!data && borrower_id) {
        const res = await sb.from('mortgage_applications')
          .select('*').eq('borrower_id', borrower_id)
          .order('updated_at', { ascending: false }).limit(1).maybeSingle();
        data = res.data;
      }
      if (!data && portal_user_id) {
        const res = await sb.from('mortgage_applications')
          .select('*').eq('borrower_user_id', portal_user_id)
          .order('updated_at', { ascending: false }).limit(1).maybeSingle();
        data = res.data;
      }
      return ok({ application: data });
    }

    // ─── SAVE APPLICATION ────────────────────────────────────────────────
    // Bypasses the save_mortgage_application RPC (which doesn't cast text→date
    // properly) and does a direct upsert via the Supabase client.
    if (action === 'save_application') {
      /* IDENTITY: portal_user_id or contact_id ONLY. `email` and `borrower_id`
       * are no longer accepted as identity (2026-08-12).
       *
       * This does NOT authenticate the call — nothing in this function can,
       * because the portal issues no session; see docs/PORTAL-IDENTITY-2026-08-12.md.
       * It raises the bar from "knows a public email address" to "knows a uuid",
       * which is the difference between trivially targetable and not. A
       * mortgage application is the most sensitive record a borrower has here,
       * and `email` made overwriting one a matter of knowing who they are.
       *
       * borrower_id goes too, for the same reason in weaker form: it is the
       * RR- crm id, printed in the welcome email and shown in the portal, so it
       * is closer to public than to secret.
       *
       * SAFE FOR THE ONE CALLER: public/unified-portal.html:1723 already sends
       * portal_user_id alongside email and borrower_id, so nothing needs to
       * change there. The exception is a stale localStorage blob carrying only
       * {email, first_name} (the fallback at unified-portal.html:1089) — that
       * state now fails with a clear instruction instead of silently writing to
       * a record identified by an email address. */
      const { portal_user_id, contact_id: bodyContactId, data: appData } = body;
      if (!portal_user_id && !bodyContactId) {
        return err('portal_user_id or contact_id required — please sign out and sign in again', 400);
      }

      let contact_id: string | null = bodyContactId || null;
      if (!contact_id && portal_user_id) {
        const { data: pu } = await sb.from('portal_users').select('contact_id').eq('id', portal_user_id).maybeSingle();
        if (pu?.contact_id) contact_id = pu.contact_id;
      }
      if (!contact_id) return err('Could not resolve contact from portal_user_id');

      // Clean the payload: strip undefined/null, ensure dates are ISO strings.
      const cleanData: Record<string, any> = {};
      for (const [k, v] of Object.entries(appData || {})) {
        if (v !== null && v !== undefined && v !== '') cleanData[k] = v;
      }
      cleanData.contact_id = contact_id;
      cleanData.updated_at = new Date().toISOString();
      // Do NOT set borrower_user_id — the FK references auth.users and
      // portal_user_id is from portal_users, not auth.users. Sending it
      // causes "violates foreign key constraint mortgage_applications_borrower_user_id_fkey".
      // if (portal_user_id) cleanData.borrower_user_id = portal_user_id;

      /* email and borrower_id are STAMPED FROM THE CONTACT ROW, not from the
       * request body (2026-08-12). They used to be copied straight out of the
       * body. If the caller is not trusted to say who it is, it is not trusted
       * to say what that person's email address is either — otherwise the
       * application record could be written with someone else's contact_id and
       * an attacker-chosen email, and the row would look internally consistent.
       * The contact row is the source of truth for both. */
      const { data: owner } = await sb.from('contacts')
        .select('email, borrower_id').eq('id', contact_id).maybeSingle();
      if (owner?.borrower_id) cleanData.borrower_id = owner.borrower_id;
      if (owner?.email) cleanData.email = owner.email;

      // Check for existing app row.
      const { data: existing } = await sb.from('mortgage_applications')
        .select('id')
        .eq('contact_id', contact_id)
        .order('created_at', { ascending: false })
        .limit(1);
      const existingId = existing?.[0]?.id;

      let result, error;
      if (existingId) {
        delete cleanData.contact_id; // don't re-write immutable FK
        const r = await sb.from('mortgage_applications').update(cleanData).eq('id', existingId).select();
        result = r.data; error = r.error;
      } else {
        cleanData.created_at = new Date().toISOString();
        const r = await sb.from('mortgage_applications').insert(cleanData).select();
        result = r.data; error = r.error;
      }
      if (error) {
        console.error('[portal-data] save_application error:', JSON.stringify(error));
        return err(error.message || error.details || 'Save failed', 500);
      }
      return ok({ success: true, application: result?.[0] || null });
    }

    // ─── GET SAVED HOMES ─────────────────────────────────────────────────
    if (action === 'get_saved_homes') {
      const { portal_user_id, email } = body;
      let { contact_id } = body;
      // Resolve contact_id from portal_user_id so legacy rows (saved before
      // portal_user_id was populated) are still found.
      if (!contact_id && portal_user_id) {
        const { data: pu } = await sb.from('portal_users').select('contact_id').eq('id', portal_user_id).maybeSingle();
        if (pu?.contact_id) contact_id = pu.contact_id;
      }
      const orParts: string[] = [];
      if (portal_user_id) orParts.push(`portal_user_id.eq.${portal_user_id}`);
      if (contact_id) orParts.push(`contact_id.eq.${contact_id}`);
      if (email) orParts.push(`email.eq.${email}`);
      if (!orParts.length) return err('portal_user_id, contact_id or email required');
      const { data, error } = await sb.from('saved_listings')
        .select('*')
        .or(orParts.join(','))
        .order('created_at', { ascending: false });
      if (error) return err(error.message, 500);
      // Return both `homes` (legacy client key) and `saved_homes`.
      return ok({ homes: data || [], saved_homes: data || [] });
    }

    // ─── REMOVE SAVED HOME ───────────────────────────────────────────────
    if (action === 'remove_saved_home') {
      const { id, portal_user_id } = body;
      if (!id) return err('id required');
      let q = sb.from('saved_listings').delete().eq('id', id);
      if (portal_user_id) q = q.eq('portal_user_id', portal_user_id);
      const { error } = await q;
      if (error) return err(error.message, 500);
      return ok({ success: true });
    }

    // ─── GET DOCUMENTS ───────────────────────────────────────────────────
    if (action === 'get_documents') {
      /* ── THIS IS NARROWED, NOT AUTHENTICATED. ──────────────────────────────
       *
       * Say it plainly so nobody reads this as solved: the borrower portal
       * issues NO session — portal-auth returns a user object and nothing else,
       * and the browser keeps it in localStorage. So this function still cannot
       * tell a signed-in borrower from anyone who knows the right uuid. Only the
       * Supabase Auth migration fixes that; see
       * docs/PORTAL-IDENTITY-2026-08-12.md.
       *
       * What changed (2026-08-12) is WHICH uuid you must know.
       *
       * It used to accept a bare `contact_id`, and contact_id is not secret: it
       * is in admin URLs across lead-detail, communications, drip-builder,
       * email-marketing and earnings-dashboard, in Supabase webhooks, and in
       * n8n payloads. `portal_user_id` exists in 4 rows, is returned only by a
       * successful password login, and appears nowhere else in the system.
       *
       * That matters more here than anywhere else in this function, because
       * this action does not just return rows — it mints fresh signed URLs into
       * the private borrower-documents bucket, with the service role, which
       * bypasses that bucket's RLS entirely. Pay stubs, W2s, bank statements,
       * tax returns.
       *
       * `contact_id` and `email` are no longer accepted as identity. The only
       * caller (public/unified-portal.html:2565) already sends portal_user_id
       * alongside contact_id, so this needs no frontend change. */
      const { portal_user_id } = body;
      if (!portal_user_id) {
        return err('portal_user_id required — please sign out and sign in again', 400);
      }
      const { data: pu } = await sb.from('portal_users').select('contact_id').eq('id', portal_user_id).maybeSingle();
      const resolvedContactId = pu?.contact_id || null;
      if (!resolvedContactId) return err('Portal user has no linked contact', 403);

      // Build OR filter to catch all docs for this person.
      // NOTE: portal_user_id is NOT a column on uploaded_documents — it's
      // resolved to contact_id above. Don't add it to the OR filter or the
      // query 500s.
      /* lead_id and borrower_id are taken FROM THE CONTACT ROW, never from the
       * body. They are OR'd into this filter, so a caller-supplied value did not
       * narrow the result — it WIDENED it. Anyone holding one valid
       * portal_user_id could have appended someone else's borrower_id and been
       * handed signed URLs to their documents in the same response. Pinning the
       * identity above is worthless while the filter still trusts the body. */
      /* contacts has borrower_id but NOT lead_id — verified against
       * information_schema, not assumed. uploaded_documents.lead_id therefore
       * has no owner-side value to match, so that leg is dropped entirely rather
       * than left reading from the body. Documents filed only under a lead_id
       * with no contact_id are not reachable here; that is correct until there
       * is an owner-side way to prove the lead belongs to this portal user. */
      const { data: ownerRow } = await sb.from('contacts')
        .select('borrower_id').eq('id', resolvedContactId).maybeSingle();

      const filters: string[] = [`contact_id.eq.${resolvedContactId}`];
      if (ownerRow?.borrower_id) filters.push(`borrower_id.eq.${ownerRow.borrower_id}`);

      const { data, error } = await sb.from('uploaded_documents')
        .select('*')
        .or(filters.join(','))
        .order('uploaded_at', { ascending: false });

      if (error) return err(error.message, 500);

      /* Private bucket: sign each doc's file_path fresh at request time (never
       * return a public or persisted URL). Signed at render so a borrower page
       * left open doesn't accumulate expired links — the next get_documents
       * re-signs. gdrive_file_url (Drive copy) is left as-is.
       *
       * TTL 5 MINUTES, was 1 hour (2026-08-12). These URLs need to survive only
       * the moment between this response and the borrower clicking a link on the
       * page that just rendered. An hour is a long time for a link that carries
       * a pay stub and needs no credential to redeem — every one that reaches a
       * log, a proxy or a shared screenshot stays live for that whole window.
       * The page re-signs on every load, so nothing legitimate breaks. */
      const SIGNED_URL_TTL_SECONDS = 300;
      const docs = data || [];
      await Promise.all(docs.map(async (d: any) => {
        const p = d.file_path || d.storage_path;
        if (p) {
          const { data: s } = await sb.storage.from('borrower-documents').createSignedUrl(p, SIGNED_URL_TTL_SECONDS);
          d.file_url = s?.signedUrl || d.gdrive_file_url || null;
        } else {
          d.file_url = d.gdrive_file_url || null;
        }
      }));
      return ok({ documents: docs });
    }

    // ─── UPDATE SHOWING STATUS ───────────────────────────────────────────
    if (action === 'update_showing_status') {
      const { batch_id, showing_id, status } = body;
      const allowed = ['new', 'pending', 'confirmed', 'completed', 'cancelled'];
      if (!allowed.includes(status)) return err('Invalid status');

      let q = sb.from('showings').update({ status, updated_at: new Date().toISOString() });
      if (batch_id) q = q.eq('batch_id', batch_id);
      else if (showing_id) q = q.eq('id', showing_id);
      else return err('batch_id or showing_id required');

      const { error } = await q;
      if (error) return err(error.message, 500);
      return ok({ success: true, status });
    }

    // ─── GET ANNOTATIONS ─────────────────────────────────────────────────
    /* ── SHOWING MANAGEMENT FOR THE BORROWER PORTAL ──────────────────────
     *
     * These five replace six direct PATCH/GET calls that
     * public/unified-portal.html made against /rest/v1/showings with the public
     * anon key. Those calls are why `showings` still grants anon SELECT and
     * UPDATE: the borrower holds no session, so the borrower IS the anonymous
     * role, and locking the table while the portal read it directly would have
     * removed the feature rather than secured it.
     *
     * Moving them here is step 1 of two, and the order is the rule this repo
     * already learned the hard way with email-service: ship the caller, have it
     * CONFIRMED working, and only then tighten the guard. Step 2 drops
     * public_update_showings and rewrites public_read_showings.
     *
     * EVERY ONE RETURNS THE ROW COUNT IT AFFECTED. A PostgREST write that
     * matches nothing answers 204, exactly as a successful one does, so a caller
     * reading only the status cannot tell a refusal from a save — the same trap
     * that made the anon DELETE probe look like it still worked after the policy
     * closed it. `updated: 0` is the portal's signal that it changed nothing. */

    // Rows in one batch that the caller owns — replaces the "how many are left"
    // read at unified-portal.html:2028.
    if (action === 'get_batch_showings') {
      const { batch_id } = body;
      if (!batch_id || !UUID_RE.test(String(batch_id))) return err('valid batch_id required');
      let q = sb.from('showings').select('id, status, deleted_at, preferred_date, preferred_time')
        .eq('batch_id', batch_id);
      const scoped = scopeToCaller(q, body);
      if (!scoped) return err('portal_user_id or email required');
      const { data, error } = await scoped;
      if (error) return err(error.message, 500);
      const rows = data || [];
      return ok({ showings: rows, count: rows.length, active: rows.filter((r: any) => !r.deleted_at).length });
    }

    // Soft-delete ONE showing — unified-portal.html:2022.
    if (action === 'remove_showing') {
      const { showing_id } = body;
      if (!showing_id || !UUID_RE.test(String(showing_id))) return err('valid showing_id required');
      const now = new Date().toISOString();
      let q = sb.from('showings').update({ deleted_at: now, updated_at: now }).eq('id', showing_id);
      const scoped = scopeToCaller(q, body);
      if (!scoped) return err('portal_user_id or email required');
      const { data, error } = await scoped.select('id');
      if (error) return err(error.message, 500);
      return ok({ success: true, updated: (data || []).length });
    }

    // Cancel a whole batch — unified-portal.html:2031 and :2084.
    if (action === 'cancel_batch') {
      const { batch_id, soft_delete } = body;
      if (!batch_id || !UUID_RE.test(String(batch_id))) return err('valid batch_id required');
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = { status: 'cancelled', updated_at: now };
      /* :2031 cancels the batch when its last home is removed and leaves the
         rows visible; :2084 is the borrower cancelling outright and also stamps
         deleted_at. One action, one explicit flag, rather than two that differ
         by a field nobody would notice. */
      if (soft_delete) patch.deleted_at = now;
      let q = sb.from('showings').update(patch).eq('batch_id', batch_id);
      const scoped = scopeToCaller(q, body);
      if (!scoped) return err('portal_user_id or email required');
      const { data, error } = await scoped.select('id');
      if (error) return err(error.message, 500);
      return ok({ success: true, updated: (data || []).length });
    }

    // Restore a cancelled batch — unified-portal.html:2112.
    if (action === 'restore_batch') {
      const { batch_id } = body;
      if (!batch_id || !UUID_RE.test(String(batch_id))) return err('valid batch_id required');
      let q = sb.from('showings')
        .update({ status: 'pending', deleted_at: null, updated_at: new Date().toISOString() })
        .eq('batch_id', batch_id);
      const scoped = scopeToCaller(q, body);
      if (!scoped) return err('portal_user_id or email required');
      const { data, error } = await scoped.select('id');
      if (error) return err(error.message, 500);
      return ok({ success: true, updated: (data || []).length });
    }

    // Reschedule the live rows in a batch — unified-portal.html:2053.
    if (action === 'reschedule_batch') {
      const { batch_id, preferred_date, preferred_time } = body;
      if (!batch_id || !UUID_RE.test(String(batch_id))) return err('valid batch_id required');
      if (!preferred_date) return err('preferred_date required');
      let q = sb.from('showings')
        .update({
          preferred_date,
          preferred_time: preferred_time || null,
          status: 'pending',
          updated_at: new Date().toISOString(),
        })
        .eq('batch_id', batch_id)
        .is('deleted_at', null);      // a removed home does not come back by rescheduling
      const scoped = scopeToCaller(q, body);
      if (!scoped) return err('portal_user_id or email required');
      const { data, error } = await scoped.select('id');
      if (error) return err(error.message, 500);
      return ok({ success: true, updated: (data || []).length });
    }

    if (action === 'get_annotations') {
      const { document_id } = body;
      if (!document_id) return err('document_id required');
      const { data, error } = await sb.from('document_annotations')
        .select('id, document_id, contact_id, page, x, y, text, font_size, color, created_at, created_by')
        .eq('document_id', String(document_id))
        .order('page', { ascending: true })
        .order('y', { ascending: true });
      if (error) return err(error.message, 500);
      return ok({ annotations: data || [] });
    }

    // ─── SAVE ANNOTATIONS ────────────────────────────────────────────────
    // Replaces the full annotation set for a given document_id. Safer than
    // partial upserts since the browser sends the authoritative current state.
    if (action === 'save_annotations') {
      const { document_id, annotations, contact_id, created_by } = body;
      if (!document_id) return err('document_id required');
      if (!Array.isArray(annotations)) return err('annotations must be an array');

      // Delete everything previously saved for this document, then insert the new set.
      const { error: delErr } = await sb.from('document_annotations')
        .delete().eq('document_id', String(document_id));
      if (delErr) return err('Delete existing failed: ' + delErr.message, 500);

      if (annotations.length === 0) {
        return ok({ success: true, count: 0 });
      }

      const rows = annotations.map((a: any) => ({
        document_id: String(document_id),
        contact_id:  contact_id || null,
        page:        Number.isFinite(Number(a.page)) ? Math.max(1, Math.floor(Number(a.page))) : 1,
        x:           Number(a.x) || 0,
        y:           Number(a.y) || 0,
        text:        String(a.text || ''),
        font_size:   Number.isFinite(Number(a.font_size)) ? Math.max(6, Math.min(72, Math.floor(Number(a.font_size)))) : 12,
        color:       /^#[0-9A-Fa-f]{6}$/.test(String(a.color || '')) ? a.color : '#000000',
        created_by:  created_by || null,
      }));
      const { data, error: insErr } = await sb.from('document_annotations')
        .insert(rows).select();
      if (insErr) return err('Insert failed: ' + insErr.message, 500);
      return ok({ success: true, count: data?.length || 0 });
    }

    // ─── DELETE DOCUMENT ─────────────────────────────────────────────────
    if (action === 'delete_document') {
      const { document_id, portal_user_id } = body;
      if (!document_id || !portal_user_id) return err('document_id and portal_user_id required');

      // Resolve the portal user's contact_id so we can authorize.
      const { data: pu, error: puErr } = await sb.from('portal_users')
        .select('contact_id').eq('id', portal_user_id).maybeSingle();
      if (puErr) return err(puErr.message, 500);
      const userContactId = pu?.contact_id || null;
      if (!userContactId) return err('Portal user has no linked contact', 403);

      // Load the document and verify ownership.
      const { data: doc, error: docErr } = await sb.from('uploaded_documents')
        .select('id, contact_id, file_path, file_name')
        .eq('id', document_id)
        .maybeSingle();
      if (docErr) return err(docErr.message, 500);
      if (!doc) return err('Document not found', 404);
      if (doc.contact_id !== userContactId) {
        return err('Forbidden — document does not belong to this user', 403);
      }

      // Remove the storage object (non-fatal if this fails — still delete the row).
      if (doc.file_path) {
        const { error: rmErr } = await sb.storage.from('borrower-documents').remove([doc.file_path]);
        if (rmErr) console.warn('[portal-data] storage remove failed:', rmErr.message);
      }

      // Delete the DB row.
      const { error: delErr } = await sb.from('uploaded_documents').delete().eq('id', document_id);
      if (delErr) return err(delErr.message, 500);

      return ok({ success: true });
    }

    // ─── GET PROFILE ─────────────────────────────────────────────────────
    if (action === 'get_profile') {
      const { portal_user_id } = body;
      if (!portal_user_id) return err('portal_user_id required');
      const { data: pu, error: puErr } = await sb.from('portal_users')
        .select('contact_id').eq('id', portal_user_id).maybeSingle();
      if (puErr) return err(puErr.message, 500);
      if (!pu?.contact_id) return err('Portal user has no linked contact', 404);
      const { data: c, error: cErr } = await sb.from('contacts')
        .select('id, first_name, last_name, email, phone, borrower_id, address, city, state, zip')
        .eq('id', pu.contact_id).maybeSingle();
      if (cErr) return err(cErr.message, 500);
      return ok({ profile: c || null });
    }

    // ─── UPDATE PROFILE ──────────────────────────────────────────────────
    if (action === 'update_profile') {
      const { portal_user_id, first_name, last_name, phone, email } = body;
      if (!portal_user_id) return err('portal_user_id required');
      const { data: pu, error: puErr } = await sb.from('portal_users')
        .select('contact_id').eq('id', portal_user_id).maybeSingle();
      if (puErr) return err(puErr.message, 500);
      if (!pu?.contact_id) return err('Portal user has no linked contact', 404);

      const patch: Record<string, any> = { updated_at: new Date().toISOString() };
      if (first_name !== undefined) patch.first_name = first_name;
      if (last_name !== undefined) patch.last_name = last_name;
      if (phone !== undefined) patch.phone = phone;
      if (email !== undefined) patch.email = email;

      const { error: updErr } = await sb.from('contacts').update(patch).eq('id', pu.contact_id);
      if (updErr) return err(updErr.message, 500);
      return ok({ success: true });
    }

    return err('Unknown action: ' + action);

  } catch (e: any) {
    console.error('portal-data error:', e);
    return err(e.message || 'Server error', 500);
  }
});
