import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

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

      const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || Deno.env.get('CLAUDE_API_KEY')
      if (!ANTHROPIC_KEY) throw new Error('No Anthropic key found in env')

      const mediaType = (file_type || '').includes('pdf') ? 'application/pdf' : 'image/jpeg'
      const contentBlock = mediaType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file_base64 } }
        : { type: 'image', source: { type: 'base64', media_type: mediaType, data: file_base64 } }

      const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'pdfs-2024-09-25' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{ role: 'user', content: [
            contentBlock,
            { type: 'text', text: `Extract fields from this ${docType}. Return ONLY JSON: {"first_name":"","last_name":"","middle_name":"","date_of_birth":"MM/DD/YYYY","ssn":"","driver_license_number":"","dl_state":"","id_expiration_date":"MM/DD/YYYY","street_address":"","city":"","state":"","zip_code":"","employer_name":"","position":"","monthly_income":""}. CA DL: LN=last name FN=first name. Proper-case names. ONLY JSON.` }
          ]}]
        })
      })

      console.log('Claude resp status:', claudeResp.status)
      let fields: Record<string, string> = {}
      if (claudeResp.ok) {
        const cd = await claudeResp.json()
        const text = cd.content?.[0]?.text || '{}'
        console.log('Claude text:', text.substring(0, 200))
        try { const m = text.match(/\{[\s\S]*\}/); if (m) { const p = JSON.parse(m[0]); Object.keys(p).forEach(k => { if (p[k] && p[k] !== 'null' && p[k] !== 'N/A') fields[k] = String(p[k]) }) } } catch(e) { console.error('Parse err:', e) }
      } else {
        const errText = await claudeResp.text()
        console.error('Claude error:', claudeResp.status, errText)
        throw new Error('Claude API error ' + claudeResp.status + ': ' + errText.substring(0, 200))
      }

      const { data: job } = await sb.from('ocr_jobs').insert({
        contact_id: contact_id || null, file_name, s3_key: 'claude-vision',
        textract_job_id: 'claude-' + Date.now(), status: 'completed',
        extracted_fields: fields, completed_at: new Date().toISOString()
      }).select().single()

      return new Response(JSON.stringify({ job_id: job?.id, status: 'completed', fields, doc_type: docType }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    throw new Error('Unknown action: ' + action)
  } catch(err) {
    console.error('textract-ocr error:', err.message)
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
