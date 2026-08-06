import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireStaff } from "../_shared/require-staff.ts";

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const jHead = { ...cors, 'Content-Type': 'application/json' }
const ok = (d: any) => new Response(JSON.stringify(d), { headers: jHead })
const err = (s: number, m: string) => new Response(JSON.stringify({ error: m }), { status: s, headers: jHead })

// ---------- helpers ----------
function money(v: any): number {
  if (v == null) return 0
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : 0
}
function round2(n: number): number { return Math.round(n * 100) / 100 }
function properName(first?: any, last?: any): string {
  const f = String(first || '').trim(), l = String(last || '').trim()
  const s = (f + ' ' + l).trim()
  return s || ''
}
function parseDate(s: any): Date | null {
  if (!s) return null
  const m = String(s).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/)
  if (!m) return null
  let [_, mo, da, yr] = m
  let y = parseInt(yr); if (y < 100) y += 2000
  const d = new Date(y, parseInt(mo) - 1, parseInt(da))
  return isNaN(d.getTime()) ? null : d
}
// monthly multiplier from one pay-period span
function freqMultiplier(start: any, end: any): { mult: number; label: string } {
  const s = parseDate(start), e = parseDate(end)
  if (!s || !e) return { mult: 2.1667, label: 'biweekly (assumed)' }
  const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1
  if (days <= 8) return { mult: 4.3333, label: 'weekly' }
  if (days <= 12) return { mult: 2.1667, label: 'biweekly' }
  if (days <= 16) return { mult: 2.0, label: 'semimonthly' }
  return { mult: 1.0, label: 'monthly' }
}
// fraction of the year elapsed by a pay_period_end date (lender YTD averaging).
// Jan 31 -> ~1.0 month, Jun 15 -> ~5.5 months, Dec 31 -> ~12.0 months.
function monthsElapsed(endStr: any): number {
  const e = parseDate(endStr); if (!e) return 0
  return e.getMonth() + (e.getDate() / 30.44)
}
// map a paystub earnings line label -> 1003 income_type
function mapElementType(name: string): string {
  const n = String(name || '').toLowerCase()
  if (/(reg|base|salary|standard|hourly)/.test(n)) return 'Base Salary'
  if (/(over[\s-]?time|^o\.?t\.?$|\bot\b)/.test(n)) return 'Overtime'
  if (/bonus/.test(n)) return 'Bonus'
  if (/(commission|comm\b)/.test(n)) return 'Commission'
  if (/(tip|gratuit)/.test(n)) return 'Tips'
  if (/(holiday|vacation|\bpto\b|sick|personal)/.test(n)) return 'Base Salary'
  if (/(shift|differential|hazard|night|incentive|per diem|premium)/.test(n)) return 'Other'
  return 'Other'
}
function normDocType(d: any): string {
  const k = String(d || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (/pay_?stub|pay_stubs|paystub/.test(k)) return 'paystub'
  if (/^w_?2$|^w2$|w_2/.test(k)) return 'w2'
  if (/bank/.test(k)) return 'bank'
  if (/tax|1040/.test(k)) return 'tax'
  if (/license|dl|gov_?id|identif|id_doc/.test(k)) return 'id'
  return k || 'document'
}
function normAccountType(t: any): string {
  const n = String(t || '').toLowerCase()
  if (/check/.test(n)) return 'Checking'
  if (/sav/.test(n)) return 'Savings'
  if (/money\s*market|mma/.test(n)) return 'Money Market'
  if (/cd|certificate/.test(n)) return 'CD'
  if (/ira|401|retire|roth/.test(n)) return 'Retirement'
  if (/invest|brokerage|securit/.test(n)) return 'Investment'
  return t ? String(t) : 'Checking'
}
function normName(s: any): string { return String(s || '').trim().toLowerCase().replace(/[^a-z]/g, '') }
// Match a document's extracted name against the borrower/co-borrower names on file.
// Returns the canonical "First Last" of the matched person, or null.
function pickOwner(exFirst: any, exLast: any, cands: { first: string; last: string; label: string }[]): string | null {
  const ef = normName(exFirst), el = normName(exLast)
  if (!ef && !el) return null
  for (const c of cands) {
    const cf = normName(c.first), cl = normName(c.last)
    if (el && cl && (el === cl || el.includes(cl) || cl.includes(el))) {
      if (!ef || !cf || ef[0] === cf[0] || cf.includes(ef) || ef.includes(cf)) return c.label
    }
  }
  for (const c of cands) {
    const cf = normName(c.first)
    if (ef && cf && (ef === cf || cf.includes(ef) || ef.includes(cf))) return c.label
  }
  return null
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
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json().catch(() => ({}))
    const { contact_id, doc_type, fields = {}, job_id } = body
    const preview = body.preview === true
    if (!contact_id) return err(400, 'contact_id required')
    const dt = normDocType(doc_type)

    // resolve an existing application_id for this contact (loose grouping; may stay null)
    let application_id: string | null = body.application_id ?? null
    if (!application_id) {
      for (const tbl of ['loan_borrowers', 'loan_income', 'loan_assets']) {
        const { data } = await sb.from(tbl).select('application_id').eq('contact_id', contact_id).not('application_id', 'is', null).limit(1)
        if (data && data[0]?.application_id) { application_id = data[0].application_id; break }
      }
    }

    // ---------- OWNER MATCHING (v2) ----------
    // Build canonical name candidates for this contact (primary borrower + co-borrower)
    // so a document's extracted name attaches to the RIGHT person on the 1003.
    const cands: { first: string; last: string; label: string }[] = []
    try {
      const { data: c } = await sb.from('contacts').select('first_name,middle_name,last_name').eq('id', contact_id).maybeSingle()
      if (c && (c.first_name || c.last_name)) cands.push({ first: c.first_name || '', last: c.last_name || '', label: properName(c.first_name, c.last_name) })
    } catch (_) {}
    try {
      const { data: ma } = await sb.from('mortgage_applications')
        .select('first_name,last_name,co_borrower_first_name,co_borrower_last_name,created_at')
        .eq('contact_id', contact_id).order('created_at', { ascending: false }).limit(1)
      const a = ma && ma[0]
      if (a) {
        if (a.first_name || a.last_name) cands.push({ first: a.first_name || '', last: a.last_name || '', label: properName(a.first_name, a.last_name) })
        if (a.co_borrower_first_name || a.co_borrower_last_name) cands.push({ first: a.co_borrower_first_name || '', last: a.co_borrower_last_name || '', label: properName(a.co_borrower_first_name, a.co_borrower_last_name) })
      }
    } catch (_) {}
    // dedupe candidate labels
    const seen = new Set<string>()
    const candidates = cands.filter((c) => c.label && !seen.has(c.label.toLowerCase()) && seen.add(c.label.toLowerCase()))

    const exFirst = fields.first_name || fields.account_holder_first_name || fields.employee_first_name
    const exLast = fields.last_name || fields.account_holder_last_name || fields.employee_last_name
    const extractedName = properName(exFirst, exLast)
    const matchedOwner = pickOwner(exFirst, exLast, candidates)

    const notes: string[] = []
    const owner = String(body.owner || '').trim() || matchedOwner || extractedName || 'Borrower'
    if (matchedOwner) {
      notes.push(`Owner matched to ${matchedOwner === (candidates[0]?.label) ? 'borrower' : 'co-borrower'} on file: \u201c${matchedOwner}\u201d.`)
    } else if (extractedName) {
      notes.push(`Could not match \u201c${extractedName}\u201d to a borrower on file \u2014 used the document\u2019s own name. Verify the owner before relying on it.`)
    }

    const incomePlan: any[] = []
    const assetPlan: any[] = []
    let employmentUpdate: any = null

    if (dt === 'paystub') {
      const employer = String(fields.employer_name || '').trim() || 'Employer'
      const { mult, label } = freqMultiplier(fields.pay_period_start, fields.pay_period_end)
      notes.push(`Pay frequency detected: ${label} (\u00d7${mult.toFixed(4)}/mo)`) 
      const els = Array.isArray(fields.pay_elements) ? fields.pay_elements : []
      const picked: string[] | null = Array.isArray(body.selected_elements) ? body.selected_elements.map((s: any) => String(s)) : null
      const usable = els.filter((e: any) => money(e?.current) > 0 && (!picked || picked.includes(String(e?.name || ''))))
      // group by mapped income_type so Regular+Holiday collapse into Base Salary etc.
      const byType: Record<string, number> = {}
      if (usable.length) {
        for (const e of usable) {
          const ty = mapElementType(e.name)
          byType[ty] = (byType[ty] || 0) + money(e.current) * mult
        }
      } else {
        const monthly = money(fields.gross_pay) * mult
        if (monthly > 0) byType['Base Salary'] = monthly
      }

      // YTD ANCHORING (v2): lender-standard YTD averaging. When ytd_gross + a valid
      // pay_period_end exist, anchor the monthly TOTAL to ytd_gross / months-elapsed
      // (smooths partial periods + one-time spikes), distributing across the detected
      // types by their current-period proportions. Only applied when it stays within a
      // sane band of the period-based figure; otherwise the period figure is kept and
      // the divergence is flagged for manual review.
      const periodTotal = Object.values(byType).reduce((a, b) => a + b, 0)
      const ytd = money(fields.ytd_gross)
      const me = monthsElapsed(fields.pay_period_end)
      const ytdMonthly = (ytd > 0 && me >= 1) ? ytd / me : 0
      if (ytdMonthly > 0 && periodTotal > 0) {
        const ratio = ytdMonthly / periodTotal
        if (ratio >= 0.5 && ratio <= 1.6) {
          for (const k of Object.keys(byType)) byType[k] = byType[k] * ratio
          notes.push(`Income anchored to YTD average: $${Math.round(ytd).toLocaleString()} \u00f7 ${me.toFixed(1)} mo = $${Math.round(ytdMonthly).toLocaleString()}/mo (period breakdown scaled \u00d7${ratio.toFixed(2)}).`)
        } else {
          notes.push(`Heads up: YTD average ($${Math.round(ytdMonthly).toLocaleString()}/mo) differs sharply from this period ($${Math.round(periodTotal).toLocaleString()}/mo). Kept the current-period amounts \u2014 check for a one-time item, a new job, or a missing YTD.`)
        }
      }

      for (const [income_type, monthly] of Object.entries(byType)) {
        if (monthly <= 0) continue
        incomePlan.push({ income_owner: owner, income_type, employer_name: employer, monthly_amount: round2(monthly), annual_amount: round2(monthly * 12), is_active: true, source: 'paystub_ocr' })
      }
      const baseMonthly = incomePlan.filter(r => r.income_type === 'Base Salary').reduce((a, r) => a + r.monthly_amount, 0)
      employmentUpdate = { employer_name: employer, base_income: round2(baseMonthly) || null, employer_street: fields.employer_street || null, employer_city: fields.employer_city || null, employer_state: fields.employer_state || null, employer_zip: fields.employer_zip || null }
      employmentUpdate._dedupe = { source: 'paystub_ocr', employer_name: employer }
    } else if (dt === 'w2') {
      const employer = String(fields.employer_name || '').trim() || 'Employer'
      const annual = money(fields.wages)
      if (annual > 0) {
        incomePlan.push({ income_owner: owner, income_type: 'Base Salary', employer_name: employer, monthly_amount: round2(annual / 12), annual_amount: round2(annual), is_active: false, source: 'w2_ocr' })
        notes.push(`W-2 added as documentation (is_active=false) so it doesn\u2019t double-count paystub income. Tax year ${fields.tax_year || '?'}.`)
      }
    } else if (dt === 'bank') {
      const bal = money(fields.total_balance)
      assetPlan.push({ asset_owner: owner, asset_type: normAccountType(fields.account_type), institution_name: String(fields.bank_name || '').trim() || 'Bank', account_number: fields.account_number ? String(fields.account_number) : null, current_value: round2(bal) })
    } else {
      notes.push(`Doc type \u201c${doc_type}\u201d has no 1003 income/asset mapping \u2014 used for naming/review only.`)
    }

    // ---------- PREVIEW: compute only ----------
    if (preview) {
      return ok({ preview: true, contact_id, application_id, owner, matched_owner: matchedOwner, candidates: candidates.map(c => c.label), doc_type: dt, income: incomePlan, assets: assetPlan, employment: employmentUpdate ? { employer_name: employmentUpdate.employer_name, base_income: employmentUpdate.base_income } : null, notes })
    }

    // ---------- COMMIT ----------
    const written = { income: 0, assets: 0, employment_updated: false }

    if (incomePlan.length) {
      const ded = employmentUpdate?._dedupe
      if (ded) {
        await sb.from('loan_income').delete().eq('contact_id', contact_id).eq('source', ded.source).eq('employer_name', ded.employer_name)
      } else if (dt === 'w2') {
        const emp = incomePlan[0].employer_name
        await sb.from('loan_income').delete().eq('contact_id', contact_id).eq('source', 'w2_ocr').eq('employer_name', emp)
      }
      const { data: maxRow } = await sb.from('loan_income').select('sort_order').eq('contact_id', contact_id).order('sort_order', { ascending: false }).limit(1)
      let so = (maxRow?.[0]?.sort_order ?? 0) + 1
      const rows = incomePlan.map(r => ({ ...r, contact_id, application_id, sort_order: so++ }))
      const { error: ie } = await sb.from('loan_income').insert(rows)
      if (ie) return err(500, 'income insert failed: ' + ie.message)
      written.income = rows.length
    }

    if (assetPlan.length) {
      for (const a of assetPlan) {
        let q = sb.from('loan_assets').delete().eq('contact_id', contact_id).eq('institution_name', a.institution_name)
        q = a.account_number ? q.eq('account_number', a.account_number) : q.is('account_number', null)
        await q
      }
      const { data: maxRow } = await sb.from('loan_assets').select('sort_order').eq('contact_id', contact_id).order('sort_order', { ascending: false }).limit(1)
      let so = (maxRow?.[0]?.sort_order ?? 0) + 1
      const rows = assetPlan.map(a => ({ ...a, contact_id, application_id, sort_order: so++ }))
      const { error: ae } = await sb.from('loan_assets').insert(rows)
      if (ae) return err(500, 'asset insert failed: ' + ae.message)
      written.assets = rows.length
    }

    if (employmentUpdate) {
      const { data: lb } = await sb.from('loan_borrowers').select('id').eq('contact_id', contact_id).order('borrower_order', { ascending: true }).limit(1)
      if (lb && lb[0]?.id) {
        const patch: any = { employer_name: employmentUpdate.employer_name }
        if (employmentUpdate.base_income) patch.base_income = employmentUpdate.base_income
        for (const k of ['employer_street', 'employer_city', 'employer_state', 'employer_zip']) if (employmentUpdate[k]) patch[k] = employmentUpdate[k]
        const { error: ue } = await sb.from('loan_borrowers').update(patch).eq('id', lb[0].id)
        if (!ue) written.employment_updated = true
      } else {
        notes.push('No loan_borrowers row for this contact yet \u2014 employment header not written (income rows still added).')
      }
    }

    if (job_id) {
      await sb.from('ocr_jobs').update({ mapped_1003_fields: { contact_id, application_id, owner, matched_owner: matchedOwner, doc_type: dt, income: incomePlan, assets: assetPlan, applied_at: new Date().toISOString() } }).eq('id', job_id)
    }

    return ok({ applied: true, contact_id, application_id, owner, matched_owner: matchedOwner, doc_type: dt, written, income: incomePlan, assets: assetPlan, notes })
  } catch (e) {
    return err(500, (e as Error).message)
  }
})
