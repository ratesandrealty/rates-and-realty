// save-document edge function
//
// Accepts a signed request from the admin CRM to apply a rotation to a PDF
// stored in Google Drive. Writes the rotated PDF back as a NEW Drive file
// in the same parent folder (original stays recoverable).
//
// Request body (JSON):
//   { file_id: string, rotation_degrees: 90|180|270 }
//
// Also accepts `drive_file_id` or `document_id` as aliases for file_id.
//
// Headers:
//   Authorization: Bearer <supabase_access_token>
//
// Auth: the bearer is a Supabase user JWT. We verify it via sb.auth.getUser()
// using the service-role client — the service role only verifies the JWT; it
// does not write any storage objects.
//
// Google Drive auth: uses the same user OAuth refresh token flow as
// gdrive-sync / gdrive-proxy (GOOGLE_DRIVE_REFRESH_TOKEN + GOOGLE_CLIENT_ID
// + GOOGLE_CLIENT_SECRET). Service accounts cannot upload file bytes to
// personal My Drive folders.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, degrees } from "https://esm.sh/pdf-lib@1.17.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function getGoogleAccessToken(): Promise<string | null> {
  try {
    const refreshToken = Deno.env.get("GOOGLE_DRIVE_REFRESH_TOKEN");
    const clientId     = Deno.env.get("GOOGLE_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
    if (!refreshToken || !clientId || !clientSecret) {
      console.error("[save-document] Missing GOOGLE_DRIVE_REFRESH_TOKEN / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET");
      return null;
    }
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      console.error("[save-document] token refresh failed:", JSON.stringify(data));
      return null;
    }
    return data.access_token as string;
  } catch (e) {
    console.error("[save-document] getGoogleAccessToken error:", (e as Error).message);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const ok  = (d: unknown) => new Response(JSON.stringify(d), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    // 1. Verify Supabase JWT from Authorization header.
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return err("Missing Authorization header", 401);

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: userData, error: authErr } = await sb.auth.getUser(jwt);
    if (authErr || !userData?.user) return err("Invalid or expired session", 401);
    const userEmail = userData.user.email || "(no email)";

    // 2. Parse body and figure out the operation.
    //    Dispatch: if `crop` object is set → crop. Else if rotation_degrees → rotate.
    const body = await req.json().catch(() => ({} as any));
    const fileId: string = body.file_id || body.drive_file_id || body.document_id || "";
    if (!fileId) return err("file_id (or drive_file_id / document_id) required");

    const hasRotate = body.rotation_degrees !== undefined && body.rotation_degrees !== null;
    const hasCrop   = body.crop && typeof body.crop === "object";
    if (hasRotate && hasCrop) return err("Specify either rotation_degrees or crop, not both");
    if (!hasRotate && !hasCrop) return err("Specify rotation_degrees or crop");

    let normalizedRot = 0;
    let cropPage = 0;
    let cropX = 0, cropY = 0, cropW = 0, cropH = 0;
    let opLabel = "";
    let newNameSuffix = "";

    if (hasRotate) {
      const rotationDegrees = Number(body.rotation_degrees || 0);
      normalizedRot = (((rotationDegrees % 360) + 360) % 360);
      if (![0, 90, 180, 270].includes(normalizedRot)) {
        return err("rotation_degrees must be a multiple of 90");
      }
      if (normalizedRot === 0) return err("rotation_degrees is 0 — nothing to save");
      opLabel = "rotated";
      newNameSuffix = `_rotated_${Date.now()}`;
    } else {
      // Crop path
      const c = body.crop || {};
      cropPage = Number(c.page || 0);
      cropX = Number(c.x);
      cropY = Number(c.y);
      cropW = Number(c.width);
      cropH = Number(c.height);
      if (!Number.isFinite(cropPage) || cropPage < 1 || Math.floor(cropPage) !== cropPage) {
        return err("crop.page must be a positive integer (1-indexed)");
      }
      if (![cropX, cropY, cropW, cropH].every(Number.isFinite)) {
        return err("crop.x, crop.y, crop.width, crop.height must be finite numbers");
      }
      if (cropW <= 0 || cropH <= 0) return err("crop.width and crop.height must be > 0");
      opLabel = "cropped";
      newNameSuffix = `_cropped_${Date.now()}`;
    }

    // 3. Get a Google OAuth access token (user flow — SA has no storage quota).
    const googleToken = await getGoogleAccessToken();
    if (!googleToken) {
      return err("Google OAuth token unavailable (check GOOGLE_DRIVE_REFRESH_TOKEN / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)", 500);
    }

    // 4. Fetch the original file's metadata so we know its name and parent folder.
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,parents&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${googleToken}` } },
    );
    if (!metaRes.ok) {
      const txt = await metaRes.text();
      return err(`Drive metadata fetch failed: ${metaRes.status} ${txt}`, 502);
    }
    const meta = await metaRes.json();
    if (!(meta.mimeType || "").includes("pdf")) {
      return err(`File is not a PDF (mimeType=${meta.mimeType})`, 400);
    }

    // 5. Download the original PDF bytes.
    const dlRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${googleToken}` } },
    );
    if (!dlRes.ok) {
      const txt = await dlRes.text();
      return err(`Drive download failed: ${dlRes.status} ${txt}`, 502);
    }
    const origBytes = new Uint8Array(await dlRes.arrayBuffer());

    // 6. Apply the transformation via pdf-lib.
    let newBytes: Uint8Array;
    try {
      const pdfDoc = await PDFDocument.load(origBytes);

      if (hasRotate) {
        for (const page of pdfDoc.getPages()) {
          const existing = page.getRotation().angle || 0;
          page.setRotation(degrees((existing + normalizedRot) % 360));
        }
      } else {
        // Crop: set MediaBox on the specified page to the caller's rectangle.
        // Coordinates are already in PDF points with bottom-left origin —
        // the browser flips the y axis before sending.
        const pages = pdfDoc.getPages();
        if (cropPage > pages.length) {
          return err(`crop.page ${cropPage} out of range (document has ${pages.length} pages)`);
        }
        const page = pages[cropPage - 1];
        const { width: pw, height: ph } = page.getSize();
        // Clamp so the crop box never exceeds the current page bounds.
        const x = Math.max(0, Math.min(pw, cropX));
        const y = Math.max(0, Math.min(ph, cropY));
        const w = Math.max(1, Math.min(pw - x, cropW));
        const h = Math.max(1, Math.min(ph - y, cropH));
        page.setMediaBox(x, y, w, h);
        // Also set the CropBox so viewers that honor CropBox render the clipped area.
        try { (page as any).setCropBox(x, y, w, h); } catch (_) {}
      }

      newBytes = await pdfDoc.save();
    } catch (e) {
      return err("pdf-lib failed to process PDF: " + ((e as Error).message || String(e)), 500);
    }

    // 7. Upload as a NEW Drive file in the same parent folder(s).
    const origName: string = meta.name || "document.pdf";
    const stem = origName.replace(/\.pdf$/i, "");
    const newName = `${stem}${newNameSuffix}.pdf`;
    const parents: string[] = Array.isArray(meta.parents) ? meta.parents : [];

    const boundary = "save_" + crypto.randomUUID();
    const metadata = JSON.stringify({ name: newName, parents, mimeType: "application/pdf" });
    const encoder = new TextEncoder();
    const head = encoder.encode(
      `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        metadata + `\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: application/pdf\r\n\r\n`,
    );
    const tail = encoder.encode(`\r\n--${boundary}--`);
    const multipartBody = new Uint8Array(head.length + newBytes.length + tail.length);
    multipartBody.set(head, 0);
    multipartBody.set(newBytes, head.length);
    multipartBody.set(tail, head.length + newBytes.length);

    const upRes = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,webContentLink,mimeType,size,parents,createdTime,modifiedTime,thumbnailLink,iconLink,appProperties",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${googleToken}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      },
    );
    if (!upRes.ok) {
      const txt = await upRes.text();
      return err(`Drive upload failed: ${upRes.status} ${txt}`, 502);
    }
    const newFile = await upRes.json();

    console.log(`[save-document] ${userEmail} ${opLabel} ${fileId} → new file ${newFile.id}`);
    return ok({
      success: true,
      file_id: newFile.id,
      file_url: newFile.webViewLink || null,
      name: newFile.name,
      file: newFile,
    });
  } catch (e) {
    console.error("save-document error:", e);
    return err((e as Error).message || "Server error", 500);
  }
});
