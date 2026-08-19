import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { PDFDocument, rgb, StandardFonts } from 'https://esm.sh/pdf-lib@1.17.1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

function base64ToUint8Array(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.split(',')[1] : b64;
  const bin = atob(clean);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function uint8ArrayToBase64(arr: Uint8Array): string {
  let bin = '';
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Detect actual image type from magic bytes — never trust mime_type alone
function detectImageType(bytes: Uint8Array): 'png' | 'jpeg' | 'unknown' {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
  return 'unknown';
}

async function imageToPdf(imageBytes: Uint8Array, fileName: string): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const detectedType = detectImageType(imageBytes);
  console.log('Detected image type:', detectedType, 'first bytes:', Array.from(imageBytes.slice(0,4)).map(b => b.toString(16)));

  let image;
  if (detectedType === 'png') {
    image = await pdfDoc.embedPng(imageBytes);
  } else if (detectedType === 'jpeg') {
    image = await pdfDoc.embedJpg(imageBytes);
  } else {
    // Try PNG first, then JPEG
    try {
      image = await pdfDoc.embedPng(imageBytes);
    } catch {
      image = await pdfDoc.embedJpg(imageBytes);
    }
  }

  const { width, height } = image.scale(1);
  const maxW = 595, maxH = 842;
  const scale = Math.min(maxW / width, maxH / height, 1);
  const scaledW = width * scale;
  const scaledH = height * scale;
  const page = pdfDoc.addPage([scaledW, scaledH]);
  page.drawImage(image, { x: 0, y: 0, width: scaledW, height: scaledH });
  return pdfDoc.save();
}

async function textToPdf(text: string): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([595, 842]);
  const lines = text.split('\n');
  let y = 800;
  for (const line of lines) {
    if (y < 40) { pdfDoc.addPage([595, 842]); y = 800; }
    page.drawText(line.substring(0, 100), { x: 40, y, size: 11, font, color: rgb(0, 0, 0) });
    y -= 16;
  }
  return pdfDoc.save();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const { file_base64, mime_type, file_name } = body;
    if (!file_base64) return err('file_base64 required');

    const fileBytes = base64ToUint8Array(file_base64);
    const lowerMime = (mime_type || '').toLowerCase();
    const lowerName = (file_name || '').toLowerCase();

    // Already a PDF
    if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf')) {
      return ok({ success: true, already_pdf: true, pdf_base64: uint8ArrayToBase64(fileBytes), original_name: file_name, pdf_name: file_name, method: 'passthrough' });
    }

    const isImageMime = lowerMime.startsWith('image/');
    const isImageExt = /\.(jpg|jpeg|png|gif|bmp|tiff|tif|webp)$/.test(lowerName);
    const isTextMime = lowerMime === 'text/plain' || lowerName.endsWith('.txt');
    const isOfficeMime = lowerMime.includes('officedocument') || lowerMime.includes('msword') || /\.(docx|doc|xlsx|xls|pptx|ppt)$/.test(lowerName);
    const isHeic = lowerMime === 'image/heic' || lowerMime === 'image/heif' || /\.(heic|heif)$/.test(lowerName);

    let pdfBytes: Uint8Array;
    let method = '';

    if (isHeic) return err('HEIC not supported. Convert to JPG first.', 415);
    if (isOfficeMime) return err('Office documents cannot be converted automatically. Upload as PDF.', 415);

    if (isImageMime || isImageExt) {
      pdfBytes = await imageToPdf(fileBytes, file_name || 'document');
      method = 'image_embed';
    } else if (isTextMime) {
      const text = new TextDecoder().decode(fileBytes);
      pdfBytes = await textToPdf(text);
      method = 'text_embed';
    } else {
      // Try as image anyway using magic byte detection
      const detected = detectImageType(fileBytes);
      if (detected !== 'unknown') {
        pdfBytes = await imageToPdf(fileBytes, file_name || 'document');
        method = 'image_embed_fallback';
      } else {
        return err(`Unsupported file type: ${mime_type || 'unknown'}. Supported: JPG, PNG, GIF, BMP, TIFF, WEBP, TXT, PDF`, 415);
      }
    }

    const pdfName = (file_name || 'document').replace(/\.[^.]+$/, '') + '.pdf';
    return ok({ success: true, already_pdf: false, pdf_base64: uint8ArrayToBase64(pdfBytes), original_name: file_name, pdf_name: pdfName, pdf_size: pdfBytes.length, method });

  } catch(e: any) {
    console.error('convert-to-pdf error:', e);
    return err(e.message || 'Conversion failed', 500);
  }
});
