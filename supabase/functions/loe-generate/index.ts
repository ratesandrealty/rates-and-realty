import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireStaff } from "../_shared/require-staff.ts";

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const jHead = { ...cors, 'Content-Type': 'application/json' }
const ok = (d: any) => new Response(JSON.stringify(d), { headers: jHead })
const fail = (m: string, detail: any = null) => new Response(JSON.stringify({ error: m, detail }), { status: 200, headers: jHead })

const MODEL = 'claude-sonnet-4-6'

const CATEGORY_LABELS: Record<string, string> = {
  credit_inquiry: 'Recent credit inquiry / newly opened credit',
  large_deposit: 'Large or unusual bank deposit',
  employment_gap: 'Gap in employment',
  address_discrepancy: 'Address discrepancy on file',
  name_variation: 'Name variation / alias',
  late_payment: 'Late payment(s)',
  source_of_funds: 'Source of funds',
  cash_out: 'Use of cash-out proceeds',
  other: 'General explanation'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  /* GUARD FIRST — before the body or query string is read, so an action
     added later is covered by default rather than by remembering.
     verify_jwt=true does NOT do this: the anon key is a project-signed JWT
     printed in every page's source. See docs/PINNED-NOT-GUARDED.md. */
  const _auth = await requireStaff(req);
  if (!_auth.ok) return new Response(JSON.stringify({ error: _auth.msg || 'not authorized' }),
    { status: _auth.status || 401, headers: { ...cors, 'Content-Type': 'application/json' } });
  try {
    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
    if (!ANTHROPIC_API_KEY) return fail('ANTHROPIC_API_KEY not set')
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const body = await req.json().catch(() => ({}))
    const { contact_id, application_id = null, category = 'other', topic = '', details = '', loe_id = null, instruction = '', current_body = '' } = body
    const preview = body.preview === true
    if (!contact_id && !loe_id) return fail('contact_id or loe_id required')

    let cid = contact_id, aid = application_id, cat = category, top = topic, det = details
    let signerIds: string[] = Array.isArray(body.signer_contact_ids) ? body.signer_contact_ids.filter(Boolean) : []
    if (loe_id) {
      const { data: ex } = await sb.from('loe_requests').select('*').eq('id', loe_id).maybeSingle()
      if (ex) {
        cid = cid || ex.contact_id; aid = aid ?? ex.application_id; cat = category || ex.category; top = topic || ex.topic; det = details || ex.details
        if (!signerIds.length && Array.isArray(ex.signer_contact_ids)) signerIds = ex.signer_contact_ids.filter(Boolean)
      }
    }
    if (!signerIds.length && cid) signerIds = [cid]
    signerIds = [...new Set(signerIds)]

    let signerNames: string[] = []
    if (signerIds.length) {
      const { data: cs } = await sb.from('contacts').select('id,first_name,middle_name,last_name').in('id', signerIds)
      const byId = new Map((cs || []).map((c: any) => [c.id, [c.first_name, c.middle_name, c.last_name].filter(Boolean).join(' ').trim()]))
      signerNames = signerIds.map((id) => byId.get(id)).filter(Boolean) as string[]
    }

    let addr = ''
    try {
      const { data: ma } = await sb.from('mortgage_applications').select('current_address_street,current_address_city,current_address_state,current_address_zip').eq('contact_id', cid).order('created_at', { ascending: false }).limit(1)
      const a = ma && ma[0]
      if (a) addr = [a.current_address_street, [a.current_address_city, a.current_address_state].filter(Boolean).join(', '), a.current_address_zip].filter(Boolean).join(' ')
    } catch (_) {}
    if (!signerNames.length) signerNames = ['the borrower']

    const joint = signerNames.length > 1
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    const catLabel = CATEGORY_LABELS[cat] || CATEGORY_LABELS.other

    const system = [
      'You are an expert mortgage loan processor for Rates & Realty (E Mortgage Capital, DBA EMC).',
      'You write Letters of Explanation (LOEs) that the borrower(s) sign and submit to underwriting.',
      'Write in the borrower first-person voice, addressed to the lender/underwriter.',
      'If more than one borrower is signing, write in first-person PLURAL (we/our) and name them in the opening.',
      'Be concise, factual, and professional. Use ONLY the facts provided - never invent names, dates, dollar amounts, or circumstances.',
      'If a needed detail is missing, write the letter so it reads naturally without fabricating it.',
      'Output ONLY the letter text - no preamble, no markdown, no headings like Here is. Plain text.',
      'Structure: the date on its own line; a greeting such as To Whom It May Concern,; 1-3 short paragraphs of explanation; then Sincerely, on its own line. Do NOT add printed names, signature lines, or date lines after Sincerely, - a signature block is appended separately for each borrower.'
    ].join(' ')

    let userMsg: string
    if (instruction && current_body) {
      userMsg = 'Here is the current Letter of Explanation:\n\n' + current_body + '\n\nRevise it per this instruction: ' + instruction + '\n\nKeep the same borrower voice and professional tone. End at Sincerely, with no printed names or signature lines after it. Output only the revised letter.'
    } else {
      const signerBlock = joint
        ? 'This letter is signed JOINTLY by these borrowers (write in we/our and name them in the opening): ' + signerNames.join(', ')
        : 'Borrower: ' + signerNames[0]
      userMsg = [
        'Write a Letter of Explanation for a mortgage file.',
        'Date: ' + today,
        signerBlock,
        addr ? 'Borrower address: ' + addr : '',
        'Subject / reason for the letter: ' + (top || catLabel),
        'Category: ' + catLabel,
        det ? 'Facts to incorporate (from the loan officer - weave in naturally, do not list verbatim): ' + det : 'No extra details were provided; write a clear, general explanation appropriate to the subject.',
        'Keep it to a short, single-purpose letter.'
      ].filter(Boolean).join('\n')
    }

    let resp: Response
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, messages: [{ role: 'user', content: userMsg }] })
      })
    } catch (e) {
      return fail('Could not reach the AI service', { fetch_error: String(e) })
    }
    const result = await resp.json().catch(() => null)
    if (!resp.ok || !result || result.error) {
      console.error('loe-generate anthropic error', resp.status, JSON.stringify(result))
      return fail(result?.error?.message || `AI request failed (HTTP ${resp.status})`, { status: resp.status, anthropic: result?.error || result })
    }
    const draft = (result.content?.[0]?.text || '').trim()
    if (!draft) return fail('AI returned an empty draft', { result })

    if (preview) return ok({ ok: true, preview: true, body: draft, signer_names: signerNames, signer_contact_ids: signerIds, category: cat, topic: top || catLabel })

    const finalTopic = (top && top.trim()) || catLabel
    const common: any = { topic: finalTopic, category: cat, details: det, body: draft, status: 'drafted', application_id: aid, signer_contact_ids: signerIds.length ? signerIds : null, updated_at: new Date().toISOString() }
    if (loe_id) {
      const { data, error } = await sb.from('loe_requests').update(common).eq('id', loe_id).select('id').maybeSingle()
      if (error) return fail('save failed: ' + error.message)
      return ok({ ok: true, loe_id: data?.id || loe_id, body: draft, status: 'drafted', signer_names: signerNames, signer_contact_ids: signerIds })
    } else {
      const { data, error } = await sb.from('loe_requests').insert({ contact_id: cid, ...common }).select('id').maybeSingle()
      if (error) return fail('create failed: ' + error.message)
      return ok({ ok: true, loe_id: data?.id, body: draft, status: 'drafted', signer_names: signerNames, signer_contact_ids: signerIds })
    }
  } catch (e) {
    return fail((e as Error).message)
  }
})
