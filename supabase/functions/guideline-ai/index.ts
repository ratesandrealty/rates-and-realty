// Guideline AI v4: + smart lender-roster injection for lender-intent queries.
// Previous v3 (deployed as v50): synonym expansion + AI told it can answer if source covers same concept under a different term.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYNONYM_MAP: Record<string, string> = {
  "school loan": "student loan",
  "school loans": "student loans",
  "college loan": "student loan",
  "college loans": "student loans",
  "sallie mae": "student loan",
  "unpaid loan": "deferred loan",
  "no payment": "deferred forbearance zero payment IBR",
  "piti": "principal interest taxes insurance",
  "dti": "debt to income ratio",
  "ltv": "loan to value",
  "cltv": "combined loan to value",
  "hcltv": "home equity combined loan to value",
  "reo": "real estate owned",
  "coe": "certificate of eligibility",
  "ufmip": "upfront mortgage insurance premium",
  "mip": "mortgage insurance premium",
  "pmi": "private mortgage insurance",
  "non-qm": "non-qualified mortgage",
  "alt-doc": "alternative documentation",
  "bank statement loan": "bank statement program self employed",
  "1099": "independent contractor self employed",
  "p&l": "profit and loss statement",
  "asset depletion": "asset utilization",
  "jumbo": "non conforming high balance",
  "i/o": "interest only",
  "streamline": "streamline refinance IRRRL non credit qualifying",
};

// Smart detection: triggers a roster lookup only for lender-intent queries.
// Pure handbook questions skip the roster (faster, less noise in prompt).
const LENDER_INTENT_RE = /\b(lender|lenders|fico|ltv|cltv|overlay|overlays|dti|qualify|qualifies|qualifying|dscr|channel|wholesale|correspondent|broker|non[- ]?qm|bank statement|fha|va|usda|conventional|conv|jumbo|heloc|heloan|reverse|itin|dpa|construction|hard money|preferred lender)\b/i;

function expandQuery(question: string): string {
  let expanded = question;
  const lower = question.toLowerCase();
  for (const [casual, formal] of Object.entries(SYNONYM_MAP)) {
    if (lower.includes(casual)) {
      expanded += ` (${formal})`;
    }
  }
  return expanded;
}

