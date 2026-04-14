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
 * - get_documents: fetch uploaded documents by contact_id, portal_user_id, or lead_id
 */

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
      const storage_path = `${contact_id}/${Date.now()}_${safeName}`;
      const bytes = new Uint8Array(await file.arrayBuffer());

      const { error: upErr } = await sb.storage
        .from('borrower-documents')
        .upload(storage_path, bytes, { contentType: file.type || 'application/octet-stream', upsert: true });
      if (upErr) return err('Storage upload failed: ' + upErr.message, 500);

      const { data: urlData } = sb.storage.from('borrower-documents').getPublicUrl(storage_path);
      const file_url = urlData.publicUrl;

      const { data: inserted, error: dbErr } = await sb.from('uploaded_documents').insert({
        contact_id,
        document_type: category,
        type: category,
        file_name: file.name,
        file_path: storage_path,
        file_url,
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
    if (action === 'get_all_showings') {
      const { data, error } = await sb.from('showings')
        .select('*, contacts(id, first_name, last_name, email, phone, crm_id)')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) return err(error.message, 500);
      return ok({ showings: data || [], count: data?.length || 0 });
    }

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
      const { email, borrower_id, portal_user_id, data: appData } = body;
      if (!email && !borrower_id) return err('email or borrower_id required');

      // Resolve contact_id from email or borrower_id.
      let contact_id: string | null = null;
      if (borrower_id) {
        const { data: c } = await sb.from('contacts').select('id').eq('borrower_id', borrower_id).maybeSingle();
        if (c) contact_id = c.id;
      }
      if (!contact_id && email) {
        const { data: c } = await sb.from('contacts').select('id').eq('email', email.toLowerCase()).maybeSingle();
        if (c) contact_id = c.id;
      }
      if (!contact_id && portal_user_id) {
        const { data: pu } = await sb.from('portal_users').select('contact_id').eq('id', portal_user_id).maybeSingle();
        if (pu?.contact_id) contact_id = pu.contact_id;
      }
      if (!contact_id) return err('Could not resolve contact — check email or borrower_id');

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
      if (borrower_id) cleanData.borrower_id = borrower_id;
      if (email) cleanData.email = email;

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
      const { contact_id, portal_user_id, lead_id, borrower_id, email } = body;

      // If portal_user_id provided, resolve to contact_id first
      let resolvedContactId = contact_id || null;
      if (!resolvedContactId && portal_user_id) {
        const { data: pu } = await sb.from('portal_users').select('contact_id').eq('id', portal_user_id).single();
        resolvedContactId = pu?.contact_id || null;
      }
      if (!resolvedContactId && email) {
        const { data: c } = await sb.from('contacts').select('id').eq('email', email.toLowerCase()).single();
        resolvedContactId = c?.id || null;
      }

      // Build OR filter to catch all docs for this person.
      // NOTE: portal_user_id is NOT a column on uploaded_documents — it's
      // resolved to contact_id above. Don't add it to the OR filter or the
      // query 500s.
      const filters: string[] = [];
      if (resolvedContactId) filters.push(`contact_id.eq.${resolvedContactId}`);
      if (lead_id) filters.push(`lead_id.eq.${lead_id}`);
      if (borrower_id) filters.push(`borrower_id.eq.${borrower_id}`);

      if (!filters.length) return err('contact_id, portal_user_id, lead_id, borrower_id, or email required');

      const { data, error } = await sb.from('uploaded_documents')
        .select('*')
        .or(filters.join(','))
        .order('uploaded_at', { ascending: false });

      if (error) return err(error.message, 500);
      return ok({ documents: data || [] });
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
