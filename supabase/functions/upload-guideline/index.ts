// Upload-guideline v3: routes to chunk-guidelines (small) or chunk-guidelines-large (big),
// and seeds chunk_status='running' for big PDFs so the auto-resume cron picks them up.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// Threshold for routing to the streaming chunker. Files at or above this go through
// chunk-guidelines-large which processes 25 pages per invocation.
const LARGE_PDF_THRESHOLD_BYTES = 6 * 1024 * 1024;  // 6 MB

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function sanitizeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").substring(0, 120);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const form = await req.formData();
    const file = form.get("file");
    const lenderId = String(form.get("lender_id") || "").trim();
    let title = String(form.get("title") || "").trim();
    const category = String(form.get("category") || "General").trim();
    const loanTypesRaw = String(form.get("loan_types") || "").trim();
    const loanTypes = loanTypesRaw ? loanTypesRaw.split(",").map(s => s.trim()).filter(Boolean) : null;
    const externalUrl = String(form.get("external_url") || "").trim() || null;
    const version = String(form.get("version") || "").trim() || null;
    const effectiveDate = String(form.get("effective_date") || "").trim() || null;

    if (!(file instanceof File)) {
      return new Response(JSON.stringify({ error: "Missing 'file' field (must be a PDF upload)" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
    if (!lenderId) {
      return new Response(JSON.stringify({ error: "Missing 'lender_id'" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
    if (file.type && !file.type.includes("pdf") && !file.name.toLowerCase().endsWith(".pdf")) {
      return new Response(JSON.stringify({ error: "File must be a PDF" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const { data: lender, error: lenderErr } = await sb.from("lenders")
      .select("id, name").eq("id", lenderId).single();
    if (lenderErr || !lender) {
      return new Response(JSON.stringify({ error: "Lender not found" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    if (!title) {
      title = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
    }

    const ts = Date.now();
    const safeName = sanitizeFilename(file.name);
    const objectPath = `${lenderId}/${ts}_${safeName}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isLarge = bytes.byteLength >= LARGE_PDF_THRESHOLD_BYTES;

    const { error: uploadErr } = await sb.storage
      .from("lender-guidelines")
      .upload(objectPath, bytes, {
        contentType: "application/pdf",
        cacheControl: "3600",
        upsert: false,
      });
    if (uploadErr) {
      console.error("[upload-guideline] storage error:", uploadErr.message);
      return new Response(JSON.stringify({ error: `Storage upload failed: ${uploadErr.message}` }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const { data: pub } = sb.storage.from("lender-guidelines").getPublicUrl(objectPath);
    const fileUrl = pub.publicUrl;

    const { data: guideline, error: insErr } = await sb.from("lender_guidelines").insert({
      lender_id: lenderId,
      title,
      category,
      file_url: fileUrl,
      file_name: file.name,
      file_size: bytes.byteLength,
      file_type: "application/pdf",
      external_url: externalUrl,
      version,
      effective_date: effectiveDate,
      is_active: true,
      loan_types: loanTypes,
      source_type: "lender",
      upload_source: "admin_uploader",
      // For large PDFs, seed status='running' so the auto-resume cron picks it up immediately
      chunk_status: isLarge ? "running" : null,
      last_page_processed: isLarge ? 0 : null,
    }).select("id").single();

    if (insErr) {
      await sb.storage.from("lender-guidelines").remove([objectPath]).catch(() => {});
      return new Response(JSON.stringify({ error: insErr.message }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // Route to the right chunker
    const chunkerName = isLarge ? "chunk-guidelines-large" : "chunk-guidelines";
    fetch(`${SUPABASE_URL}/functions/v1/${chunkerName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ guideline_id: guideline.id }),
    }).catch(e => console.warn(`[upload-guideline] ${chunkerName} dispatch failed:`, e.message));

    // Fire Google Drive backup
    fetch(`${SUPABASE_URL}/functions/v1/gdrive-sync-guideline`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ action: "sync_one", guideline_id: guideline.id }),
    }).catch(e => console.warn("[upload-guideline] gdrive dispatch failed:", e.message));

    const sizeMB = (bytes.byteLength / 1024 / 1024).toFixed(1);
    const indexingMessage = isLarge
      ? `Large PDF (${sizeMB}MB) \u2014 chunking in 25-page batches, ~3 min per 100 pages. Will appear in AI as it indexes.`
      : `AI indexing + Drive backup started in background (~1\u20132 min).`;

    return new Response(JSON.stringify({
      success: true,
      guideline_id: guideline.id,
      lender_id: lenderId,
      lender_name: lender.name,
      title,
      file_url: fileUrl,
      size_bytes: bytes.byteLength,
      is_large: isLarge,
      message: `Uploaded for ${lender.name}. ${indexingMessage}`,
    }), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (e: any) {
    console.error("[upload-guideline] FATAL:", e);
    return new Response(JSON.stringify({ error: e.message || String(e) }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
  }
});
