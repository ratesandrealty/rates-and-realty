import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const body = await req.json()
    const { action, job_id } = body

    // ── RESULT: Return completed job from DB ──
    if (action === 'result') {
      const { data: job } = await supabase
        .from('ocr_jobs')
        .select('*')
        .eq('id', job_id)
        .single()

      if (!job) throw new Error('Job not found')

      return new Response(JSON.stringify({
        status: job.status,
        fields: job.extracted_fields || {},
        doc_type: job.doc_type || 'Document',
        error: job.error_message
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ── START: Use Claude Vision to extract fields ──
    if (action === 'start') {
      const { file_base64, file_name, file_type, contact_id } = body

      const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')
      if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set')

      // Detect doc type from filename
      const nameLower = (file_name || '').toLowerCase()
      let docType = 'Document'
      if (nameLower.includes('id') || nameLower.includes('license') || nameLower.includes('dl')) docType = "Driver's License"
      else if (nameLower.includes('w2') || nameLower.includes('w-2')) docType = 'W-2'
      else if (nameLower.includes('pay') || nameLower.includes('stub')) docType = 'Pay Stub'
      else if (nameLower.includes('bank') || nameLower.includes('statement')) docType = 'Bank Statement'
      else if (nameLower.includes('tax') || nameLower.includes('1040')) docType = 'Tax Return'

      // Call Claude Vision
      const mediaType = file_type?.includes('pdf') ? 'application/pdf' : (file_type || 'image/jpeg')

      const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              {
                type: mediaType === 'application/pdf' ? 'document' : 'image',
                source: { type: 'base64', media_type: mediaType, data: file_base64 }
              },
              {
                type: 'text',
                text: `Extract all fields from this ${docType}. Return ONLY a JSON object with these keys (use null for missing fields):
{
  "first_name": "",
  "last_name": "",
  "middle_name": "",
  "date_of_birth": "MM/DD/YYYY",
  "ssn": "XXX-XX-XXXX",
  "driver_license_number": "",
  "dl_state": "",
  "id_expiration_date": "MM/DD/YYYY",
  "street_address": "",
  "city": "",
  "state": "",
  "zip_code": "",
  "employer_name": "",
  "position": "",
  "monthly_income": "",
  "gross_income": ""
}
For CA Driver License: LN = last name, FN = first name. Proper-case all names. Return ONLY the JSON object, no explanation.`
              }
            ]
          }]
        })
      })

      if (!claudeResp.ok) {
        const errText = await claudeResp.text()
        throw new Error('Claude API error: ' + errText)
      }

      const claudeData = await claudeResp.json()
      const rawText = claudeData.content?.[0]?.text || '{}'

      let fields: Record<string, string> = {}
      try {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/)
        if (jsonMatch) fields = JSON.parse(jsonMatch[0])
      } catch(e) {
        console.error('JSON parse error:', e, rawText)
      }

      // Remove null values
      Object.keys(fields).forEach(k => { if (!fields[k]) delete fields[k] })

      // Save to DB
      const { data: job, error: jobError } = await supabase
        .from('ocr_jobs')
        .insert({
          contact_id: contact_id || null,
          file_name,
          s3_key: 'claude-vision',
          textract_job_id: 'claude-' + Date.now(),
          status: 'completed',
          extracted_fields: fields,
          completed_at: new Date().toISOString()
        })
        .select()
        .single()

      if (jobError) console.error('DB insert error:', jobError)

      return new Response(JSON.stringify({
        job_id: job?.id,
        status: 'completed',
        fields,
        doc_type: docType
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    throw new Error('Unknown action: ' + action)

  } catch (err) {
    console.error('textract-ocr error:', err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
