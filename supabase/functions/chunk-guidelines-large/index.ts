// chunk-guidelines-large v2: caches PDF in storage instead of re-downloading per batch.
// First invocation downloads the PDF and stashes a parsed-page-text JSON sidecar.
// Subsequent invocations read just the sidecar (small, fast) and embed.
// Reduces IO by ~95% for big multi-batch jobs.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// @ts-ignore
import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CHUNK_TARGET_CHARS = 2000;
const CHUNK_OVERLAP_CHARS = 320;
const EMBED_BATCH_SIZE = 32;
const PAGE_BATCH_SIZE = 25;
const TIME_BUDGET_MS = 110000;
const CACHE_BUCKET = "lender-guidelines";  // re-use existing bucket

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

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  if (!res.ok) throw new Error(`OpenAI embed ${res.status}: ${(await res.text()).substring(0, 300)}`);
  return (await res.json()).data.map((d: any) => d.embedding);
}

// Build text-by-page sidecar. Called ONCE per guideline_id, then cached.
async function buildPageTextCache(guidelineId: string, fileUrl: string): Promise<string[]> {
  console.log(`[chunk-large] building cache for ${guidelineId}`);
  const pdfRes = await fetch(fileUrl);
  if (!pdfRes.ok) throw new Error(`PDF fetch ${pdfRes.status}`);
  const buf = new Uint8Array(await pdfRes.arrayBuffer());
  console.log(`[chunk-large] downloaded ${(buf.byteLength/1024/1024).toFixed(1)}MB`);

  const pdf = await getDocumentProxy(buf);
  const totalPages = pdf.numPages;
  const result = await extractText(pdf, { mergePages: false });
  const pages: string[] = Array.isArray(result.text) ? result.text : [String(result.text)];
  // Pad to numPages if missing
  while (pages.length < totalPages) pages.push("");
  return pages.slice(0, totalPages);
}

async function getCachedPages(guidelineId: string, fileUrl: string): Promise<string[]> {
  const cachePath = `_cache/${guidelineId}.pages.json`;
  // Try to read cached sidecar first
  const { data: cached } = await sb.storage.from(CACHE_BUCKET).download(cachePath);
  if (cached) {
    try {
      const text = await cached.text();
      const arr = JSON.parse(text);
      if (Array.isArray(arr) && arr.length) {
        console.log(`[chunk-large] cache hit ${guidelineId} (${arr.length} pages)`);
        return arr;
      }
    } catch {/* fall through */}
  }

  // Build cache
  const pages = await buildPageTextCache(guidelineId, fileUrl);
  // Write sidecar
  const json = JSON.stringify(pages);
  await sb.storage.from(CACHE_BUCKET).upload(
    cachePath,
    new Blob([json], { type: "application/json" }),
    { contentType: "application/json", upsert: true }
  ).catch(e => console.warn("[chunk-large] cache write failed:", e.message));
  console.log(`[chunk-large] cache built and stored for ${guidelineId} (${pages.length} pages)`);
  return pages;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

  const t0 = Date.now();
  let body: any = {};
  try {
    body = await req.json().catch(() => ({}));
    const { guideline_id, reset } = body;
    if (!guideline_id) return err("guideline_id required");

    const { data: g, error: gErr } = await sb
      .from("lender_guidelines")
      .select("id, lender_id, title, file_url, category, loan_types, chunk_count, last_page_processed")
      .eq("id", guideline_id)
      .single();
    if (gErr || !g) return err("guideline not found", 404);
    if (!g.file_url) return err("no file_url");

    if (reset) {
      await sb.from("guideline_chunks").delete().eq("guideline_id", guideline_id);
      await sb.from("lender_guidelines").update({
        chunk_status: "running",
        chunk_count: 0,
        last_page_processed: 0,
      }).eq("id", guideline_id);
      // Also wipe any stale cache
      await sb.storage.from(CACHE_BUCKET).remove([`_cache/${guideline_id}.pages.json`]).catch(() => {});
    } else {
      await sb.from("lender_guidelines").update({ chunk_status: "running" }).eq("id", guideline_id);
    }

    const startedAt = (g.last_page_processed || 0) + 1;

    // CACHED page text - downloads PDF only on first invocation
    const pages = await getCachedPages(guideline_id, g.file_url);
    const totalPages = pages.length;

    if (startedAt > totalPages) {
      await sb.from("lender_guidelines").update({
        chunk_status: "done",
        ocr_page_count: totalPages,
        chunked_at: new Date().toISOString(),
      }).eq("id", guideline_id);
      // Clean up cache once done
      await sb.storage.from(CACHE_BUCKET).remove([`_cache/${guideline_id}.pages.json`]).catch(() => {});
      return ok({ message: "Already complete", total_pages: totalPages });
    }

    const endPage = Math.min(startedAt + PAGE_BATCH_SIZE - 1, totalPages);
    const allRowsToInsert: any[] = [];
    let chunkIdx = g.chunk_count || 0;

    for (let p = startedAt; p <= endPage; p++) {
      if (Date.now() - t0 > TIME_BUDGET_MS) {
        console.log(`[chunk-large] time wall, stopping at page ${p - 1}`);
        break;
      }
      const text = pages[p - 1] || "";
      for (const piece of chunkPageText(text)) {
        if (piece.length < 80) continue;
        allRowsToInsert.push({
          guideline_id,
          lender_id: g.lender_id || null,
          chunk_index: chunkIdx++,
          page_number: p,
          chunk_text: piece,
          chunk_tokens: approxTokens(piece),
          category: g.category || null,
          loan_types: g.loan_types || null,
        });
      }
    }

    let lastPageDone = endPage;
    if (Date.now() - t0 > TIME_BUDGET_MS) {
      lastPageDone = Math.max(startedAt, endPage - 5);
    }

    if (allRowsToInsert.length) {
      for (let i = 0; i < allRowsToInsert.length; i += EMBED_BATCH_SIZE) {
        const batch = allRowsToInsert.slice(i, i + EMBED_BATCH_SIZE);
        const embeddings = await embedBatch(batch.map(r => r.chunk_text));
        const rows = batch.map((r, idx) => ({ ...r, embedding: embeddings[idx] }));
        const { error: insErr } = await sb.from("guideline_chunks").insert(rows);
        if (insErr) throw new Error(`insert: ${insErr.message}`);
      }
    }

    const allDone = lastPageDone >= totalPages;
    await sb.from("lender_guidelines").update({
      chunk_status: allDone ? "done" : "running",
      chunk_count: chunkIdx,
      last_page_processed: lastPageDone,
      ocr_page_count: totalPages,
      chunked_at: allDone ? new Date().toISOString() : null,
    }).eq("id", guideline_id);

    if (allDone) {
      // Clean up the page cache once we're done with this doc
      await sb.storage.from(CACHE_BUCKET).remove([`_cache/${guideline_id}.pages.json`]).catch(() => {});
    }

    return ok({
      processed_pages: lastPageDone - startedAt + 1,
      from_page: startedAt,
      to_page: lastPageDone,
      total_pages: totalPages,
      chunks_inserted: allRowsToInsert.length,
      total_chunks: chunkIdx,
      complete: allDone,
      cache_used: true,
      elapsed_ms: Date.now() - t0,
    });
  } catch (e: any) {
    console.error("[chunk-large] FATAL:", e);
    if (body?.guideline_id) {
      await sb.from("lender_guidelines").update({ chunk_status: "failed" }).eq("id", body.guideline_id).catch(() => {});
    }
    return err(e.message || String(e), 500);
  }
});
