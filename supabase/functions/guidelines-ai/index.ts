import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

// Root GDrive folder IDs
const GDRIVE_LENDERS_FOLDER = '1Pg6GkbwzgiIp3PfZqP4oXycw7tLKUN8p';
const GDRIVE_GUIDELINES_FOLDER = '1lHCzRSy5Louw9N2ooqjdfnDXNLKYVniM';
const GDRIVE_BASE = 'https://drive.google.com/drive/folders/';
const GDRIVE_FILE_BASE = 'https://drive.google.com/file/d/';

// Generate a Drive search URL for a lender's folder
function lenderDriveSearchUrl(lenderName: string): string {
  const q = encodeURIComponent(`"${lenderName}" in parents:${GDRIVE_LENDERS_FOLDER}`);
  return `https://drive.google.com/drive/search?q=${q}`;
}

// Generate a Drive folder URL from ID
function driveFolderUrl(folderId: string): string {
  return `${GDRIVE_BASE}${folderId}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const body = await req.json();
    const { action } = body;
    if (action === 'chat') return await handleChat(body);
    if (action === 'index_guideline') return await indexGuideline(body);
    if (action === 'search') return await searchGuidelines(body);
    if (action === 'get_lender_context') return await getLenderContext(body);
    if (action === 'update_gdrive') return await updateGDrive(body);
    if (action === 'get_drive_config') return await getDriveConfig();
    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: cors });
  } catch(e: any) {
    console.error('guidelines-ai error:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});

async function callClaude(system: string, userMsg: string, history: any[] = [], maxTokens = 1500): Promise<string> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system,
      messages: [...history, { role: 'user', content: userMsg }]
    })
  });
  const d = await resp.json();
  return d.content?.[0]?.text || '';
}

async function handleChat(body: any) {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { question, lender_id, lender_ids, session_id, portal_user_id } = body;
  const targetIds: string[] = lender_ids || (lender_id ? [lender_id] : []);

  // Pull lender data
  let lenderCtx = '';
  let lenderNames: Record<string,string> = {};
  if (targetIds.length > 0) {
    const { data: lenders } = await sb.from('lenders')
      .select('id,name,channel,min_credit_score,max_ltv,loan_programs,key_overlays,specialty_notes,states_licensed,compensation_type,compensation_bps,epo_policy,submission_checklist,guidelines_url,gdrive_folder_id,gdrive_folder_url')
      .in('id', targetIds);
    if (lenders?.length) {
      lenderCtx = lenders.map((l: any) => {
        lenderNames[l.id] = l.name;
        const programs = Array.isArray(l.loan_programs) ? l.loan_programs.join(', ') : (l.loan_programs || 'N/A');
        const states = Array.isArray(l.states_licensed) ? l.states_licensed.join(', ') : (l.states_licensed || 'N/A');
        // Build Drive URL — use stored folder or generate search link
        const driveUrl = l.gdrive_folder_url || (l.gdrive_folder_id ? driveFolderUrl(l.gdrive_folder_id) : `${GDRIVE_BASE}${GDRIVE_LENDERS_FOLDER}`);
        return `LENDER: ${l.name}\nChannel: ${l.channel||'N/A'} | Min FICO: ${l.min_credit_score||'N/A'} | Max LTV: ${l.max_ltv||'N/A'}\nPrograms: ${programs}\nStates: ${states}\nOverlays: ${l.key_overlays||'N/A'}\nNotes: ${l.specialty_notes||'N/A'}\nComp: ${l.compensation_type||''} ${l.compensation_bps?l.compensation_bps+'bps':''}\nEPO: ${l.epo_policy||'N/A'}\nGuidelines URL: ${l.guidelines_url||'N/A'}\nGoogle Drive Folder: ${driveUrl}`;
      }).join('\n\n');
    }
  } else {
    const { data: all } = await sb.from('lenders').select('id,name,channel,min_credit_score,loan_programs,states_licensed,gdrive_folder_url').order('name');
    if (all?.length) {
      lenderCtx = `All Lenders (${all.length} total):\n` + all.map((l: any) => {
        lenderNames[l.id] = l.name;
        const progs = Array.isArray(l.loan_programs) ? l.loan_programs.slice(0,3).join(',') : 'N/A';
        return `${l.name}: ${l.channel||'N/A'} | FICO>=${l.min_credit_score||'?'} | ${progs}${l.gdrive_folder_url?' | Drive: '+l.gdrive_folder_url:''}`;
      }).join('\n');
    }
  }

  // Pull guidelines with Drive info
  const gQuery = targetIds.length > 0
    ? sb.from('lender_guidelines').select('id,title,category,content_notes,ai_summary,key_requirements,min_fico,max_ltv,loan_types,states_available,file_url,gdrive_file_id,gdrive_file_url,lender_id').in('lender_id', targetIds)
    : sb.from('lender_guidelines').select('id,title,category,content_notes,ai_summary,lender_id').limit(30);
  const { data: guidelines } = await gQuery;

  let docsCtx = '';
  if (guidelines?.length) {
    const { data: lns } = await sb.from('lenders').select('id,name').in('id', guidelines.map((g: any) => g.lender_id));
    const lmap: Record<string,string> = {};
    (lns||[]).forEach((l: any) => { lmap[l.id] = l.name; });

    docsCtx = '\nUPLOADED GUIDELINE DOCUMENTS:\n' + guidelines.map((g: any) => {
      const lname = lmap[g.lender_id] || 'Unknown';
      const driveLink = g.gdrive_file_url ? `Drive: ${g.gdrive_file_url}` : (g.gdrive_file_id ? `Drive: ${GDRIVE_FILE_BASE}${g.gdrive_file_id}/view` : `Drive folder: ${GDRIVE_BASE}${GDRIVE_GUIDELINES_FOLDER}`);
      const parts = [`${lname} - ${g.title} (${g.category})`];
      if (g.ai_summary) parts.push('Summary: ' + g.ai_summary);
      if (g.content_notes) parts.push('Notes: ' + g.content_notes);
      if (g.min_fico) parts.push('Min FICO: ' + g.min_fico);
      if (g.max_ltv) parts.push('Max LTV: ' + g.max_ltv);
      if (Array.isArray(g.loan_types) && g.loan_types.length) parts.push('Types: ' + g.loan_types.join(','));
      if (Array.isArray(g.key_requirements) && g.key_requirements.length) parts.push('Key reqs: ' + g.key_requirements.slice(0,3).join(' | '));
      parts.push(driveLink);
      return parts.join(' | ');
    }).join('\n');
  }

  // Load session history
  let history: any[] = [];
  if (session_id) {
    const { data: msgs } = await sb.from('guideline_chat_messages').select('role,content').eq('session_id', session_id).order('created_at', { ascending: true }).limit(20);
    if (msgs) history = msgs.map((m: any) => ({ role: m.role, content: m.content }));
  }

  const system = `You are an expert mortgage lending AI assistant for Rates & Realty (Rene Duarte, NMLS #1795044, Huntington Beach CA).

You have access to a live database of lenders and their uploaded guideline documents. Always:
- Cite the specific lender by name
- Reference guideline documents by title when answering from them
- Include Google Drive links when available so Rene can view the source document
- Be specific about FICO, LTV, programs, overlays, states, and submission requirements
- Think like an experienced mortgage broker helping place a loan

Google Drive root folders:
- All Lender folders: https://drive.google.com/drive/folders/${GDRIVE_LENDERS_FOLDER}
- All Guidelines: https://drive.google.com/drive/folders/${GDRIVE_GUIDELINES_FOLDER}

${lenderCtx}
${docsCtx}`;

  const answer = await callClaude(system, question, history.slice(0,-1), 1500);

  // Save session
  let sid = session_id;
  if (!sid && portal_user_id) {
    const { data: ns } = await sb.from('guideline_chat_sessions').insert({ portal_user_id, lender_id: targetIds[0]||null, session_name: question.slice(0,80) }).select('id').single();
    sid = ns?.id;
  }
  if (sid) {
    await sb.from('guideline_chat_messages').insert([
      { session_id: sid, role: 'user', content: question, lender_ids: targetIds },
      { session_id: sid, role: 'assistant', content: answer, lender_ids: targetIds,
        sources: (guidelines||[]).map((g: any) => ({ id: g.id, title: g.title, file_url: g.file_url, gdrive_file_url: g.gdrive_file_url })) }
    ]);
  }

  return new Response(JSON.stringify({
    success: true, answer, session_id: sid,
    drive: {
      lenders_folder: `${GDRIVE_BASE}${GDRIVE_LENDERS_FOLDER}`,
      guidelines_folder: `${GDRIVE_BASE}${GDRIVE_GUIDELINES_FOLDER}`
    },
    sources: (guidelines||[]).map((g: any) => ({
      id: g.id, title: g.title, category: g.category,
      file_url: g.file_url,
      gdrive_file_url: g.gdrive_file_url || (g.gdrive_file_id ? `${GDRIVE_FILE_BASE}${g.gdrive_file_id}/view` : null)
    }))
  }), { headers: { ...cors, 'Content-Type': 'application/json' } });
}

async function indexGuideline(body: any) {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { guideline_id } = body;
  const { data: g } = await sb.from('lender_guidelines').select('*, lenders(name)').eq('id', guideline_id).single();
  if (!g) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: cors });

  const prompt = `Analyze this mortgage lender guideline document and return ONLY a JSON object (no markdown, no backticks):
{"ai_summary":"2-3 sentence summary of what this document covers","min_fico":null or number,"max_ltv":null or number as decimal (0.80 = 80%),"loan_types":[],"states_available":[],"key_requirements":[]}

Lender: ${(g as any).lenders?.name}\nTitle: ${g.title}\nCategory: ${g.category}\nNotes: ${g.content_notes||'None provided'}`;

  const raw = await callClaude('Extract structured data from mortgage guideline documents. Return only valid JSON, no markdown.', prompt, [], 500);
  let extracted: any = {};
  try { extracted = JSON.parse(raw.replace(/```json|```/g,'').trim()); } catch { extracted = { ai_summary: raw.slice(0,300) }; }

  await sb.from('lender_guidelines').update({
    ai_summary: extracted.ai_summary,
    min_fico: extracted.min_fico || null,
    max_ltv: extracted.max_ltv || null,
    loan_types: extracted.loan_types || [],
    states_available: extracted.states_available || [],
    key_requirements: extracted.key_requirements || [],
    ai_indexed_at: new Date().toISOString()
  }).eq('id', guideline_id);

  return new Response(JSON.stringify({ success: true, extracted }), { headers: { ...cors, 'Content-Type': 'application/json' } });
}

async function searchGuidelines(body: any) {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { fico, ltv, loan_type, state, question } = body;

  let query = sb.from('lenders')
    .select('id,name,channel,min_credit_score,max_ltv,loan_programs,states_licensed,key_overlays,specialty_notes,compensation_bps,guidelines_url,gdrive_folder_id,gdrive_folder_url')
    .order('name');
  if (fico) query = query.lte('min_credit_score', fico);
  const { data: lenders } = await query;
  if (!lenders) return new Response(JSON.stringify({ lenders: [] }), { headers: cors });

  let filtered = lenders;
  if (state) {
    filtered = filtered.filter((l: any) => {
      if (!l.states_licensed) return true;
      const s = Array.isArray(l.states_licensed) ? l.states_licensed : [l.states_licensed];
      return s.some((st: string) => st.toUpperCase().includes(state.toUpperCase()) || st === 'All States' || st === 'All');
    });
  }
  if (loan_type) {
    filtered = filtered.filter((l: any) => {
      const p = Array.isArray(l.loan_programs) ? l.loan_programs.join(' ') : (l.loan_programs || '');
      return p.toLowerCase().includes(loan_type.toLowerCase());
    });
  }

  // Add Drive URLs to results
  filtered = filtered.map((l: any) => ({
    ...l,
    gdrive_folder_url: l.gdrive_folder_url || (l.gdrive_folder_id ? driveFolderUrl(l.gdrive_folder_id) : null)
  }));

  let aiRanking = '';
  if (question && filtered.length > 0) {
    const list = filtered.slice(0,15).map((l: any) => {
      const p = Array.isArray(l.loan_programs) ? l.loan_programs.slice(0,3).join(',') : 'N/A';
      return `${l.name}: FICO>=${l.min_credit_score||'?'}, LTV<=${l.max_ltv||'?'}, Programs: ${p}`;
    }).join('\n');
    aiRanking = await callClaude(
      'You are a mortgage lending expert. Rank lenders for a scenario concisely.',
      `Scenario: ${question}\n\nAvailable lenders:\n${list}\n\nRank the top 5 best fits and explain in 1-2 sentences each why they match.`,
      [], 600
    );
  }

  return new Response(JSON.stringify({
    success: true, total: filtered.length,
    lenders: filtered.slice(0,20),
    ai_ranking: aiRanking,
    drive: {
      lenders_folder: `${GDRIVE_BASE}${GDRIVE_LENDERS_FOLDER}`,
      guidelines_folder: `${GDRIVE_BASE}${GDRIVE_GUIDELINES_FOLDER}`
    }
  }), { headers: { ...cors, 'Content-Type': 'application/json' } });
}

async function getLenderContext(body: any) {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { lender_id } = body;
  const [{ data: lender }, { data: guidelines }] = await Promise.all([
    sb.from('lenders').select('*').eq('id', lender_id).single(),
    sb.from('lender_guidelines').select('*').eq('lender_id', lender_id).order('created_at', { ascending: false })
  ]);

  // Enrich lender with Drive URL if folder ID exists
  const enrichedLender = lender ? {
    ...lender,
    gdrive_folder_url: (lender as any).gdrive_folder_url || ((lender as any).gdrive_folder_id ? driveFolderUrl((lender as any).gdrive_folder_id) : null),
    gdrive_lenders_root: `${GDRIVE_BASE}${GDRIVE_LENDERS_FOLDER}`,
    gdrive_guidelines_root: `${GDRIVE_BASE}${GDRIVE_GUIDELINES_FOLDER}`
  } : null;

  // Enrich guidelines with Drive file URLs
  const enrichedGuidelines = (guidelines||[]).map((g: any) => ({
    ...g,
    gdrive_file_url: g.gdrive_file_url || (g.gdrive_file_id ? `${GDRIVE_FILE_BASE}${g.gdrive_file_id}/view` : null)
  }));

  return new Response(JSON.stringify({ success: true, lender: enrichedLender, guidelines: enrichedGuidelines }), {
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

async function updateGDrive(body: any) {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { type, id, gdrive_folder_id, gdrive_folder_url, gdrive_file_id, gdrive_file_url } = body;

  if (type === 'lender') {
    const url = gdrive_folder_url || (gdrive_folder_id ? driveFolderUrl(gdrive_folder_id) : null);
    await sb.from('lenders').update({ gdrive_folder_id, gdrive_folder_url: url }).eq('id', id);
  } else if (type === 'guideline') {
    const url = gdrive_file_url || (gdrive_file_id ? `${GDRIVE_FILE_BASE}${gdrive_file_id}/view` : null);
    await sb.from('lender_guidelines').update({ gdrive_file_id, gdrive_file_url: url }).eq('id', id);
  }
  return new Response(JSON.stringify({ success: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
}

async function getDriveConfig() {
  return new Response(JSON.stringify({
    success: true,
    lenders_folder_id: GDRIVE_LENDERS_FOLDER,
    lenders_folder_url: `${GDRIVE_BASE}${GDRIVE_LENDERS_FOLDER}`,
    guidelines_folder_id: GDRIVE_GUIDELINES_FOLDER,
    guidelines_folder_url: `${GDRIVE_BASE}${GDRIVE_GUIDELINES_FOLDER}`
  }), { headers: { ...cors, 'Content-Type': 'application/json' } });
}
