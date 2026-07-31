import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY');

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const body = await req.json();
    const { action } = body;

    switch (action) {
      case 'list':         return ok(await listGuidelines(body));
      case 'get':          return ok(await getGuideline(body));
      case 'create':       return ok(await createGuideline(body));
      case 'update':       return ok(await updateGuideline(body));
      case 'delete':       return ok(await deleteGuideline(body));
      case 'process':      return ok(await processGuideline(body));
      case 'search':       return ok(await searchGuidelines(body));
      case 'chat':         return ok(await chatWithGuidelines(body));
      case 'quick_answer': return ok(await quickAnswer(body));
      case 'save_answer':  return ok(await saveAnswer(body));
      case 'get_tags':     return ok(await getTags());
      case 'get_stats':    return ok(await getStats());
      case 'qualify_borrower': return ok(await qualifyBorrower(body));
      default: return err('Unknown action: ' + action);
    }
  } catch(e: any) {
    console.error('guidelines-library error:', e);
    return err(e.message);
  }
});

const ok = (data: any) => new Response(JSON.stringify({ success: true, ...data }), { headers: { ...cors, 'Content-Type': 'application/json' } });
const err = (msg: string, status = 500) => new Response(JSON.stringify({ success: false, error: msg }), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// ── LIST guidelines with filters ────────────────────────────────────────────────
async function listGuidelines(body: any) {
  const { agency, loan_type, category, lender_id, search, limit = 50, offset = 0, status } = body;
  
  let q = sb.from('global_guidelines')
    .select('*, lenders!lender_id(name)')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (agency && agency !== 'ALL') q = q.eq('agency', agency);
  if (lender_id) q = q.eq('lender_id', lender_id);
  if (status) q = q.eq('processing_status', status);
  if (category) q = q.eq('category', category);
  if (loan_type) q = q.contains('loan_types', [loan_type]);
  if (search) q = q.ilike('title', `%${search}%`);

  const { data, error, count } = await q;
  if (error) throw error;
  return { guidelines: data || [], count };
}

// ── GET single guideline ────────────────────────────────────────────────────
async function getGuideline(body: any) {
  const { id } = body;
  
  // Increment view count
  await sb.from('global_guidelines').update({ view_count: sb.rpc('increment', { x: 1 }) }).eq('id', id);
  
  const { data, error } = await sb.from('global_guidelines')
    .select('*, lenders!lender_id(name, id)')
    .eq('id', id)
    .single();
  if (error) throw error;

  // Get chunk count
  const { count } = await sb.from('global_guideline_chunks').select('*', { count: 'exact', head: true }).eq('guideline_id', id);
  
  return { guideline: { ...data, chunk_count: count || 0 } };
}

// ── CREATE guideline record (before file upload) ─────────────────────────
async function createGuideline(body: any) {
  const { title, agency, category, loan_types, file_url, file_name, file_size, file_type,
          external_url, version, effective_date, expiry_date, tags, description,
          lender_id, min_fico, max_ltv, states_available, source_type } = body;

  const { data, error } = await sb.from('global_guidelines').insert({
    title, agency, category, loan_types, file_url, file_name, file_size, file_type,
    external_url, version, effective_date, expiry_date, tags, description,
    lender_id, min_fico, max_ltv, states_available, source_type: source_type || 'upload',
    is_active: true, processing_status: file_url ? 'ocr_processing' : 'ready',
    ocr_status: file_url ? 'pending' : null
  }).select().single();
  if (error) throw error;

  // If file URL provided, trigger OCR processing
  if (file_url && data) {
    triggerOCR(data.id, file_url, file_type).catch(e => console.error('OCR trigger failed:', e));
  }

  return { guideline: data };
}

// ── UPDATE guideline ─────────────────────────────────────────────────────────
async function updateGuideline(body: any) {
  const { id, ...updates } = body;
  delete updates.action;
  updates.updated_at = new Date().toISOString();
  
  const { data, error } = await sb.from('global_guidelines').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return { guideline: data };
}

// ── DELETE guideline + all chunks ────────────────────────────────────────────
async function deleteGuideline(body: any) {
  const { id } = body;
  
  // Delete chunks first
  await sb.from('global_guideline_chunks').delete().eq('guideline_id', id);
  
  // Delete the guideline record
  const { error } = await sb.from('global_guidelines').delete().eq('id', id);
  if (error) throw error;
  
  return { deleted: true };
}

// ── PROCESS: OCR + chunk + embed ───────────────────────────────────────────
async function processGuideline(body: any) {
  const { id } = body;
  
  // Get guideline
  const { data: gl, error } = await sb.from('global_guidelines').select('*').eq('id', id).single();
  if (error || !gl) throw new Error('Guideline not found');
  
  if (!gl.ocr_text && !gl.file_url) throw new Error('No text or file to process');

  let text = gl.ocr_text || '';
  
  // If no OCR text yet but file exists, trigger OCR first
  if (!text && gl.file_url) {
    await triggerOCR(id, gl.file_url, gl.file_type);
    return { status: 'ocr_triggered', message: 'OCR started. Re-process after OCR completes.' };
  }

  // Update status
  await sb.from('global_guidelines').update({ processing_status: 'chunking' }).eq('id', id);

  // Chunk the text
  const chunks = chunkText(text, 800, 100);
  
  // Update status
  await sb.from('global_guidelines').update({ processing_status: 'embedding' }).eq('id', id);

  // Delete existing chunks
  await sb.from('global_guideline_chunks').delete().eq('guideline_id', id);

  // Embed and insert chunks in batches of 20
  const BATCH = 20;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const embeddings = await embedBatch(batch.map(c => c.text));
    
    const rows = batch.map((c, j) => ({
      guideline_id: id,
      agency: gl.agency,
      chunk_index: i + j,
      page_number: c.page,
      chunk_text: c.text,
      chunk_tokens: Math.ceil(c.text.length / 4),
      embedding: embeddings[j] ? JSON.stringify(embeddings[j]) : null,
      category: gl.category,
      loan_types: gl.loan_types,
      topic_tags: extractTopics(c.text)
    }));
    
    const { error: insErr } = await sb.from('global_guideline_chunks').insert(rows);
    if (insErr) console.error('Chunk insert error:', insErr);
  }

  // Generate AI summary
  const summaryText = text.slice(0, 4000);
  const summary = await generateSummary(gl.title, gl.agency, summaryText);

  // Mark as ready
  await sb.from('global_guidelines').update({
    processing_status: 'ready',
    chunk_count: chunks.length,
    ai_summary: summary,
    ai_indexed_at: new Date().toISOString()
  }).eq('id', id);

  return { status: 'ready', chunks: chunks.length, summary };
}

