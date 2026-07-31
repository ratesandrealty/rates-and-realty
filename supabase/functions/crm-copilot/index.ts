import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const MODEL = 'claude-sonnet-4-6';
const MAX_TOOL_ITERATIONS = 6;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SYSTEM_PROMPT = `You are the CRM Copilot inside the Rates & Realty mortgage CRM, assisting Rene (the loan officer/admin). You help him understand and act on his leads, pipeline, calendar, and business. Today's date and time is provided in the first user message context when relevant; otherwise reason from the calendar data you read.

READ TOOLS (run immediately): get_overview, search_leads, priority_leads, get_lead, stale_leads, pipeline_report, read_calendar. Use them whenever a question depends on live data — never guess. To act on a specific person, call search_leads first to get their contact_id. For schedule questions ("what's on my calendar", "am I free Thursday", "what's next week look like") use read_calendar.

ACTION TOOLS (these PROPOSE only — they do NOT execute; the user must click Confirm):
- propose_message (draft an SMS or email to a lead)
- propose_task (create a task/reminder on a lead)
- propose_note (add a note to a lead)
- propose_status_change (update a lead's pipeline stage, lead status, or next follow-up date)
- propose_appointment (schedule a calendar event/appointment — on confirm it's created and synced to Google Calendar)
- propose_loe (draft a Letter of Explanation — opens the lead's LOE tool prefilled)
- propose_esign (open the lead's e-signature composer prefilled)
When Rene asks you to do one of these, FIRST get the lead's contact_id via search_leads if a lead is involved, then call the propose_* tool to STAGE it. It will not happen until Rene confirms. After staging, briefly tell him what you prepared. You may stage more than one action.

For propose_appointment: provide a title, a start datetime in ISO 8601 with the Pacific timezone offset (e.g. 2026-07-10T15:00:00-07:00), duration_minutes (default 30), optional contact_id (if the appointment is with a specific lead) and notes. If the user gives a vague time ("tomorrow at 3"), resolve it against the current date to a concrete ISO datetime. Confirm the day/time back to the user in your reply.

When drafting messages, write in Rene's voice: professional but warm, concise, mortgage-appropriate. Never fabricate rates, numbers, or commitments.

Style: concise, direct, practical. Lead with the answer. Recommendations specific and actionable. Money as USD. Dates relative when useful.`;

