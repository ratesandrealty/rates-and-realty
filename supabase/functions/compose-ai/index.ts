// compose-ai — AI assistant for the inbox composer.
//
// Actions: summarize_client, summarize_thread, draft_reply, improve.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 AUTH — this does NOT mirror sms-draft-assist, deliberately.
//
// sms-draft-assist (v4) runs verify_jwt=false with NO role guard at all: it takes
// a contact_id from an unauthenticated caller and reads that contact with the
// service key. Copying that here would expose borrower loan data and Gmail thread
// contents to anyone who can reach the URL.
//
// The pattern actually followed is gmail-inbox's: verify the Supabase JWT, resolve
// the role from auth_user_roles (same source as current_app_role()), and gate on
// it — matching the role set the email surface already uses (email_recipient_search,
// email_signature_get). verify_jwt=true is pinned in config.toml.
//
// What IS mirrored from sms-draft-assist: the Claude call shape (raw fetch to
// /v1/messages with x-api-key + anthropic-version), CRM context gathering via the
// service client, and the ok/bad response envelope.
// ─────────────────────────────────────────────────────────────────────────────

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { gmailApi } from '../_shared/gmail-dwd.ts'

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const RENE = 'rene@ratesandrealty.com'
const PROCESSING = 'processing@ratesandrealty.com'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const J = { ...cors, 'Content-Type': 'application/json' }

// Same role set the rest of the email surface uses (email_recipient_search,
// email_signature_get): admin plus back-office staff. Everyone else is refused.
const ALLOWED_ROLES = new Set(['admin', 'va', 'loa', 'agent', 'staff'])

// Duplicated from gmail-inbox on purpose — this is a security boundary, and a
// server-side thread fetch must re-derive it rather than trust the caller.
// gmail-inbox/index.ts is the source of truth; keep the two in sync.
function allowedMailboxes(role: string): string[] {
  if (role === 'admin') return [RENE, PROCESSING]
  if (role === 'va') return [PROCESSING]
  return []
}

/* ══════════════════════════════════════════════════════════════════════════
 * MODEL SELECTION — per action, not one model for everything.
 *
 * 🔴 ONLY MODEL IDS ALREADY PROVEN IN THIS PROJECT. Both strings below are in live
 * production use here:
 *   claude-sonnet-4-6 — sms-draft-assist, claude-ai, guideline-ai, crm-copilot
 *   claude-haiku-4-5  — canva-generate, email-service, extract-conditions, sms-service
 *
 * An earlier revision used claude-sonnet-5 / claude-opus-5. Those are current, valid
 * model IDs — but nothing in this project had ever called them, so account-level
 * access was unverified, and an unavailable model fails at call time with the AI
 * buttons appearing to do nothing. Not worth the risk for the capability gain.
 * If you want the newer tier, verify access with one live call first, then swap.
 *
 * Tiering within the proven pair, by what each action can get wrong:
 *   improve / summarize_thread → haiku: mechanical rewriting and summarizing of
 *     text already in the prompt. Cheapest correct answer, lowest latency.
 *   summarize_client / draft_reply → sonnet: one synthesizes loan figures across CRM
 *     tables, the other writes correspondence a loan officer sends under his own name.
 * ══════════════════════════════════════════════════════════════════════════ */
const MODELS = {
  summarize_client: 'claude-sonnet-4-6',
  summarize_thread: 'claude-haiku-4-5',
  draft_reply: 'claude-sonnet-4-6',
  improve: 'claude-haiku-4-5',
} as const

/**
 * Call Claude, using the exact request shape the working functions in this project
 * already use: model + max_tokens + system + messages, nothing else.
 *
 * Deliberately NO `thinking` and NO `output_config`:
 *   - `output_config.effort` is REJECTED outright by Haiku 4.5 (400), so it could
 *     never be sent uniformly anyway.
 *   - Sonnet 4.6 does not think unless adaptive thinking is asked for explicitly, so
 *     omitting it is both the fast path and the proven one.
 *   - temperature / top_p / top_k are likewise absent, matching the other functions.
 * One shape for every model here means one less thing that can 400 at call time.
 */