// ── SEARCH: hybrid semantic + keyword ─────────────────────────────────────────
async function searchGuidelines(body: any) {
  const { query, agencies, loan_types, lender_id, limit = 8 } = body;
  if (!query) throw new Error('Query required');

  // Get embedding for query
  const [queryEmbedding] = await embedBatch([query]);
  
  if (!queryEmbedding) {
    // Fallback to keyword search
    const { data } = await sb.from('global_guideline_chunks')
      .select('*, global_guidelines!guideline_id(title, agency, file_url)')
      .textSearch('chunk_text', query.split(' ').join(' | '))
      .limit(limit);
    return { chunks: data || [], search_type: 'keyword' };
  }

  // Vector similarity search via RPC
  const { data: chunks, error } = await sb.rpc('match_guideline_chunks', {
    query_embedding: queryEmbedding,
    match_threshold: 0.65,
    match_count: limit,
    filter_agencies: agencies && agencies.length ? agencies : null,
    filter_loan_types: loan_types && loan_types.length ? loan_types : null
  });

  if (error) {
    // RPC not set up yet — fall back to text search
    console.error('Vector search RPC error:', error);
    const { data: kw } = await sb.from('global_guideline_chunks')
      .select('id, guideline_id, chunk_text, page_number, agency, loan_types, chunk_index')
      .limit(limit);
    return { chunks: kw || [], search_type: 'fallback_keyword' };
  }

  return { chunks: chunks || [], search_type: 'semantic' };
}

