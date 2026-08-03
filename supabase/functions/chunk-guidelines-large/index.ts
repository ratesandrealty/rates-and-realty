// chunk-guidelines-large v2: caches PDF in storage instead of re-downloading per batch.
// First invocation downloads the PDF and stashes a parsed-page-text JSON sidecar.
// Subsequent invocations read just the sidecar (small, fast) and embed.
// Reduces IO by ~95% for big multi-batch jobs.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// @ts-ignore
import { extractPagesRanged, pdfPageCount, PAGE_SLICE } from "../_shared/pdf-pages.ts";

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
/* A DEDICATED bucket, not lender-guidelines.
 *
 * lender-guidelines has allowed_mime_types restricted to PDFs/Office/images, so
 * every sidecar upload returned 415 invalid_mime_type — and the write was
 * wrapped in .catch(console.warn), so the cache silently never existed. Every
 * invocation re-downloaded and re-extracted the whole PDF from page 1. The
 * header comment claiming "~95% less IO" described something that never ran.
 *
 * Not fixed by widening that bucket's allowlist: it is PUBLIC, and JSON there
 * would expose extracted guideline text at a guessable URL. chunker-cache is
 * private and JSON-only. */
const CACHE_BUCKET = "chunker-cache";

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

  /* Split-then-parse. Extracting from one getDocumentProxy over the whole
   * document — even page-by-page — still hit WORKER_RESOURCE_LIMIT on a
   * 511-page handbook, so the wall is the pdf.js document itself. The shared
   * extractor slices with pdf-lib first; pdf.js never sees more than 50 pages. */
  const pages = await extractPagesRanged(buf, (done, total) => {
    if (done % 100 === 0 || done === total) console.log(`[chunk-large] extracted ${done}/${total} pages`);
  });
  console.log(`[chunk-large] extracted ${pages.length} pages, ${pages.reduce((n, t) => n + t.length, 0)} chars`);
  return pages;
}

/* INCREMENTAL SIDECAR.
 *
 * Every individual step works — measured: download 3.4MB, pdf-lib parse 511
 * pages, build a 50-page slice, pdf.js parse it, extract 133,801 chars. What
 * exhausts the worker is doing all ELEVEN slices in one invocation; the memory
 * from earlier slices is not reclaimed fast enough.
 *
 * So the cache is built a few slices at a time and persisted between
 * invocations, exactly like the chunking phase it feeds. A partial sidecar is
 * written with the pages done so far and a `next` marker; the resume cron calls
 * back every 5 minutes until it is complete. Returning null means "not ready
 * yet, come back" — NOT a failure, so the caller must not mark the document
 * failed or done.
 */
const SLICES_PER_INVOCATION = 3;   // 150 pages — comfortably inside the limit

type Sidecar = { pages: string[]; next: number; total: number; complete: boolean };

async function readSidecar(guidelineId: string): Promise<Sidecar | null> {
  const { data } = await sb.storage.from(CACHE_BUCKET).download(`_cache/${guidelineId}.pages.json`);
  if (!data) return null;
  try {
    const parsed = JSON.parse(await data.text());
    // Legacy sidecars were a bare array and are always complete.
    if (Array.isArray(parsed)) return { pages: parsed, next: parsed.length, total: parsed.length, complete: true };
    if (Array.isArray(parsed?.pages)) return parsed as Sidecar;
  } catch { /* corrupt — rebuild from scratch */ }
  return null;
}

async function writeSidecar(guidelineId: string, sc: Sidecar) {
  await sb.storage.from(CACHE_BUCKET).upload(
    `_cache/${guidelineId}.pages.json`,
    new Blob([JSON.stringify(sc)], { type: "application/json" }),
    { contentType: "application/json", upsert: true },
  ).then((r: any) => {
    if (r?.error) throw new Error("sidecar write: " + r.error.message);
  });   // THROWS. A swallowed write is what made this cache imaginary.
}

/** Returns the full page array when complete, or null while still building. */
async function getCachedPages(guidelineId: string, fileUrl: string): Promise<string[] | null> {
  let sc = await readSidecar(guidelineId);
  if (sc?.complete) {
    console.log(`[chunk-large] cache hit ${guidelineId} (${sc.pages.length} pages)`);
    return sc.pages;
  }

  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`PDF fetch ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());

  if (!sc) {
    const total = await pdfPageCount(buf);
    sc = { pages: new Array(total).fill(""), next: 0, total, complete: false };
    console.log(`[chunk-large] starting sidecar for ${guidelineId}: ${total} pages`);
  }

  const from = sc.next;
  const to = Math.min(from + SLICES_PER_INVOCATION * PAGE_SLICE, sc.total);
  const got = await extractPagesRanged(buf, undefined, from, to);
  for (let i = 0; i < got.length; i++) sc.pages[from + i] = got[i];
  sc.next = to;
  sc.complete = to >= sc.total;
  await writeSidecar(guidelineId, sc);
  console.log(`[chunk-large] sidecar ${guidelineId}: ${to}/${sc.total} pages${sc.complete ? " COMPLETE" : ""}`);

  return sc.complete ? sc.pages : null;
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

    // CACHED page text — built incrementally across invocations for long docs.
    const pages = await getCachedPages(guideline_id, g.file_url);
    if (!pages) {
      /* Sidecar still building. NOT a failure and NOT done — leave chunk_status
       * 'running' so the resume cron calls back, and do not touch
       * last_page_processed, which belongs to the chunking phase. Reporting
       * "done" here would mark a document indexed with zero chunks, which is
       * precisely the invisible state this whole exercise is about. */
      return ok({ message: "Building page cache", status: "extracting" });
    }
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
        /* UPSERT, not insert. The resume path appends: a batch that was written but
       * whose last_page_processed update did not land is re-run from the same
       * page, and a plain insert duplicated every chunk in it. Four documents in
       * the corpus carried duplicates from this — Home-Possible-VLIP-Matrix had
       * EIGHT copies of every chunk, written unattended by the cron. Duplicates
       * skew vector search: the same passage is returned repeatedly and crowds
       * out other results.
       *
       * onConflict matches the guideline_chunks_unique_slot index, so a re-run
       * overwrites its own rows and changes nothing else. */
      const { error: insErr } = await sb.from("guideline_chunks")
        .upsert(rows, { onConflict: "guideline_id,page_number,chunk_index" });
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
      await sb.from("lender_guidelines").update({ chunk_status: "failed" }).eq("id", body.guideline_id).then(() => {}, () => {});
    }
    return err(e.message || String(e), 500);
  }
});