async function askClaude(model: string, system: string, user: string, maxTokens: number) {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const t = await r.text()
    console.error('Claude error:', t.slice(0, 500))
    throw new Error('AI request failed (' + r.status + ')')
  }
  const out = await r.json()
  // Safety classifiers can decline with HTTP 200 — check before reading content.
  if (out?.stop_reason === 'refusal') {
    throw new Error('The AI declined this request. Rephrase and try again.')
  }
  const text = (out?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim()
  if (!text) throw new Error('The AI returned nothing — try again.')
  return text
}

// ── CRM context (service client; the caller was already role-gated above) ──
async function clientContext(svc: any, contactId: string) {
  const out: string[] = []
  let name = ''

  // Column list verified against the live schema — `contacts` has no `status`
  // column (pipeline status lives on mortgage_applications.status). A select
  // naming a column that doesn't exist fails the whole query and silently drops
  // this entire block from the brief, so keep these exact.
  const { data: c } = await svc.from('contacts')
    .select('first_name,last_name,email,phone,loan_type,loan_purpose,temperature,lead_source,tags,notes,created_at')
    .eq('id', contactId).maybeSingle()
  if (c) {
    name = `${c.first_name || ''} ${c.last_name || ''}`.trim()
    out.push('CONTACT')
    out.push(`  Name: ${name || '(unknown)'}`)
    if (c.email) out.push(`  Email: ${c.email}`)
    if (c.loan_purpose) out.push(`  Loan purpose: ${c.loan_purpose}`)
    if (c.loan_type) out.push(`  Loan type: ${c.loan_type}`)
    if (c.temperature) out.push(`  Lead temperature: ${c.temperature}`)
    if (c.lead_source) out.push(`  Lead source: ${c.lead_source}`)
    if (Array.isArray(c.tags) && c.tags.length) out.push(`  Tags: ${c.tags.join(', ')}`)
    if (c.created_at) out.push(`  In system since: ${String(c.created_at).slice(0, 10)}`)
    if (c.notes) out.push(`  Notes: ${String(c.notes).slice(0, 600)}`)
  }

  // Applications carry the loan figures. Explicit column list, verified live —
  // there is no `stage`, `dti`, `ltv`, `fico`, or `interest_rate` column on this
  // table (stage is `status`; rates are quoted/locked/current; DTI and LTV are not
  // stored at all — see the note pushed below).
  const { data: apps } = await svc.from('mortgage_applications')
    .select('status,loan_purpose,loan_type,occupancy_type,loan_amount,requested_loan_amount,' +
            'purchase_price,property_value,estimated_value,property_address,credit_score,' +
            'monthly_debt,total_monthly_income,total_pitia,quoted_rate,locked_rate,' +
            'rate_lock_expiry,preapproval_expiry,loan_term_months,application_date,updated_at')
    .eq('contact_id', contactId).order('updated_at', { ascending: false }).limit(2)
  if (apps && apps.length) {
    out.push('MORTGAGE APPLICATIONS (most recent first)')
    for (const a of apps) {
      const bits: string[] = []
      const push = (label: string, v: any) => { if (v !== null && v !== undefined && v !== '') bits.push(`${label}=${v}`) }
      push('stage', a.status)
      push('purpose', a.loan_purpose); push('loan_type', a.loan_type); push('occupancy', a.occupancy_type)
      push('loan_amount', a.loan_amount ?? a.requested_loan_amount)
      push('purchase_price', a.purchase_price)
      push('property_value', a.property_value ?? a.estimated_value)
      push('property', a.property_address)
      push('fico', a.credit_score)
      push('monthly_income', a.total_monthly_income); push('monthly_debt', a.monthly_debt)
      push('pitia', a.total_pitia)
      push('quoted_rate', a.quoted_rate); push('locked_rate', a.locked_rate)
      push('term_months', a.loan_term_months)
      push('rate_lock_expiry', a.rate_lock_expiry ? String(a.rate_lock_expiry).slice(0, 10) : null)
      push('preapproval_expiry', a.preapproval_expiry ? String(a.preapproval_expiry).slice(0, 10) : null)
      push('applied', a.application_date ? String(a.application_date).slice(0, 10) : null)
      push('updated', a.updated_at ? String(a.updated_at).slice(0, 10) : null)
      out.push('  - ' + (bits.length ? bits.join(', ') : '(no populated fields)'))
    }
    // DTI and LTV have no columns on this table. Income/debt/loan/value are above,
    // but a model deriving DTI from them would be guessing at which obligations and
    // which proposed payment belong in the numerator — and a wrong ratio quoted to a
    // borrower is worse than an absent one.
    out.push('  NOTE: DTI and LTV are not stored in the CRM. Do not compute or estimate them.')
  }

  const { data: notes } = await svc.from('order_notes')
    .select('note_text,created_at').eq('contact_id', contactId)
    .order('created_at', { ascending: false }).limit(5)
  if (notes && notes.length) {
    out.push('RECENT NOTES')
    for (const n of notes) out.push(`  - [${String(n.created_at).slice(0, 10)}] ${String(n.note_text || '').slice(0, 300)}`)
  }

  // `type`, not `event_type` — the column is named `type` on this table.
  const { data: ev } = await svc.from('activity_events')
    .select('type,title,description,created_at').eq('contact_id', contactId)
    .order('created_at', { ascending: false }).limit(6)
  if (ev && ev.length) {
    out.push('RECENT ACTIVITY')
    for (const e of ev) {
      out.push(`  - [${String(e.created_at).slice(0, 10)}] ${e.type || ''}: ` +
        `${String(e.title || '').slice(0, 120)} ${String(e.description || '').slice(0, 200)}`.trim())
    }
  }

  return { text: out.join('\n'), name }
}