// ── CHAT: multi-turn AI conversation with context ──────────────────────────
async function chatWithGuidelines(body: any) {
  const { message, agencies, loan_types, history = [], contact_data, session_id } = body;
  if (!message) throw new Error('Message required');

  // Search for relevant chunks
  const searchResult = await searchGuidelines({ query: message, agencies, loan_types, limit: 10 });
  const chunks = searchResult.chunks || [];

  // Build context from chunks
  const context = chunks.map((c: any, i: number) => {
    const src = c.guideline_title || c.title || c.agency || 'Guideline';
    return `[${i+1}] Source: ${src} (pg ${c.page_number||'?'})\n${c.chunk_text}`;
  }).join('\n\n---\n\n');

  // Build contact context if provided
  let borrowerCtx = '';
  if (contact_data) {
    const cd = contact_data;
    borrowerCtx = `\n\nBORROWER PROFILE:\n- Name: ${cd.name||''}\n- Credit Score: ${cd.credit_score||'?'}\n- Loan Amount: ${cd.loan_amount||'?'}\n- LTV: ${cd.ltv||'?'}\n- DTI: ${cd.dti||'?'}\n- Income: ${cd.income||'?'}\n- Loan Type: ${cd.loan_type||'Conventional'}\n- Occupancy: ${cd.occupancy||'Primary Residence'}\n- Property: ${cd.property_type||'SFR'}`;
  }

  // Build conversation history
  const messages: any[] = [];
  for (const h of history.slice(-6)) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content: message });

  const systemPrompt = `You are an expert mortgage guideline AI assistant for Rates & Realty, a licensed mortgage brokerage. You have deep knowledge of FNMA, FHLMC, FHA, VA, DSCR, Non-QM, and DPA guidelines.

Your role:
- Answer questions about mortgage guidelines accurately and concisely
- Cite specific sources when referencing guideline content
- Flag important overlays, restrictions, or exceptions
- When analyzing a borrower, identify qualification issues and suggest solutions
- Be direct and professional — you're talking to a licensed loan officer

KEY RULES:
- Always verify answers against the provided guideline context
- If the answer isn't in the context, say so clearly
- Include page numbers and source names when citing
- Flag any conflicting guidelines between lenders
- Highlight critical thresholds (min FICO, max LTV, max DTI)
${borrowerCtx}

GUIDELINE CONTEXT:\n${context || 'No specific guidelines loaded. Answering from general knowledge.'}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: systemPrompt,
      messages
    })
  });

  const data = await response.json();
  const answer = data.content?.[0]?.text || 'Unable to generate response';

  // Build citations
  const citations = chunks.slice(0, 5).map((c: any) => ({
    guideline_id: c.guideline_id,
    title: c.guideline_title || c.title,
    agency: c.agency,
    page: c.page_number,
    excerpt: c.chunk_text?.slice(0, 200)
  }));

  // Log search
  if (session_id) {
    sb.from('guideline_search_history').insert({
      query: message,
      query_type: 'semantic',
      result_count: chunks.length,
      session_id
    }).then(() => {}).catch(() => {});
  }

  return { answer, citations, chunks_used: chunks.length };
}

// ── QUICK ANSWER for preset questions ───────────────────────────────────────
async function quickAnswer(body: any) {
  const { question_type, agencies, loan_types, contact_data } = body;
  
  const questionMap: Record<string, string> = {
    'min_credit': 'What are the minimum credit score requirements? Include all loan types.',
    'max_ltv': 'What are the maximum LTV limits? Include purchase, rate-term refi, and cash-out refi.',
    'income_docs': 'What income documentation is required? List all acceptable income types and documentation requirements.',
    'ca_dpa': 'What California down payment assistance programs are available? Include CalHFA, GSFA, and local programs.',
    'reserves': 'What are the reserve requirements? How many months and what assets are acceptable?',
    'qualify_borrower': contact_data ? `Can this borrower qualify? Analyze their profile and identify any issues or solutions.` : ''
  };

  const question = questionMap[question_type] || question_type;
  return chatWithGuidelines({ message: question, agencies, loan_types, contact_data, history: [] });
}

// ── QUALIFY BORROWER against loaded guidelines ────────────────────────────
async function qualifyBorrower(body: any) {
  const { contact_data, agencies, loan_types } = body;
  if (!contact_data) throw new Error('contact_data required');

  const question = `Analyze this borrower's profile and determine:
1. Which loan programs they QUALIFY for (list specific products)
2. Which programs they DON'T qualify for and WHY
3. Any EXCEPTIONS or overlays that could help
4. RECOMMENDED loan program and strategy
5. Any RED FLAGS or conditions to address