async function embedQuery(text: string): Promise<number[]> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
  });
  if (!res.ok) throw new Error(`OpenAI embed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding;
}

async function fallbackKeywordSearch(question: string, lenderIds: string[] | null): Promise<any[]> {
  const expanded = expandQuery(question).toLowerCase();
  const words = expanded.match(/\b[a-z0-9]{3,}\b/g) || [];
  const top = [...new Set(words)].slice(0, 8);
  if (!top.length) return [];

  let q = sb.from("lender_guidelines")
    .select("id, lender_id, title, file_url, category, extracted_text")
    .eq("is_active", true)
    .not("extracted_text", "is", null)
    .limit(50);
  if (lenderIds?.length) q = q.in("lender_id", lenderIds);

  const { data } = await q;
  if (!data) return [];

  const scored = data.map((r: any) => {
    const txt = (r.extracted_text || "").toLowerCase();
    const score = top.reduce((s, w) => s + (txt.includes(w) ? 1 : 0), 0);
    return { ...r, score };
  }).filter((r: any) => r.score > 0)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, 8);

  return scored.map((r: any, i: number) => ({
    id: `fallback-${r.id}`,
    guideline_id: r.id,
    lender_id: r.lender_id,
    chunk_text: (r.extracted_text || "").substring(0, 1500),
    page_number: 1,
    chunk_index: i,
    category: r.category,
    similarity: r.score / top.length,
    _fallback: true,
  }));
}

// Builds a compact one-line-per-lender roster from active lenders. Same columns the
// scanner edge fn (guidelines-ai) uses for its per-lender context. Returns "" if no rows.
async function buildLenderRoster(): Promise<string> {
  const { data: lenders } = await sb.from("lenders")
    .select("id,name,channel,min_credit_score,max_ltv,loan_programs,key_overlays,specialty_notes,states_licensed")
    .eq("is_active", true)
    .order("name");
  if (!lenders?.length) return "";

  const lines = lenders.map((l: any) => {
    const programs = Array.isArray(l.loan_programs) ? l.loan_programs.join(", ") : (l.loan_programs || "N/A");
    const states = Array.isArray(l.states_licensed) ? l.states_licensed.join(", ") : (l.states_licensed || "N/A");
    const fico = l.min_credit_score != null ? `FICO≥${l.min_credit_score}` : "FICO=N/A";
    const ltv = l.max_ltv != null ? `LTV≤${l.max_ltv}%` : "LTV=N/A";
    const ch = l.channel || "N/A";
    const ov = l.key_overlays ? ` | Overlays: ${l.key_overlays}` : "";
    const sn = l.specialty_notes ? ` | Notes: ${l.specialty_notes}` : "";
    return `- ${l.name}: ${ch} | ${fico} | ${ltv} | Programs: ${programs} | States: ${states}${ov}${sn}`;
  });

  return `LENDER ROSTER (${lenders.length} active lenders, live from CRM):\n${lines.join("\n")}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const { question, lenders = [], history = [] } = await req.json();
    if (!question) {
      return new Response(JSON.stringify({ error: "question required" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    let lenderIds: string[] | null = null;
    if (lenders?.length) {
      const { data: lenderRows } = await sb.from("lenders").select("id, name").in("name", lenders);
      lenderIds = lenderRows?.map((r: any) => r.id) || null;
      if (lenderIds && !lenderIds.length) lenderIds = null;
    }

    const expandedQuestion = expandQuery(question);

    let chunks: any[] = [];
    let usedFallback = false;
    try {
      const queryEmbedding = await embedQuery(expandedQuestion);
      const { data: matches, error: rpcErr } = await sb.rpc("match_guideline_chunks", {
        query_embedding: queryEmbedding,
        match_count: 12,
        lender_filter: lenderIds,
      });
      if (rpcErr) throw rpcErr;
      chunks = matches || [];
    } catch (e: any) {
      console.warn("[guideline-ai] embed/RPC failed, fallback:", e.message);
      chunks = await fallbackKeywordSearch(question, lenderIds);
      usedFallback = true;
    }

    // Smart roster injection: only fire lender query when the question shows lender intent.
    let rosterBlock = "";
    let usedRoster = false;
    if (LENDER_INTENT_RE.test(question)) {
      try {
        const r = await buildLenderRoster();
        if (r) { rosterBlock = `\n\n${r}`; usedRoster = true; }
      } catch (e: any) {
        console.warn("[guideline-ai] roster fetch failed:", e.message);
      }
    }
    console.log(`[guideline-ai] roster_injected=${usedRoster} chunks=${chunks.length} q="${question.substring(0, 100)}"`);

    if (!chunks.length && !rosterBlock) {
      return new Response(JSON.stringify({
        reply: "I couldn't find anything related in your guideline library. Try uploading more lender PDFs that cover this topic, or rephrase the question.",
        citations: [],
        chunks_found: 0,
      }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const guidelineIds = [...new Set(chunks.map((c: any) => c.guideline_id))];
    const lenderIdsToFetch = [...new Set(chunks.map((c: any) => c.lender_id).filter(Boolean))];
    const [{ data: gRows }, { data: lRows }] = await Promise.all([
      sb.from("lender_guidelines").select("id, title, file_url, lender_id").in("id", guidelineIds),
      lenderIdsToFetch.length
        ? sb.from("lenders").select("id, name").in("id", lenderIdsToFetch)
        : Promise.resolve({ data: [] }),
    ]);
    const gMap = Object.fromEntries((gRows || []).map((r: any) => [r.id, r]));
    const lMap = Object.fromEntries((lRows || []).map((r: any) => [r.id, r]));

    const citations = chunks.map((c: any, i: number) => {
      const g = gMap[c.guideline_id] || {};
      const l = lMap[c.lender_id] || {};
      return {
        marker: `c${i + 1}`,
        lender_name: l.name || "Unknown lender",
        doc_title: g.title || "Untitled guideline",
        page_number: c.page_number,
        snippet: (c.chunk_text || "").substring(0, 280),
        full_text: c.chunk_text,
        file_url: g.file_url,
        guideline_id: c.guideline_id,
        chunk_id: c.id,
        similarity: typeof c.similarity === "number" ? Number(c.similarity.toFixed(3)) : null,
      };
    });

    const contextBlocks = citations.map((c: any) =>
      `[^${c.marker}] ${c.lender_name} — ${c.doc_title} (page ${c.page_number}):\n${c.full_text}`
    ).join("\n\n---\n\n");

    const systemPrompt = `You are an expert mortgage guideline assistant for Rates & Realty (Rene Duarte, MLO NMLS #1795044). You answer questions about lending guidelines using the source material below.

SOURCE MATERIAL:
${contextBlocks}${rosterBlock}

IMPORTANT — SYNONYMS AND TERMINOLOGY:
Loan officers ask in casual phrasing; guideline documents use formal terms. Treat these as equivalent and use the source if it covers the underlying concept:
- "school loan" / "college loan" = student loan
- "no payment" / "$0 payment" / "isn't paying" = deferred / forbearance / IBR / income-driven repayment
- "DTI" = debt-to-income ratio
- "LTV" / "CLTV" = loan-to-value
- "PMI" = private mortgage insurance ; "MIP" / "UFMIP" = FHA mortgage insurance
- "jumbo" = non-conforming
- "streamline" = IRRRL (VA) or streamline refinance
- "COE" = Certificate of Eligibility
- "DPA" = down payment assistance
If the source covers the underlying concept under a different term, USE IT and cite it. Do NOT say "the source does not address" when it actually does, just under different wording.

RESPONSE RULES:
- Lead with a direct, practical answer in plain English a working LO can act on
- For EVERY factual claim from a source, append the inline citation marker like [^c1], [^c2]
- A single sentence may carry multiple citations: [^c2][^c5]
- Cite specific numbers (FICO, LTV, DTI, percentages) when the source has them
- If two sources conflict, surface the conflict explicitly with both citations
- If the source genuinely does NOT contain the answer (even after considering synonyms), say so briefly. Do NOT invent citations.
- For student loan calculations specifically: agency rules differ (Fannie, Freddie, FHA, VA, USDA each treat $0/IBR/deferred payments differently). When asked, distinguish per agency if multiple are present in source material.
- Use bullets for lists of requirements
- No "Sources:" section at the bottom — inline markers are sufficient
- If the answer differs by program (FHA vs Conv vs VA etc.), cover each separately

WHEN ANSWERING LENDER-ROSTER QUESTIONS (e.g., "which lenders allow X", "what lenders do Y", "best lender for Z"):
- Use the LENDER ROSTER block above to name specific lenders that match the criteria
- Still cite handbook chunks [^c1] etc. for agency rules and floors (FICO minimums, DTI caps, eligibility) that come from the SOURCE MATERIAL
- For combined questions ("which of our lenders allow 580 FICO for FHA"), give BOTH: the agency rule from chunks (with citation), then name the qualifying lenders from the roster
- If the roster is empty or no lender matches, say so plainly — do NOT invent lender names
- Lender roster entries are CRM data, NOT handbook citations — do NOT cite them as [^c#]`;

    const messages = [
      ...history.slice(-6),
      { role: "user", content: question },
    ];

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: systemPrompt,
        messages,
      }),
    });
    if (!aiRes.ok) {
      const errTxt = await aiRes.text();
      throw new Error(`Anthropic ${aiRes.status}: ${errTxt.substring(0, 300)}`);
    }
    const aiData = await aiRes.json();
    const reply = aiData.content?.[0]?.text || "Unable to generate response.";

    return new Response(JSON.stringify({
      reply,
      citations,
      chunks_found: chunks.length,
      query_expanded: expandedQuestion !== question ? expandedQuestion : undefined,
      used_fallback: usedFallback,
    }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
  } catch (e: any) {
    console.error("[guideline-ai]", e);
    return new Response(JSON.stringify({ error: e.message || String(e) }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
  }
});
