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

      // Get public URL
      const { data: urlData } = supabase.storage
        .from('borrower-documents')
        .getPublicUrl(storage_path)

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
          file_url: urlData.publicUrl,
          status: 'received',
          file_size: file_size,
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
        file_url: urlData.publicUrl,
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
