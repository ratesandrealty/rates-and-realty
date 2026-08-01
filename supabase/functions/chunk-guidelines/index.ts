// Guideline chunker v6: atomic claim via RPC, ONE PDF per invocation, race-safe.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// @ts-ignore
import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};


/* Hand a too-big document to the streaming chunker instead of abandoning it.
 *
 * "skipped_oversize" was a terminal state: the auto-resume cron selects only
 * chunk_status IN (NULL,'running','failed'), so a skipped row was never looked
 * at again. It kept file_url, ai_summary and a healthy-looking row while the
 * AI could not see a word of it — the exact silent gap this is closing.
 * usda-rd-hb-1-3560-consolidated.pdf sat like that since 2026-04-30.
 *
 * Setting chunk_status='running' with chunked_at NULL puts it straight into the
 * cron's work set; the direct invoke below just saves up to five minutes. */
async function handOffToLarge(sb: any, id: string, why: string, extra: Record<string, unknown> = {}) {
  await sb.from("lender_guidelines").update({
    chunk_status: "running",
    chunked_at: null,
    last_page_processed: null,
    ...extra,
  }).eq("id", id);
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/chunk-guidelines-large`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guideline_id: id }),
    });
  } catch (e) {
    // Non-fatal: the row is already queued for the cron.
    console.error("[chunk-guidelines] direct handoff failed, cron will pick it up:", String(e));
  }
  console.log(`[chunk-guidelines] handed ${id} to chunk-guidelines-large (${why})`);
}

const CHUNK_TARGET_CHARS = 2000;
const CHUNK_OVERLAP_CHARS = 320;
const EMBED_BATCH_SIZE = 32;
/* These are ROUTING thresholds now, not skip thresholds. Above either one the
 * document is handed to chunk-guidelines-large, which streams 25 pages per
 * invocation and is resumed by cron — the whole reason it exists. Raising these
 * numbers instead would mean one invocation trying to parse and embed a
 * 200-page PDF inside the edge function timeout, which is the failure this
 * split was designed around.
 *
 * They stay at 8MB/200p because that is where a single invocation stops being
 * reliable, NOT because of any upload limit. The upload cap is 20MB. */
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_COUNT = 200;

interface PageText { page: number; text: string; }

function approxTokens(s: string): number { return Math.ceil(s.length / 4); }

function chunkPageText(text: string): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= CHUNK_TARGET_CHARS) return [cleaned].filter(Boolean);
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  const chunks: string[] = [];
  let cur = "";
  for (const sent of sentences) {
    if ((cur + " " + sent).length > CHUNK_TARGET_CHARS && cur.length > 0) {
      chunks.push(cur.trim());
      const overlapStart = Math.max(0, cur.length - CHUNK_OVERLAP_CHARS);
      cur = cur.slice(overlapStart) + " " + sent;
    } else {
      cur = cur ? cur + " " + sent : sent;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

async function extractPagesFromPdf(pdfBytes: Uint8Array): Promise<PageText[]> {
  const pdf = await getDocumentProxy(pdfBytes);
  const numPages = pdf.numPages;
  const result = await extractText(pdf, { mergePages: false });
  const textArr: string[] = Array.isArray(result.text) ? result.text : [String(result.text)];
  const pages: PageText[] = [];
  for (let i = 0; i < Math.max(numPages, textArr.length); i++) {
    pages.push({ page: i + 1, text: textArr[i] || "" });
  }
  return pages;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set in Supabase secrets");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  if (!res.ok) throw new Error(`OpenAI embed ${res.status}: ${(await res.text()).substring(0, 300)}`);
  const data = await res.json();
  return data.data.map((d: any) => d.embedding);
}

async function chunkOne(g: any, force: boolean): Promise<any> {
  const id = g.id;
  console.log(`[chunk] ${id} ${g.title}`);

  if (!force) {
    try {
      const head = await fetch(g.file_url, { method: "HEAD" });
      const sizeStr = head.headers.get("content-length");
      if (sizeStr) {
        const size = parseInt(sizeStr);
        if (size > MAX_PDF_BYTES) {
          await handOffToLarge(sb, id, `${(size/1024/1024).toFixed(1)}MB by HEAD`);
          return { chunks: 0, pages: 0, handed_off: `oversize ${(size/1024/1024).toFixed(1)}MB` };
        }
      }
    } catch {}
  }

  const pdfRes = await fetch(g.file_url);
  if (!pdfRes.ok) throw new Error(`PDF fetch ${pdfRes.status}`);
  const buf = new Uint8Array(await pdfRes.arrayBuffer());

  if (!force && buf.byteLength > MAX_PDF_BYTES) {
    await handOffToLarge(sb, id, `${(buf.byteLength/1024/1024).toFixed(1)}MB`);
    return { chunks: 0, pages: 0, handed_off: `oversize ${(buf.byteLength/1024/1024).toFixed(1)}MB` };
  }

  const pages = await extractPagesFromPdf(buf);

  if (!force && pages.length > MAX_PAGE_COUNT) {
    await handOffToLarge(sb, id, `${pages.length} pages`, { ocr_page_count: pages.length });
    return { chunks: 0, pages: pages.length, handed_off: `${pages.length} pages` };
  }

  const chunks: any[] = [];
  let chunkIdx = 0;
  for (const p of pages) {
    for (const piece of chunkPageText(p.text)) {
      if (piece.length < 80) continue;
      chunks.push({
        guideline_id: id,
        lender_id: g.lender_id || null,
        chunk_index: chunkIdx++,
        page_number: p.page,
        chunk_text: piece,
        chunk_tokens: approxTokens(piece),
        category: g.category || null,
        loan_types: g.loan_types || null,
      });
    }
  }

  if (!chunks.length) {
    await sb.from("lender_guidelines").update({
      chunk_status: "empty",
      chunked_at: new Date().toISOString(),
      chunk_count: 0,
      ocr_page_count: pages.length,
    }).eq("id", id);
    return { chunks: 0, pages: pages.length };
  }

  await sb.from("guideline_chunks").delete().eq("guideline_id", id);

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await embedBatch(batch.map(c => c.chunk_text));
    const rows = batch.map((c, idx) => ({ ...c, embedding: embeddings[idx] }));
    const { error: insErr } = await sb.from("guideline_chunks").insert(rows);
    if (insErr) throw new Error(`insert ${insErr.message}`);
  }

  const fullText = pages.map(p => p.text).join("\n\n").substring(0, 500000);
  await sb.from("lender_guidelines").update({
    chunk_status: "done",
    chunked_at: new Date().toISOString(),
    chunk_count: chunks.length,
    extracted_text: fullText,
    ocr_page_count: pages.length,
  }).eq("id", id);

  return { chunks: chunks.length, pages: pages.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  const t0 = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const { guideline_id, reset } = body;

    if (reset) {
      await sb.from("guideline_chunks").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      await sb.from("lender_guidelines").update({ chunk_status: null, chunked_at: null, chunk_count: 0 })
        .eq("is_active", true)
        .not("chunk_status", "eq", "skipped_oversize");
      return new Response(JSON.stringify({ reset: true }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    let g: any;
    let force = false;

    if (guideline_id) {
      // Forced single-doc mode — skip the lock dance
      const { data, error } = await sb.from("lender_guidelines")
        .select("id, lender_id, title, file_url, category, loan_types")
        .eq("id", guideline_id).single();
      if (error || !data) throw new Error("guideline not found");
      g = data; force = true;
      await sb.from("lender_guidelines").update({ chunk_status: "running" }).eq("id", guideline_id);
    } else {
      // Atomic claim via RPC — prevents two workers picking the same row
      const { data, error } = await sb.rpc("claim_pending_guideline");
      if (error) throw error;
      if (!data || !data.length) {
        const { count: doneCount } = await sb.from("lender_guidelines")
          .select("*", { count: "exact", head: true })
          .eq("is_active", true).eq("chunk_status", "done");
        const { count: chunkCount } = await sb.from("guideline_chunks")
          .select("*", { count: "exact", head: true });
        return new Response(JSON.stringify({
          processed: 0,
          message: "All done \u2014 no pending guidelines",
          docs_chunked: doneCount || 0,
          total_chunks: chunkCount || 0,
        }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
      }
      g = data[0];
    }

    let result: any = { id: g.id, title: g.title };
    try {
      const r = await chunkOne(g, force);
      result = { ...result, ...r };
    } catch (e: any) {
      console.error(`[chunk] FAIL ${g.id}: ${e.message}`);
      await sb.from("lender_guidelines").update({
        chunk_status: "failed",
        chunked_at: new Date().toISOString(),
      }).eq("id", g.id);
      result = { ...result, error: e.message };
    }

    const { count: remaining } = await sb.from("lender_guidelines")
      .select("*", { count: "exact", head: true })
      .eq("is_active", true)
      .not("file_url", "is", null)
      .or("chunk_status.is.null,chunk_status.eq.failed");

    return new Response(JSON.stringify({
      processed: 1,
      remaining: remaining || 0,
      elapsed_ms: Date.now() - t0,
      result,
    }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
  } catch (e: any) {
    console.error("[chunk] FATAL", e);
    return new Response(JSON.stringify({ error: e.message || String(e) }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
  }
});