// Flatten a Gmail thread to plain text for the model.
function threadToText(messages: any[]): string {
  return (messages || []).map((m: any) => {
    const who = m.direction === 'outbound' ? 'Rene (us)' : ((m.from && (m.from.name || m.from.email)) || 'them')
    const when = m.date ? String(m.date).slice(0, 10) : ''
    const body = String(m.body_text || m.snippet || '').replace(/\s+\n/g, '\n').slice(0, 4000)
    return `--- ${who} ${when}\n${body}`
  }).join('\n\n')
}

const NO_INVENTION =
  'NEVER invent or estimate loan facts. Rates, loan amounts, DTI, LTV, FICO, dates, ' +
  'approval status and conditions may ONLY come from the context provided. If a fact ' +
  'is missing, say it is not on file — do not guess, and do not fill a gap with a ' +
  'plausible-sounding number.'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const ok = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: J })
  const bad = (m: string, s = 400) => new Response(JSON.stringify({ ok: false, error: m }), { status: s, headers: J })

  try {
    if (!ANTHROPIC_KEY) return bad('AI key not configured', 500)

    // 1) Identity — verify the JWT; never trust the client for who they are.
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
    if (!jwt) return bad('Missing Authorization header', 401)
    const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const { data: userData, error: authErr } = await svc.auth.getUser(jwt)
    if (authErr || !userData?.user) return bad('Invalid or expired session', 401)

    // 2) Role gate — before any CRM read or Gmail call.
    const { data: roleRow } = await svc.from('auth_user_roles').select('role').eq('user_id', userData.user.id).limit(1)
    const role = (roleRow && roleRow.length ? roleRow[0].role : 'none') as string
    if (!ALLOWED_ROLES.has(role)) return bad(`forbidden: role '${role}' may not use the composer assistant`, 403)

    const body = await req.json().catch(() => ({} as any))
    const action = String(body.action || '')

    /* ── 1. summarize_client ───────────────────────────────────────────────── */
    if (action === 'summarize_client') {
      const contactId = String(body.contact_id || '')
      if (!contactId) return bad('contact_id required')
      const ctx = await clientContext(svc, contactId)
      if (!ctx.text) return bad('No CRM record found for that contact.')
      const text = await askClaude(
        MODELS.summarize_client,
        `You brief a mortgage loan officer on a client before he writes to them. ${NO_INVENTION}\n` +
        'Write 3-5 plain sentences he can read at a glance: who they are, where their loan stands, ' +
        'and anything time-sensitive or unresolved. No headings, no bullet points, no preamble — ' +
        'start with the client\'s name. If the record is thin, say so plainly in one sentence.',
        `CLIENT RECORD:\n${ctx.text}`,
        1200,
      )
      return ok({ ok: true, action, model: MODELS.summarize_client, contact_name: ctx.name, text })
    }

    /* ── 2. summarize_thread ───────────────────────────────────────────────────
     * Thread text is taken from the CLIENT by default: the composer already has the
     * full thread loaded from get_thread, so re-fetching it here would mean a second
     * Gmail round trip per click for bytes the browser is already holding.
     * thread_id + mailbox is supported as a fallback (deep links, retries) and goes
     * through the same role→mailbox gate as gmail-inbox.
     * ───────────────────────────────────────────────────────────────────────── */
    if (action === 'summarize_thread') {
      let threadText = String(body.thread_text || '').slice(0, 40000)
      if (!threadText) {
        const threadId = String(body.thread_id || '')
        const mailbox = String(body.mailbox || '').toLowerCase().trim()
        if (!threadId || !mailbox) return bad('thread_text, or thread_id + mailbox, required')
        if (!allowedMailboxes(role).includes(mailbox)) {
          return bad(`forbidden: role '${role}' may not access ${mailbox}`, 403)
        }
        const tr = await gmailApi(mailbox, `threads/${threadId}?format=full`)
        if (!tr.ok) return bad('Could not load that thread from Gmail.', 502)
        const tj = await tr.json()
        threadText = (tj.messages || []).map((m: any) => String(m.snippet || '')).join('\n\n').slice(0, 40000)
      }
      const text = await askClaude(
        MODELS.summarize_thread,
        `You summarize an email thread for a mortgage loan officer. ${NO_INVENTION}\n` +
        'Reply with 2-3 sentences on what the conversation is about and where it stands. ' +
        'Then, only if there are any, a line "Action items:" followed by short "- " lines for ' +
        'open questions or things someone is waiting on. No preamble, no headings beyond that.',
        `EMAIL THREAD:\n${threadText}`,
        1000,
      )
      return ok({ ok: true, action, model: MODELS.summarize_thread, text })
    }

    /* ── 3. draft_reply ────────────────────────────────────────────────────── */
    if (action === 'draft_reply') {
      const instruction = String(body.instruction || '').slice(0, 500)
      const threadText = String(body.thread_text || '').slice(0, 40000)
      const contactId = String(body.contact_id || '')
      let crm = ''
      if (contactId) {
        const ctx = await clientContext(svc, contactId)
        crm = ctx.text
      }
      if (!threadText && !crm && !instruction) return bad('Nothing to work from — provide a thread, a contact, or an instruction.')
      const text = await askClaude(
        MODELS.draft_reply,
        'You draft email replies that Rene Duarte, a mortgage loan officer at Rates & Realty, ' +
        'sends under his own name. Professional, warm, direct — a competent human, not a template.\n' +
        `${NO_INVENTION}\n` +
        'Answer what was actually asked and move the loan forward. Keep it short: a few short ' +
        'paragraphs at most. Do not invent a signature or sign-off block — one is appended ' +
        'automatically. Do not write a subject line.\n' +
        'Return ONLY the message body as simple HTML: <p> paragraphs, and <ul>/<li> or <b> only ' +
        'where they genuinely help. No <html>, <head>, <body>, no markdown fences, no commentary ' +
        'about what you wrote.',
        [
          crm ? `CLIENT RECORD:\n${crm}` : '',
          threadText ? `EMAIL THREAD (most recent last):\n${threadText}` : '',
          `INSTRUCTION: ${instruction || 'Write the natural next reply in this conversation.'}`,
        ].filter(Boolean).join('\n\n'),
        4000,
      )
      return ok({ ok: true, action, model: MODELS.draft_reply, html: text })
    }

    /* ── 4. improve ────────────────────────────────────────────────────────── */
    if (action === 'improve') {
      const draft = String(body.draft_text || '').slice(0, 20000)
      if (!draft.trim()) return bad('There is nothing in the message body to improve yet.')
      const tone = String(body.tone || 'professional, warm, concise').slice(0, 120)
      const text = await askClaude(
        MODELS.improve,
        'You are a copy editor for a mortgage loan officer. Rewrite the draft below for grammar, ' +
        `clarity and flow in a ${tone} tone.\n` +
        'CRITICAL: do not add any fact, number, date, commitment, or offer that is not already in ' +
        'the draft. Do not answer questions the draft leaves open. Do not add a greeting or a ' +
        'sign-off that is not already there. You are editing his words, not writing your own.\n' +
        'Return ONLY the rewritten body as simple HTML (<p>, and <ul>/<li> or <b> only if the ' +
        'draft already implies them). No markdown fences, no notes about what you changed.',
        `DRAFT:\n${draft}`,
        4000,
      )
      return ok({ ok: true, action, model: MODELS.improve, html: text })
    }

    return bad('unknown action: ' + action)
  } catch (e) {
    console.error('compose-ai error:', e)
    return bad((e as Error)?.message || 'Server error', 500)
  }
})
