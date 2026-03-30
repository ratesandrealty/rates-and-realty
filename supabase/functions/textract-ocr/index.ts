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

    const AWS_ACCESS_KEY = Deno.env.get('AWS_ACCESS_KEY_ID')!
    const AWS_SECRET_KEY = Deno.env.get('AWS_SECRET_ACCESS_KEY')!
    const AWS_REGION = 'us-east-2'
    const S3_BUCKET = 'rates-realty-documents'

    const body = await req.json()
    const { action, job_id } = body

    // ── START: Upload to S3 + kick off Textract ──
    if (action === 'start') {
      const { file_base64, file_name, file_type, contact_id } = body

      // Decode base64
      const binaryStr = atob(file_base64)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)

      // Upload to S3
      const s3Key = `ocr/${contact_id || 'unknown'}/${Date.now()}_${file_name}`
      const s3Url = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${s3Key}`

      const s3Resp = await signedS3Put(s3Url, bytes, file_type, AWS_ACCESS_KEY, AWS_SECRET_KEY, AWS_REGION, S3_BUCKET, s3Key)
      if (!s3Resp.ok) throw new Error('S3 upload failed: ' + await s3Resp.text())

      // Start Textract AnalyzeDocument
      const textractResp = await callTextract('StartDocumentAnalysis', {
        DocumentLocation: { S3Object: { Bucket: S3_BUCKET, Name: s3Key } },
        FeatureTypes: ['FORMS', 'TABLES']
      }, AWS_ACCESS_KEY, AWS_SECRET_KEY, AWS_REGION)

      const textractData = await textractResp.json()
      const textractJobId = textractData.JobId
      if (!textractJobId) throw new Error('Textract did not return JobId: ' + JSON.stringify(textractData))

      // Insert ocr_jobs record
      const { data: job, error: jobError } = await supabase
        .from('ocr_jobs')
        .insert({
          contact_id: contact_id || null,
          file_name,
          s3_key: s3Key,
          textract_job_id: textractJobId,
          status: 'processing'
        })
        .select()
        .single()

      if (jobError) throw new Error('DB insert failed: ' + jobError.message)

      return new Response(JSON.stringify({ job_id: job.id, status: 'processing' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // ── RESULT: Poll Textract + extract fields ──
    if (action === 'result') {
      const { data: job } = await supabase
        .from('ocr_jobs')
        .select('*')
        .eq('id', job_id)
        .single()

      if (!job) throw new Error('Job not found')
      if (job.status === 'completed') {
        return new Response(JSON.stringify({ status: 'completed', fields: job.extracted_fields, doc_type: job.doc_type || 'unknown' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Check Textract job status
      const statusResp = await callTextract('GetDocumentAnalysis', {
        JobId: job.textract_job_id,
        MaxResults: 1000
      }, AWS_ACCESS_KEY, AWS_SECRET_KEY, AWS_REGION)

      const statusData = await statusResp.json()
      console.log('Textract status:', statusData.JobStatus)

      if (statusData.JobStatus === 'IN_PROGRESS') {
        return new Response(JSON.stringify({ status: 'processing' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      if (statusData.JobStatus === 'FAILED') {
        await supabase.from('ocr_jobs').update({ status: 'failed', error_message: statusData.StatusMessage }).eq('id', job_id)
        return new Response(JSON.stringify({ status: 'failed', error: statusData.StatusMessage }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      if (statusData.JobStatus === 'SUCCEEDED') {
        // Extract key-value pairs from FORMS feature
        const blocks = statusData.Blocks || []
        const fields = extractFields(blocks, job.file_name)

        await supabase.from('ocr_jobs').update({
          status: 'completed',
          extracted_fields: fields,
          completed_at: new Date().toISOString()
        }).eq('id', job_id)

        return new Response(JSON.stringify({ status: 'completed', fields, doc_type: detectDocType(job.file_name, fields) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      return new Response(JSON.stringify({ status: 'processing' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    throw new Error('Unknown action: ' + action)

  } catch (err) {
    console.error('textract-ocr error:', err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})

function detectDocType(fileName: string, fields: Record<string, string>): string {
  const name = (fileName || '').toLowerCase()
  if (name.includes('w2') || name.includes('w-2')) return "W-2"
  if (name.includes('pay') || name.includes('stub')) return "Pay Stub"
  if (name.includes('bank') || name.includes('statement')) return "Bank Statement"
  if (name.includes('id') || name.includes('license') || name.includes('dl')) return "Driver's License"
  if (name.includes('tax') || name.includes('1040')) return "Tax Return"
  if (fields.driver_license_number || fields.dl_number) return "Driver's License"
  return "Document"
}

function extractFields(blocks: any[], fileName: string): Record<string, string> {
  const fields: Record<string, string> = {}
  const keyMap: Record<string, string[]> = {
    first_name: ['FN', 'FIRST NAME', 'FIRST'],
    last_name: ['LN', 'LAST NAME', 'LAST'],
    date_of_birth: ['DOB', 'DATE OF BIRTH', 'BIRTH DATE'],
    driver_license_number: ['DL', 'LICENSE NO', 'LICENSE NUMBER', 'DL#'],
    id_expiration_date: ['EXP', 'EXPIRATION', 'EXPIRES'],
    street_address: ['ADD', 'ADDRESS', '449', 'STREET'],
    city: ['CITY'],
    state: ['STATE'],
    zip_code: ['ZIP', 'POSTAL'],
    ssn: ['SSN', 'SOCIAL SECURITY'],
  }

  // Build block id map
  const blockMap: Record<string, any> = {}
  for (const b of blocks) blockMap[b.Id] = b

  // Extract KEY_VALUE_SET pairs
  for (const block of blocks) {
    if (block.BlockType !== 'KEY_VALUE_SET' || !block.EntityTypes?.includes('KEY')) continue
    const keyText = getBlockText(block, blockMap).toUpperCase().trim()
    const valueBlock = block.Relationships?.find((r: any) => r.Type === 'VALUE')
    if (!valueBlock) continue
    const valBlock = blockMap[valueBlock.Ids?.[0]]
    if (!valBlock) continue
    const valueText = getBlockText(valBlock, blockMap).trim()
    if (!valueText) continue

    for (const [fieldName, keys] of Object.entries(keyMap)) {
      if (keys.some(k => keyText.includes(k))) {
        fields[fieldName] = valueText
        break
      }
    }
    // Also store raw
    const rawKey = keyText.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
    if (rawKey && valueText) fields[rawKey] = valueText
  }

  // CA DL specific: parse address line
  if (fields.street_address) {
    const addrParts = parseCAAddress(fields.street_address)
    if (addrParts.city) fields.city = addrParts.city
    if (addrParts.state) fields.state = addrParts.state
    if (addrParts.zip) fields.zip_code = addrParts.zip
    if (addrParts.street) fields.street_address = addrParts.street
  }

  return fields
}

function getBlockText(block: any, blockMap: Record<string, any>): string {
  if (block.BlockType === 'WORD') return block.Text || ''
  if (block.BlockType === 'LINE') return block.Text || ''
  const childRel = block.Relationships?.find((r: any) => r.Type === 'CHILD')
  if (!childRel) return ''
  return childRel.Ids.map((id: string) => blockMap[id]?.Text || '').join(' ')
}

function parseCAAddress(addr: string): { street?: string; city?: string; state?: string; zip?: string } {
  const m = addr.match(/^(.+?)\s+([A-Z\s]+),?\s+([A-Z]{2})\s+(\d{5})$/)
  if (m) return { street: m[1], city: m[2].trim(), state: m[3], zip: m[4] }
  return {}
}

async function signedS3Put(url: string, body: Uint8Array, contentType: string, accessKey: string, secretKey: string, region: string, bucket: string, key: string): Promise<Response> {
  const now = new Date()
  const dateStr = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').substring(0, 15) + 'Z'
  const dateShort = dateStr.substring(0, 8)

  const payloadHash = await sha256Hex(body)
  const canonicalHeaders = `content-type:${contentType}\nhost:${bucket}.s3.${region}.amazonaws.com\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${dateStr}\n`
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = `PUT\n/${key}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
  const credScope = `${dateShort}/${region}/s3/aws4_request`
  const strToSign = `AWS4-HMAC-SHA256\n${dateStr}\n${credScope}\n${await sha256Hex(new TextEncoder().encode(canonicalRequest))}`
  const sigKey = await getSigningKey(secretKey, dateShort, region, 's3')
  const signature = await hmacHex(sigKey, strToSign)
  const auth = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'x-amz-date': dateStr, 'x-amz-content-sha256': payloadHash, 'Authorization': auth },
    body
  })
}