Be specific with numbers (exact FICO thresholds, LTV limits, DTI caps).`;

  return chatWithGuidelines({ message: question, agencies, loan_types, contact_data, history: [] });
}

// ── SAVE Q&A to knowledge base ────────────────────────────────────────────
async function saveAnswer(body: any) {
  const { question, answer, citations, guideline_ids, agencies, loan_types } = body;
  
  const { data, error } = await sb.from('guideline_qa_cache').insert({
    question, answer, citations, guideline_ids, agencies, loan_types
  }).select().single();
  if (error) throw error;
  return { saved: data };
}

// ── GET TAGS ─────────────────────────────────────────────────────────────
async function getTags() {
  const { data } = await sb.from('guideline_tags').select('*').order('use_count', { ascending: false });
  return { tags: data || [] };
}

// ── GET STATS for dashboard ───────────────────────────────────────────────
async function getStats() {
  const [glCount, chunkCount, qaCount, searchCount] = await Promise.all([
    sb.from('global_guidelines').select('*', { count: 'exact', head: true }),
    sb.from('global_guideline_chunks').select('*', { count: 'exact', head: true }),
    sb.from('guideline_qa_cache').select('*', { count: 'exact', head: true }),
    sb.from('guideline_search_history').select('*', { count: 'exact', head: true })
  ]);

  // By agency
  const { data: byAgency } = await sb.from('global_guidelines')
    .select('agency')
    .eq('is_active', true);
  
  const agencyCounts: Record<string, number> = {};
  (byAgency||[]).forEach((g: any) => {
    agencyCounts[g.agency] = (agencyCounts[g.agency] || 0) + 1;
  });

  return {
    total_guidelines: glCount.count || 0,
    total_chunks: chunkCount.count || 0,
    total_qa: qaCount.count || 0,
    total_searches: searchCount.count || 0,
    by_agency: agencyCounts
  };
}

// ── HELPERS ─────────────────────────────────────────────────────────────
async function triggerOCR(guidelineId: string, fileUrl: string, fileType: string) {
  await sb.from('global_guidelines').update({ 
    processing_status: 'ocr_processing',
    ocr_status: 'processing'
  }).eq('id', guidelineId);

  // Call textract-ocr edge function
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/textract-ocr`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    },
    body: JSON.stringify({
      action: 'extract',
      file_url: fileUrl,
      file_type: fileType,
      guideline_id: guidelineId,
      table: 'global_guidelines'
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OCR trigger failed: ${errText}`);
  }
}

function chunkText(text: string, chunkSize = 800, overlap = 100): Array<{text: string, page: number}> {
  const chunks: Array<{text: string, page: number}> = [];
  const words = text.split(/\s+/);
  const wordsPerPage = 300; // rough estimate
  
  let i = 0;
  while (i < words.length) {
    const end = Math.min(i + chunkSize, words.length);
    const chunkWords = words.slice(i, end);
    const chunkText = chunkWords.join(' ').trim();
    
    if (chunkText.length > 50) {
      chunks.push({
        text: chunkText,
        page: Math.ceil(i / wordsPerPage) + 1
      });
    }
    
    i += chunkSize - overlap;
    if (i >= words.length) break;
  }
  
  return chunks;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!OPENAI_KEY) return texts.map(() => []);
  
  try {
    const resp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts })
    });
    const data = await resp.json();
    return (data.data || []).map((d: any) => d.embedding);
  } catch(e) {
    console.error('Embedding error:', e);
    return texts.map(() => []);
  }
}

async function generateSummary(title: string, agency: string, text: string): Promise<string> {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: `Summarize this mortgage guideline document in 3-4 sentences. Focus on: who it applies to, key requirements, loan types covered, and any important restrictions.\n\nDocument: ${title} (${agency})\n\n${text}` }]
      })
    });
    const data = await resp.json();
    return data.content?.[0]?.text || '';
  } catch(e) {
    return '';
  }
}

function extractTopics(text: string): string[] {
  const topics: string[] = [];
  const lower = text.toLowerCase();
  const topicMap: Record<string, string[]> = {
    'credit': ['credit score', 'fico', 'credit report'],
    'dti': ['debt-to-income', 'dti', 'front ratio', 'back ratio'],
    'ltv': ['loan-to-value', 'ltv', 'cltv'],
    'income': ['income', 'employment', 'w-2', '1099', 'self-employed'],
    'assets': ['assets', 'reserves', 'bank statement', 'gift funds'],
    'property': ['property type', 'appraisal', 'condition'],
    'bankruptcy': ['bankruptcy', 'chapter 7', 'chapter 13'],
    'foreclosure': ['foreclosure', 'short sale', 'deed in lieu'],
    'occupancy': ['primary residence', 'investment', 'second home'],
  };
  for (const [topic, keywords] of Object.entries(topicMap)) {
    if (keywords.some(kw => lower.includes(kw))) topics.push(topic);
  }
  return topics;
}
