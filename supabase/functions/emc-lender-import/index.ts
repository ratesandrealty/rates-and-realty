import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

function normName(n: string): string {
  return n.toLowerCase()
    .replace(/[⭐★✓•–—]/g, '')  // strip emoji/special chars
    .replace(/[^a-z0-9]/g, '')   // keep only alphanumeric
    .trim();
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const CLICKUP_TOKEN = Deno.env.get('CLICKUP_API_TOKEN')
    const CLICKUP_LENDERS_LIST_ID = Deno.env.get('CLICKUP_LENDERS_LIST_ID')

    const body = await req.json()
    const { action, emc_data, sync_clickup } = body

    if (action !== 'import_emc' || !Array.isArray(emc_data)) {
      return json({ error: 'Invalid action or missing emc_data' }, 400)
    }

    // Fetch all existing lenders for fuzzy matching
    const { data: existingLenders } = await sb.from('lenders').select('id, name')
    const lenderMap = new Map<string, { id: string; name: string }>()
    for (const l of (existingLenders || [])) {
      lenderMap.set(normName(l.name), { id: l.id, name: l.name })
    }

    let updated = 0, inserted = 0, clickup_synced = 0
    const errors: string[] = []

    for (const emc of emc_data) {
      try {
        const ae = emc.Primary_Account_Executive__r || {}
        const loanTypes = emc.Loan_Types_Offered__c ? emc.Loan_Types_Offered__c.split(';').map((s: string) => s.trim()) : null
        const loanPrograms = emc.Loan_Programs_Offered__c ? emc.Loan_Programs_Offered__c.split(';').map((s: string) => s.trim()) : null
        const channels = emc.Channel__c ? emc.Channel__c.split(';').map((s: string) => s.trim()) : null

        const lenderData: Record<string, any> = {
          loan_types: loanTypes,
          loan_programs: loanPrograms,
          channel: channels ? channels.join(', ') : null,
          preferred_lender: emc.Preferred_Lender__c || false,
          rating: emc.Rating__c || null,
          lender_portal: emc.Lender_Portal__c || null,
          nmls: emc.NMLS__c || null,
          min_credit_score: emc.Min_Score__c || null,
          revenue_notes: emc.Revenue_Notes__c || null,
          fee_notes: emc.Fee_Notes__c || null,
          avg_app_to_fund: emc.App_to_Funded__c || null,
          count_app_to_funded: emc.Count_App_to_Funded__c || null,
          contact_name: ae.Name || null,
          contact_email: ae.Email || null,
          contact_phone: ae.OfficePhone__c || null,
          emc_source: true,
          updated_at: new Date().toISOString(),
        }

        // Try to find existing lender by normalized name
        const normKey = normName(emc.Name)
        const existing = lenderMap.get(normKey)

        if (existing) {
          // Update existing lender
          const { error } = await sb.from('lenders').update(lenderData).eq('id', existing.id)
          if (error) { errors.push(`Update ${emc.Name}: ${error.message}`); continue }
          updated++
        } else {
          // Insert new lender
          lenderData.name = emc.Name
          lenderData.is_active = true
          const { data: newLender, error } = await sb.from('lenders').insert(lenderData).select('id').single()
          if (error) { errors.push(`Insert ${emc.Name}: ${error.message}`); continue }
          inserted++
          // Add to map so dupes in same batch don't re-insert
          lenderMap.set(normKey, { id: newLender.id, name: emc.Name })
        }

        // Optional ClickUp sync
        if (sync_clickup && CLICKUP_TOKEN && CLICKUP_LENDERS_LIST_ID) {
          try {
            const taskName = emc.Preferred_Lender__c ? `${emc.Name} ⭐ PREFERRED` : emc.Name
            const description = [
              `NMLS: ${emc.NMLS__c || 'N/A'}`,
              `Channel: ${emc.Channel__c || 'N/A'}`,
              `Min Credit: ${emc.Min_Score__c || 'N/A'}`,
              `Loan Types: ${emc.Loan_Types_Offered__c || 'N/A'}`,
              `Revenue: ${emc.Revenue_Notes__c || 'N/A'}`,
              `Fees: ${emc.Fee_Notes__c || 'N/A'}`,
              `Avg App to Fund: ${emc.App_to_Funded__c || 'N/A'} days`,
              `Lender Portal: ${emc.Lender_Portal__c || 'N/A'}`,
              `AE: ${ae.Name || 'N/A'} | ${ae.Email || ''} | ${ae.OfficePhone__c || ''}`,
            ].join('\n')

            const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LENDERS_LIST_ID}/task`, {
              method: 'POST',
              headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: taskName, description, status: 'active' })
            })
            if (res.ok) clickup_synced++
          } catch (_) { /* ClickUp sync is best-effort */ }
        }
      } catch (e) {
        errors.push(`${emc.Name}: ${(e as Error).message}`)
      }
    }

    return json({ success: true, updated, inserted, clickup_synced, errors: errors.length ? errors : undefined })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
