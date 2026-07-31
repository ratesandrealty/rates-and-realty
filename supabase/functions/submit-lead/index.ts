// submit-lead — public form intake gated by Cloudflare Turnstile.
// Verifies the Turnstile token, then writes with the service role (server-side),
// and subscribes to MailerLite server-side (key no longer exposed in the browser).
// Handles two shapes: kind:'inquiry' (contact form) and kind:'lead' (homepage form).

const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET_KEY") || "";
const ML_KEY = Deno.env.get("MAILERLITE_API_KEY") || "";
const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ML_GROUP = "182704876024759829"; // New Leads - Rates & Realty

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function sbInsert(table: string, row: Record<string, unknown>) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE,
      Authorization: `Bearer ${SB_SERVICE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${table} ${res.status}: ${text}`);
  return JSON.parse(text)[0];
}

async function mlSubscribe(email: string, name: string, last_name: string, phone: string) {
  if (!ML_KEY || !email) return;
  try {
    await fetch("https://connect.mailerlite.com/api/subscribers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ML_KEY}` },
      body: JSON.stringify({ email, fields: { name: name || "", last_name: last_name || "", phone: phone || "" }, groups: [ML_GROUP] }),
    });
  } catch (_) { /* non-blocking */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  // 1) Verify Cloudflare Turnstile
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "";
  const token = body.turnstileToken || body["cf-turnstile-response"] || "";
  if (!token) return json({ error: "captcha_missing" }, 403);
  try {
    const vres = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: ip }),
    });
    const v = await vres.json();
    if (!v.success) return json({ error: "captcha_failed", detail: v["error-codes"] || [] }, 403);
  } catch (_) {
    return json({ error: "captcha_error" }, 502);
  }

  const kind = body.kind || "inquiry";
  try {
    if (kind === "lead") {
      const contact = await sbInsert("contacts", {
        first_name: body.firstName || body.first_name || "",
        last_name: body.lastName || body.last_name || "",
        email: body.email || null,
        phone: body.phone || null,
        source: body.source || "website",
        contact_type: "borrower",
      });
      let lead: any = null;
      try {
        lead = await sbInsert("leads", {
          contact_id: contact.id,
          status: "new",
          lead_type: "mortgage",
          loan_type: body.loanType || body.loan_type || null,
          timeline: body.timeline || null,
          notes: body.funnelTag ? `[${body.funnelTag}] ${body.notes || ""}`.trim() : (body.notes || null),
          source: body.source || "website",
        });
      } catch (e) { console.error("leads insert (non-fatal):", String(e)); }
      await mlSubscribe(body.email, body.firstName || body.first_name, body.lastName || body.last_name, body.phone);
      return json({ ok: true, contact_id: contact.id, lead_id: lead?.id || null });
    }

    // default: contact inquiry
    const row = await sbInsert("contact_inquiries", {
      first_name: body.first_name || body.firstName || "",
      last_name: body.last_name || body.lastName || "",
      email: body.email || null,
      phone: body.phone || null,
      inquiry_type: body.inquiry_type || null,
      message: body.message || "",
      created_at: new Date().toISOString(),
    });
    await mlSubscribe(body.email, body.first_name || body.firstName, body.last_name || body.lastName, body.phone);
    return json({ ok: true, id: row.id });
  } catch (e) {
    return json({ error: "insert_failed", detail: String((e as Error)?.message || e) }, 500);
  }
});
