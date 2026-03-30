import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json()
    const { action, job_id } = body

    if (action === 'result') {
      const { data: job } = await sb.from('ocr_jobs').select('*').eq('id', job_id).single()
      if (!job) throw new Error('Job not found')
      return new Response(JSON.stringify({ status: job.status, fields: job.extracted_fields || {}, doc_type: job.doc_type || 'Document' }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    if (action === 'start') {
      const { file_base64, file_name, file_type, contact_id } = body
      const nameLower = (file_name || '').toLowerCase()
      let docType = 'Document'
      if (nameLower.includes('id') || nameLower.includes('license') || nameLower.includes('dl')) docType = "Driver's License"
      else if (nameLower.includes('w2') || nameLower.includes('w-2')) docType = 'W-2'
      else if (nameLower.includes('pay') || nameLower.includes('stub')) docType = 'Pay Stub'
      else if (nameLower.includes('bank')) docType = 'Bank Statement'
      else if (nameLower.includes('tax') || nameLower.includes('1040')) docType = 'Tax Return'

      // Call ai-chat edge function which has ANTHROPIC_API_KEY built in
      const aiResp = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/ai-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}` },
        body: JSON.stringify({
          message: `Extract all text fields from this ${docType} image/document. Return ONLY a JSON object with these exact keys (null if not found): {"first_name":"","last_name":"","middle_name":"","date_of_birth":"MM/DD/YYYY","ssn":"","driver_license_number":"","dl_state":"","id_expiration_date":"MM/DD/YYYY","street_address":"","city":"","state":"","zip_code":"","employer_name":"","position":"","monthly_income":""}. For CA Driver License: LN=last name, FN=first name. Proper-case names. Return ONLY the JSON, no explanation.`,
          image_base64: file_base64,
          image_type: file_type || 'application/pdf',
          session_id: 'ocr-' + Date.now(),
          mode: 'ocr'
        })
      })

      let fields: Record<string, string> = {}
      if (aiResp.ok) {
        const aiData = await aiResp.json()
        const text = aiData.reply || aiData.message || aiData.content?.[0]?.text || '{}'
        try {
          const m = text.match(/\{[\s\S]*\}/)
          if (m) {
            const parsed = JSON.parse(m[0])
            Object.keys(parsed).forEach(k => { if (parsed[k] && parsed[k] !== 'null') fields[k] = parsed[k] })
          }
        } catch(e) { console.error('Parse error:', e) }
      } else {
        console.error('ai-chat error:', await aiResp.text())
      }

      const { data: job } = await sb.from('ocr_jobs').insert({
        contact_id: contact_id || null,
        file_name, s3_key: 'ai-vision', textract_job_id: 'ai-' + Date.now(),
        status: 'completed', extracted_fields: fields, completed_at: new Date().toISOString()
      }).select().single()

      return new Response(JSON.stringify({ job_id: job?.id, status: 'completed', fields, doc_type: docType }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    throw new Error('Unknown action: ' + action)
  } catch(err) {
    console.error('Error:', err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
