import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const body = await req.json()
    const { action } = body

    // Service role client — bypasses RLS
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    /* WHO ASKED, as opposed to who wrote. The service role has no auth.uid(),
     * so uploaded_documents.uploaded_by was populated on 10.5% of rows and NOT
     * ONE of them was the VA's — documents filed is the most visible part of
     * "what she did", and it was invisible.
     *
     * DELIBERATELY OPTIONAL: null for an anon key, a missing header, an expired
     * token or a service-role call, and the upload proceeds exactly as before.
     * Attribution, not a guard — nothing is rejected on its account, so this
     * cannot break a live upload path.
     *
     * Attribution is to the ACCOUNT: processing@ is a shared login, so a stamped
     * uid means "somebody signed in as the VA", not a named person. */
    let uploadedBy: string | null = null
    try {
      const raw = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
      if (raw && raw.split('.').length === 3) {
        // The anon and service keys are well-formed JWTs too; neither has a user.
        const claims = JSON.parse(atob(raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
        if (claims?.sub && claims.role !== 'anon' && claims.role !== 'service_role') {
          const { data, error } = await supabase.auth.getUser(raw)
          if (!error && data?.user?.id) uploadedBy = data.user.id
        }
      }
    } catch (_) { uploadedBy = null }

    // ── Upload file to Supabase Storage + insert DB record ──
    if (action === 'upload_to_storage') {
      const { file_base64, file_name, file_type, storage_path, contact_id, lead_id, document_type, file_size } = body

      // Decode base64 to bytes
      const binaryStr = atob(file_base64)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i)
      }

      // Upload to storage
      const { error: storageError } = await supabase.storage
        .from('borrower-documents')
        .upload(storage_path, bytes, {
          contentType: file_type,
          upsert: true
        })

      if (storageError) {
        console.error('Storage error:', storageError)
        return new Response(JSON.stringify({ error: storageError.message }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Private bucket: sign a short-lived URL for the immediate response only; persist the
      // PATH (never a public/signed URL). Consumers re-sign from storage_path on demand.
      const { data: signedData } = await supabase.storage
        .from('borrower-documents')
        .createSignedUrl(storage_path, 3600)

      // Insert DB record
      const { error: dbError } = await supabase
        .from('uploaded_documents')
        .insert({
          contact_id: contact_id || null,
          lead_id: lead_id || null,
          document_type: document_type,
          type: document_type,
          file_name: file_name,
          file_path: storage_path,
          file_url: null,
          status: 'received',
          file_size: file_size,
          uploaded_by: uploadedBy,
          uploaded_at: new Date().toISOString()
        })

      if (dbError) {
        console.error('DB error:', dbError)
        return new Response(JSON.stringify({ error: dbError.message }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      return new Response(JSON.stringify({
        success: true,
        file_url: signedData?.signedUrl || null,
        storage_path
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // ── Google Drive upload (existing functionality placeholder) ──
    if (action === 'drive_upload') {
      return new Response(JSON.stringify({ error: 'Drive upload not yet implemented in this function' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ error: 'Unknown action: ' + action }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error('Edge function error:', err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