const TOOLS = [
  { name: 'get_overview', description: 'CRM dashboard overview: pipeline counts by stage, hot leads, escrow/closings, key metrics.', input_schema: { type: 'object', properties: {} } },
  { name: 'search_leads', description: 'Search leads by name or phone. Returns matches with pipeline status, score, tier, phone, loan purpose, last contact.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'priority_leads', description: 'Highest-priority leads to work now, ranked by score and time since contact.', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'get_lead', description: 'Full detail on one lead by contact_id: profile, recent notes, potential earnings. search_leads first.', input_schema: { type: 'object', properties: { contact_id: { type: 'string' } }, required: ['contact_id'] } },
  { name: 'stale_leads', description: 'Leads gone quiet needing follow-up (no contact in N days).', input_schema: { type: 'object', properties: { quiet_days: { type: 'number' } } } },
  { name: 'pipeline_report', description: 'Production/pipeline report between two dates (YYYY-MM-DD).', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
  { name: 'read_calendar', description: 'Read Rene live Google Calendar (appointments, tours, events). Use for schedule questions. Optional from/to as YYYY-MM-DD (defaults: today through +14 days).', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },

  { name: 'propose_message', description: 'PROPOSE (stage for confirmation) a text or email draft to a lead. Does NOT send. Provide contact_id, channel (sms|email), and body (and subject for email).', input_schema: { type: 'object', properties: { contact_id: { type: 'string' }, contact_name: { type: 'string' }, channel: { type: 'string', enum: ['sms', 'email'] }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['contact_id', 'channel', 'body'] } },
  { name: 'propose_task', description: 'PROPOSE (stage for confirmation) creating a task/reminder on a lead. priority: low|normal|high. due_date YYYY-MM-DD.', input_schema: { type: 'object', properties: { contact_id: { type: 'string' }, contact_name: { type: 'string' }, title: { type: 'string' }, priority: { type: 'string' }, due_date: { type: 'string' }, description: { type: 'string' } }, required: ['contact_id', 'title'] } },
  { name: 'propose_note', description: 'PROPOSE (stage for confirmation) adding a note to a lead.', input_schema: { type: 'object', properties: { contact_id: { type: 'string' }, contact_name: { type: 'string' }, text: { type: 'string' } }, required: ['contact_id', 'text'] } },
  { name: 'propose_status_change', description: 'PROPOSE (stage for confirmation) updating a lead pipeline_status, lead_status, and/or next_follow_up (YYYY-MM-DD).', input_schema: { type: 'object', properties: { contact_id: { type: 'string' }, contact_name: { type: 'string' }, pipeline_status: { type: 'string' }, lead_status: { type: 'string' }, next_follow_up: { type: 'string' } }, required: ['contact_id'] } },
  { name: 'propose_appointment', description: 'PROPOSE (stage for confirmation) a calendar appointment/event. On confirm it is created and synced to Google Calendar. Provide title, start (ISO 8601 w/ Pacific offset e.g. 2026-07-10T15:00:00-07:00), duration_minutes, optional contact_id + notes.', input_schema: { type: 'object', properties: { contact_id: { type: 'string' }, contact_name: { type: 'string' }, title: { type: 'string' }, start: { type: 'string' }, duration_minutes: { type: 'number' }, notes: { type: 'string' } }, required: ['title', 'start'] } },
  { name: 'propose_loe', description: 'PROPOSE (stage for confirmation) a Letter of Explanation. Confirming opens the lead LOE tool PREFILLED. Do NOT write the final letter yourself.', input_schema: { type: 'object', properties: { contact_id: { type: 'string' }, contact_name: { type: 'string' }, category: { type: 'string' }, details: { type: 'string' } }, required: ['contact_id', 'category'] } },
  { name: 'propose_esign', description: 'PROPOSE (stage for confirmation) sending a document for e-signature. Confirming opens the lead Send-for-signature composer.', input_schema: { type: 'object', properties: { contact_id: { type: 'string' }, contact_name: { type: 'string' }, note: { type: 'string' } }, required: ['contact_id'] } },
];

async function runTool(userClient: any, authHeader: string, name: string, input: any, proposals: any[]): Promise<any> {
  try {
    if (name === 'get_overview') {
      const [cc, snap] = await Promise.all([userClient.rpc('dashboard_command_center'), userClient.rpc('dashboard_snapshot')]);
      return { command_center: cc.data ?? cc.error?.message, snapshot: snap.data ?? snap.error?.message };
    }
    if (name === 'search_leads') {
      const { data, error } = await userClient.rpc('copilot_search_leads', { p_query: String(input?.query || '') });
      return error ? { error: error.message } : (data || []);
    }
    if (name === 'priority_leads') {
      const { data, error } = await userClient.rpc('copilot_priority_leads', { p_limit: input?.limit ? Number(input.limit) : 15 });
      return error ? { error: error.message } : (data || []);
    }
    if (name === 'get_lead') {
      const cid = String(input?.contact_id || '');
      if (!cid) return { error: 'contact_id required' };
      const [people, notes, earn] = await Promise.all([
        userClient.rpc('get_lead_people', { p_contact_id: cid, p_application_id: null }),
        userClient.rpc('contact_recent_notes', { p_contact_id: cid, p_limit: 10 }),
        userClient.rpc('lead_potential_earnings', { p_contact_id: cid }),
      ]);
      return { people: people.data ?? people.error?.message, recent_notes: notes.data ?? notes.error?.message, potential_earnings: earn.data ?? earn.error?.message };
    }
    if (name === 'stale_leads') {
      const { data, error } = await userClient.rpc('surface_stale_leads', { p_dry_run: true, p_quiet_days: input?.quiet_days ? Number(input.quiet_days) : 7 });
      return error ? { error: error.message } : (data || []);
    }
    if (name === 'pipeline_report') {
      const { data, error } = await userClient.rpc('production_report', { p_from: String(input?.from), p_to: String(input?.to) });
      return error ? { error: error.message } : (data || []);
    }
    if (name === 'read_calendar') {
      const now = new Date();
      const start = input?.from ? new Date(input.from + 'T00:00:00') : now;
      const end = input?.to ? new Date(input.to + 'T23:59:59') : new Date(now.getTime() + 14 * 864e5);
      const url = `${SUPABASE_URL}/functions/v1/calendar-data?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
      const r = await fetch(url, { headers: { Authorization: authHeader, apikey: ANON_KEY } });
      const d = await r.json().catch(() => ({}));
      const events = Array.isArray(d) ? d : (d.events || d.data || []);
      const trimmed = (Array.isArray(events) ? events : []).slice(0, 60).map((e: any) => ({
        title: e.title || e.summary || '(untitled)',
        start: e.start || e.start_time || e.startTime || '',
        end: e.end || e.end_time || e.endTime || '',
        source: e.source || e.calendar || e.type || '',
      }));
      return { window: { from: start.toISOString(), to: end.toISOString() }, count: trimmed.length, events: trimmed };
    }

    if (name === 'propose_message') {
      proposals.push({ type: 'message', contact_id: input.contact_id, contact_name: input.contact_name || '', channel: input.channel || 'sms', subject: input.subject || '', body: input.body || '' });
      return { staged: true, note: 'Message draft staged — awaiting user Confirm. Do not claim it was sent.' };
    }
    if (name === 'propose_task') {
      proposals.push({ type: 'task', contact_id: input.contact_id, contact_name: input.contact_name || '', title: input.title || 'Task', priority: input.priority || 'normal', due_date: input.due_date || '', description: input.description || '' });
      return { staged: true, note: 'Task staged — awaiting user Confirm.' };
    }
    if (name === 'propose_note') {
      proposals.push({ type: 'note', contact_id: input.contact_id, contact_name: input.contact_name || '', text: input.text || '' });
      return { staged: true, note: 'Note staged — awaiting user Confirm.' };
    }
    if (name === 'propose_status_change') {
      proposals.push({ type: 'status', contact_id: input.contact_id, contact_name: input.contact_name || '', pipeline_status: input.pipeline_status || '', lead_status: input.lead_status || '', next_follow_up: input.next_follow_up || '' });
      return { staged: true, note: 'Status change staged — awaiting user Confirm.' };
    }
    if (name === 'propose_appointment') {
      proposals.push({ type: 'appointment', contact_id: input.contact_id || '', contact_name: input.contact_name || '', title: input.title || 'Appointment', start: input.start || '', duration_minutes: input.duration_minutes || 30, notes: input.notes || '' });
      return { staged: true, note: 'Appointment staged — on Confirm it is created + synced to Google Calendar. Do not claim it was created yet.' };
    }
    if (name === 'propose_loe') {
      proposals.push({ type: 'loe', contact_id: input.contact_id, contact_name: input.contact_name || '', category: input.category || '', details: input.details || '' });
      return { staged: true, note: 'LOE staged — on Confirm it opens the lead LOE tool prefilled.' };
    }
    if (name === 'propose_esign') {
      proposals.push({ type: 'esign', contact_id: input.contact_id, contact_name: input.contact_name || '', note: input.note || '' });
      return { staged: true, note: 'E-sign staged — on Confirm it opens the lead Send-for-signature composer.' };
    }
    return { error: 'unknown tool ' + name };
  } catch (e: any) {
    return { error: String(e?.message || e) };
  }
}

function sanitizeHistory(raw: any): any[] {
  if (!Array.isArray(raw)) return [];
  const out: any[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const role = t.role === 'assistant' ? 'assistant' : (t.role === 'user' ? 'user' : null);
    if (!role) continue;
    let content = t.content;
    if (typeof content !== 'string') {
      if (Array.isArray(content)) {
        content = content.map((b: any) => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : (typeof b === 'string' ? b : '')).join('\n').trim();
      } else if (content == null) { content = ''; } else { content = String(content); }
    }
    content = String(content).slice(0, 8000);
    if (!content) continue;
    out.push({ role, content });
  }
  return out.slice(-12);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Not authenticated' }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData } = await userClient.auth.getUser();
    const user = userData?.user;
    if (!user) return json({ error: 'Invalid session' }, 401);

    const svc = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: roleRow } = await svc.from('auth_user_roles').select('role').eq('user_id', user.id).maybeSingle();
    const role = roleRow?.role || '';
    if (!['admin', 'agent', 'loa'].includes(role)) return json({ error: 'Copilot is available to admin/staff only.' }, 403);

    const body = await req.json().catch(() => ({}));
    const message = String(body?.message || '').slice(0, 4000);
    const history = sanitizeHistory(body?.history);
    if (!message) return json({ error: 'message required' }, 400);

    const nowCtx = `(Current date/time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} Pacific.)`;
    const messages: any[] = [...history, { role: 'user', content: `${nowCtx}\n\n${message}` }];
    const proposals: any[] = [];
    let finalText = '';
    const toolTrace: any[] = [];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: SYSTEM_PROMPT, tools: TOOLS, messages }),
      });
      const result = await resp.json();
      if (result.error) return json({ error: result.error.message || 'AI error' }, 200);

      const content = result.content || [];
      messages.push({ role: 'assistant', content });
      const textParts = content.filter((b: any) => b.type === 'text').map((b: any) => b.text);
      if (textParts.length) finalText = textParts.join('\n');

      const toolUses = content.filter((b: any) => b.type === 'tool_use');
      if (result.stop_reason !== 'tool_use' || toolUses.length === 0) break;

      const toolResults: any[] = [];
      for (const tu of toolUses) {
        const out = await runTool(userClient, authHeader, tu.name, tu.input || {}, proposals);
        toolTrace.push({ tool: tu.name });
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 12000) });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    return json({ reply: finalText || 'Done.', tools_used: toolTrace, proposed_actions: proposals });
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 200);
  }
});
