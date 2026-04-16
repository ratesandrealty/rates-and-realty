import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const CLICKUP_TOKEN = Deno.env.get('CLICKUP_API_TOKEN')
    if (!CLICKUP_TOKEN) throw new Error('CLICKUP_API_TOKEN not set')

    const body = await req.json()
    const { action } = body

    // ── FETCH INCOMPLETE TASKS (HIGH + MEDIUM PRIORITY LISTS) ─────
    // Used by the admin calendar to overlay ClickUp tasks on appointment cells.
    // Returns a merged list with normalized fields suitable for rendering.
    if (action === 'fetch_incomplete_tasks') {
      const HIGH_LIST = Deno.env.get('CLICKUP_LIST_HIGH') || '901712241684'
      const MED_LIST  = Deno.env.get('CLICKUP_LIST_MEDIUM') || '901712241685'

      async function fetchList(listId: string, priorityLabel: string) {
        const out: any[] = []
        let page = 0
        while (true) {
          const res = await fetch(
            `https://api.clickup.com/api/v2/list/${listId}/task?page=${page}&include_closed=false&subtasks=false&archived=false`,
            { headers: { Authorization: CLICKUP_TOKEN! } }
          )
          if (!res.ok) break
          const data = await res.json()
          if (!data.tasks || data.tasks.length === 0) break
          for (const t of data.tasks) {
            const type = (t.status?.type || '').toLowerCase()
            if (type === 'closed' || type === 'done') continue
            out.push({
              id: t.id,
              name: t.name || '',
              url: t.url || '',
              due_date: t.due_date ? new Date(parseInt(t.due_date, 10)).toISOString() : null,
              priority: t.priority?.priority || priorityLabel,
              priority_label: priorityLabel,
              status: t.status?.status || '',
              list_id: listId,
            })
          }
          if (data.tasks.length < 100) break
          page++
        }
        return out
      }

      const [high, medium] = await Promise.all([
        fetchList(HIGH_LIST, 'high'),
        fetchList(MED_LIST, 'medium'),
      ])
      const tasks = [...high, ...medium]
      return json({ success: true, tasks, count: tasks.length, by_list: { high: high.length, medium: medium.length } })
    }

    // ── SYNC LENDERS FROM CLICKUP ──────────────────────
    if (action === 'sync_lenders') {
      const LIST_ID = Deno.env.get('CLICKUP_LENDERS_LIST_ID') || body.list_id
      if (!LIST_ID) throw new Error('No list_id provided and CLICKUP_LENDERS_LIST_ID not set')

      // Fetch all tasks from ClickUp list
      let allTasks: any[] = []
      let page = 0
      while (true) {
        const res = await fetch(
          `https://api.clickup.com/api/v2/list/${LIST_ID}/task?page=${page}&include_closed=true&subtasks=true`,
          { headers: { Authorization: CLICKUP_TOKEN } }
        )
        const data = await res.json()
        if (!data.tasks || data.tasks.length === 0) break
        allTasks = allTasks.concat(data.tasks)
        if (data.tasks.length < 100) break
        page++
      }

      let count = 0
      for (const task of allTasks) {
        // Extract custom fields
        const cf: Record<string, any> = {}
        for (const field of (task.custom_fields || [])) {
          const name = (field.name || '').toLowerCase().replace(/\s+/g, '_')
          cf[name] = field.value ?? field.type_config?.options?.find((o: any) => o.orderindex === field.value)?.name ?? null
          // Handle dropdown type
          if (field.type === 'drop_down' && field.value != null) {
            cf[name] = field.type_config?.options?.[field.value]?.name || field.value
          }
          // Handle labels type
          if (field.type === 'labels' && Array.isArray(field.value)) {
            cf[name] = field.value.map((idx: number) => field.type_config?.options?.[idx]?.label || idx)
          }
        }

        // Extract tags from ClickUp task
        const taskTags = (task.tags || []).map((t: any) => t.name || t)

        // Extract notes from task description
        const taskDescription = task.description || task.markdown_description || ''
        // Parse structured fields from description
        const minCreditMatch = taskDescription.match(/Min Credit[:\s]+(\d+)/i)
        const channelMatch = taskDescription.match(/Channel[:\s]+([^\n]+)/i)
        const avgFundMatch = taskDescription.match(/Avg App to Fund[:\s]+([^\n(]+)/i)
        const portalMatch = taskDescription.match(/Lender Portal[:\s]+([^\n]+)/i)
        const usernameMatch = taskDescription.match(/Username[:\s]+([^\n]+)/i)
        const loanTypesMatch = taskDescription.match(/Loan Types[:\s]+([^\n]+)/i)

        const lenderData: Record<string, any> = {
          name: task.name,
          clickup_id: task.id,
          clickup_url: task.url,
          is_active: task.status?.status?.toLowerCase() !== 'closed',
          lender_type: cf.lender_type || cf.type || null,
          programs: cf.programs || cf.loan_programs || null,
          min_credit_score: cf.min_credit_score || cf.min_fico || (minCreditMatch?.[1] ? parseInt(minCreditMatch[1]) : null),
          max_ltv: cf.max_ltv ? parseFloat(cf.max_ltv) : null,
          max_loan_amount: cf.max_loan_amount ? parseFloat(cf.max_loan_amount) : null,
          min_loan_amount: cf.min_loan_amount ? parseFloat(cf.min_loan_amount) : null,
          contact_name: cf.contact_name || cf.rep_name || null,
          contact_email: cf.contact_email || cf.rep_email || cf.email || null,
          contact_phone: cf.contact_phone || cf.rep_phone || cf.phone || null,
          website: cf.website || cf.url || null,
          priority: task.priority?.priority?.toLowerCase() || null,
          tags: taskTags,
          clickup_notes: taskDescription.substring(0, 500),
          channel: channelMatch?.[1]?.trim() || null,
          avg_app_to_fund: avgFundMatch?.[1]?.trim() || null,
          lender_portal: portalMatch?.[1]?.trim() || null,
          username: usernameMatch?.[1]?.trim() || null,
          loan_types: loanTypesMatch ? loanTypesMatch[1].split(',').map((s: string) => s.trim()) : null,
          min_credit: minCreditMatch?.[1] || null,
          updated_at: new Date().toISOString(),
        }

        // Upsert by clickup_id
        const { error } = await sb.from('lenders').upsert(lenderData, { onConflict: 'clickup_id' })
        if (!error) count++
      }

      return json({ success: true, count, total: allTasks.length })
    }

    // ── UPDATE LENDER IN CLICKUP ──────────────────────
    if (action === 'update_lender') {
      const { task_id, notes, contact_name, contact_email, contact_phone, website } = body
      if (!task_id) throw new Error('task_id required')

      // Update task description in ClickUp
      const updateBody: Record<string, any> = {}
      if (notes) updateBody.description = notes

      const res = await fetch(`https://api.clickup.com/api/v2/task/${task_id}`, {
        method: 'PUT',
        headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(updateBody),
      })
      const data = await res.json()
      return json({ success: true, task: data })
    }

    return json({ error: 'Unknown action: ' + action }, 400)

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}
