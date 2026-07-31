import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const ok  = (d: any) => new Response(JSON.stringify(d), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  try {
    const url = new URL(req.url);

    // ── GET: fetch all guidelines for a lender ─────────────────────────────
    if (req.method === 'GET') {
      const lid = url.searchParams.get('lender_id');
      if (!lid) return err('lender_id required');
      const { data, error } = await sb
        .from('lender_guidelines')
        .select('*')
        .eq('lender_id', lid)
        .eq('is_active', true)
        .order('category')
        .order('title');
      if (error) {
        console.error('[lender-guidelines] GET error:', error.message);
        return err(error.message, 500);
      }
      return ok({ guidelines: data || [] });
    }

    // ── POST: parse body once ──────────────────────────────────────────────
    if (req.method !== 'POST') return err('Method not allowed', 405);

    let body: any;
    try {
      body = await req.json();
    } catch (e) {
      return err('Invalid JSON body', 400);
    }

    const {
      action,
      lender_id,
      guideline_id,
      file_base64,
      file_name,
      file_mime,
      file_size,
      title,
      category,
      version,
      effective_date,
      content_notes,
      external_url,
    } = body;

    console.log('[lender-guidelines] action:', action, 'lender_id:', lender_id);

    // ── action: upload — base64 file → Storage → DB ────────────────────────
    if (action === 'upload') {
      if (!lender_id)   return err('lender_id required');
      if (!file_base64) return err('file_base64 required');
      if (!file_name)   return err('file_name required');

      const ext = (file_name.split('.').pop() || 'pdf').toLowerCase();
      const mime = file_mime || 'application/pdf';
      const safeName = file_name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `${lender_id}/${Date.now()}_${safeName}`;

      // Decode base64
      let binary: Uint8Array;
      try {
        binary = Uint8Array.from(atob(file_base64), c => c.charCodeAt(0));
      } catch (e) {
        return err('Invalid base64 data');
      }

      const { error: upErr } = await sb.storage
        .from('lender-guidelines')
        .upload(storagePath, binary, { contentType: mime, upsert: false });

      if (upErr) {
        console.error('[lender-guidelines] Storage upload error:', upErr.message);
        return err('Upload failed: ' + upErr.message, 500);
      }

      const { data: urlData } = sb.storage.from('lender-guidelines').getPublicUrl(storagePath);
      const publicUrl = urlData?.publicUrl || '';

      const { data: rec, error: insErr } = await sb.from('lender_guidelines').insert({
        lender_id,
        title: title || file_name.replace(/\.[^/.]+$/, ''),
        category: category || 'General',
        file_url: publicUrl,
        file_name: safeName,
        file_type: ext,
        file_size: file_size || binary.length,
        version: version || null,
        effective_date: effective_date || null,
        content_notes: content_notes || null,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).select().single();

      if (insErr) {
        console.error('[lender-guidelines] DB insert error:', insErr.message);
        return err(insErr.message, 500);
      }
      return ok({ success: true, guideline: rec });
    }

    // ── action: add_link — external URL ────────────────────────────────────
    if (action === 'add_link') {
      if (!lender_id) return err('lender_id required');
      if (!external_url) return err('external_url required');

      const { data: rec, error: insErr } = await sb.from('lender_guidelines').insert({
        lender_id,
        title: title || external_url,
        category: category || 'General',
        file_type: 'url',
        external_url,
        content_notes: content_notes || null,
        version: version || null,
        effective_date: effective_date || null,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).select().single();

      if (insErr) {
        console.error('[lender-guidelines] add_link error:', insErr.message);
        return err(insErr.message, 500);
      }
      return ok({ success: true, guideline: rec });
    }

    // ── action: add_note — text note ────────────────────────────────────────
    if (action === 'add_note') {
      if (!lender_id) return err('lender_id required');
      if (!content_notes && !title) return err('title or content_notes required');

      const { data: rec, error: insErr } = await sb.from('lender_guidelines').insert({
        lender_id,
        title: title || 'Note',
        category: category || 'General',
        file_type: 'note',
        content_notes: content_notes || null,
        version: version || null,
        effective_date: effective_date || null,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).select().single();

      if (insErr) {
        console.error('[lender-guidelines] add_note error:', insErr.message);
        return err(insErr.message, 500);
      }
      return ok({ success: true, guideline: rec });
    }

    // ── action: update ──────────────────────────────────────────────────────
    if (action === 'update') {
      if (!guideline_id) return err('guideline_id required');
      const allowed = ['title','category','content_notes','version','effective_date','is_active','external_url'];
      const update: Record<string,any> = { updated_at: new Date().toISOString() };
      allowed.forEach(k => { if (body[k] !== undefined) update[k] = body[k]; });
      const { error: upErr } = await sb.from('lender_guidelines').update(update).eq('id', guideline_id);
      if (upErr) return err(upErr.message, 500);
      return ok({ success: true });
    }

    // ── action: delete — soft delete ─────────────────────────────────────
    if (action === 'delete') {
      if (!guideline_id) return err('guideline_id required');

      // Try to delete from storage if it has a file
      const { data: gl } = await sb.from('lender_guidelines')
        .select('file_url, file_name, lender_id')
        .eq('id', guideline_id).single();

      if (gl?.file_url && gl?.file_name && gl?.lender_id) {
        const storagePath = `${gl.lender_id}/${gl.file_name}`;
        await sb.storage.from('lender-guidelines').remove([storagePath]).catch(() => {});
      }

      await sb.from('lender_guidelines').update({ is_active: false }).eq('id', guideline_id);
      return ok({ success: true });
    }

    return err(`Unknown action: ${action}`);

  } catch (e: any) {
    console.error('[lender-guidelines] Unhandled error:', e.message, e.stack);
    return err(e.message || 'Server error', 500);
  }
});