async function callTextract(operation: string, payload: any, accessKey: string, secretKey: string, region: string): Promise<Response> {
  const url = `https://textract.${region}.amazonaws.com`
  const body = JSON.stringify(payload)
  const bodyBytes = new TextEncoder().encode(body)
  const now = new Date()
  const dateStr = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').substring(0, 15) + 'Z'
  const dateShort = dateStr.substring(0, 8)
  const payloadHash = await sha256Hex(bodyBytes)
  const target = `Textract_20181106.${operation}`
  const canonicalHeaders = `content-type:application/x-amz-json-1.1\nhost:textract.${region}.amazonaws.com\nx-amz-date:${dateStr}\nx-amz-target:${target}\n`
  const signedHeaders = 'content-type;host;x-amz-date;x-amz-target'
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
  const credScope = `${dateShort}/${region}/textract/aws4_request`
  const strToSign = `AWS4-HMAC-SHA256\n${dateStr}\n${credScope}\n${await sha256Hex(new TextEncoder().encode(canonicalRequest))}`
  const sigKey = await getSigningKey(secretKey, dateShort, region, 'textract')
  const signature = await hmacHex(sigKey, strToSign)
  const auth = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'x-amz-date': dateStr, 'x-amz-target': target, 'Authorization': auth },
    body
  })
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function hmacHex(key: ArrayBuffer | CryptoKey, data: string): Promise<string> {
  const cryptoKey = key instanceof ArrayBuffer
    ? await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    : key
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function getSigningKey(secret: string, date: string, region: string, service: string): Promise<CryptoKey> {
  const kDate = await crypto.subtle.importKey('raw',
    await crypto.subtle.sign('HMAC',
      await crypto.subtle.importKey('raw', new TextEncoder().encode('AWS4' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
      new TextEncoder().encode(date)
    ), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const kRegion = await crypto.subtle.importKey('raw',
    await crypto.subtle.sign('HMAC', kDate, new TextEncoder().encode(region)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const kService = await crypto.subtle.importKey('raw',
    await crypto.subtle.sign('HMAC', kRegion, new TextEncoder().encode(service)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.importKey('raw',
    await crypto.subtle.sign('HMAC', kService, new TextEncoder().encode('aws4_request')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}
