import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// A short list of common languages for the picker; VAs can still request any code.
const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "tl", name: "Tagalog" },
  { code: "pt", name: "Portuguese" },
  { code: "fr", name: "French" },
  { code: "hi", name: "Hindi" },
  { code: "zh", name: "Chinese (Simplified)" },
  { code: "vi", name: "Vietnamese" },
  { code: "ar", name: "Arabic" },
  { code: "ru", name: "Russian" },
  { code: "uk", name: "Ukrainian" },
  { code: "id", name: "Indonesian" },
];
const langName = (code: string) => LANGUAGES.find((l) => l.code === code)?.name || code;

async function md5(s: string): Promise<string> {
  // lightweight stable hash (not cryptographic) to detect source changes
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function requireAdmin(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  if (token === SERVICE_KEY) return true;
  try {
    const u = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: { user } } = await u.auth.getUser();
    if (!user) return false;
    const { data: role } = await sb.from("auth_user_roles").select("role").eq("user_id", user.id).maybeSingle();
    return role?.role === "admin";
  } catch (_e) {
    return false;
  }
}

async function translateBlocks(blocks: any[], lang: string): Promise<Record<string, { title: string; body: string }>> {
  if (!ANTHROPIC_KEY || !blocks.length) return {};
  const payload = blocks.map((b) => ({ key: b.key, title: b.title, body: b.body }));
  const sys =
    `Translate the help sections below into ${langName(lang)}. ` +
    `Return ONLY a JSON array; each item must be {"key","title","body"} with the SAME key. ` +
    `Preserve Markdown formatting exactly (**bold**, line breaks). ` +
    `Do NOT translate these names, keep them as-is: Rates & Realty, Rene, ClickUp, Loom. ` +
    `Natural, friendly tone. No commentary, JSON only.`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 2000,
        messages: [{ role: "user", content: sys + "\n\n" + JSON.stringify(payload) }],
      }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    let text = (data.content?.[0]?.text || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const arr = JSON.parse(text);
    const out: Record<string, { title: string; body: string }> = {};
    for (const item of (Array.isArray(arr) ? arr : [])) {
      if (item && item.key) out[item.key] = { title: String(item.title || ""), body: String(item.body || "") };
    }
    return out;
  } catch (_e) {
    return {};
  }
}

/* ── ONE STORE: help_topics ──────────────────────────────────────────────────
 *
 * This read `va_portal_help`, a table holding four rows byte-identical to four
 * rows in `help_topics` whose keys differ only by a `va.` prefix. help_topics was
 * seeded FROM it on 2026-07-07 and va_portal_help has not been touched since
 * 2026-07-04. Meanwhile the ⓘ component and the management page both moved to
 * help_topics — so admin/va-tasks.html was running BOTH systems on the SAME
 * three topics, with the buttons the VA can actually see reading the store
 * WITHOUT translation.
 *
 * FIELD MAP, since the two schemas name things differently:
 *     va_portal_help.key   -> help_topics.topic_key   (keeps the `va.` prefix)
 *     va_portal_help.body  -> help_topics.description
 *
 * THE PREFIX IS KEPT. Dropping it would be a second, silent breakage: the three
 * data-help-topic attributes in va-tasks.html say `va.welcome` etc., and a
 * mismatch here renders an empty block with nothing erroring — the same shape as
 * a stale ?v= pin.
 *
 * `area in ('va','both')` is what scopes this endpoint to VA-facing topics, so
 * the ~60 CRM tooltip topics coming with the rollout do not appear in the VA
 * portal's help list. That is exactly what `area` was always for.
 *
 * va_portal_help is deliberately NOT dropped. It now has no reader; leave it
 * until translation has been proven working end to end at least once.
 */
async function list(lang: string) {
  const { data: blocks } = await sb.from("help_topics")
    .select("topic_key, title, description, video_url, sort_order")
    .eq("is_active", true)
    .in("area", ["va", "both"])
    .order("sort_order").order("topic_key");
  const rows = (blocks || []).map((b: any) => ({
    key: b.topic_key, title: b.title, body: b.description, video_url: b.video_url,
  }));
  const targetLang = (lang || "en").toLowerCase();

  if (targetLang === "en") {
    return rows.map((b: any) => ({ key: b.key, title: b.title, body: b.body, video_url: b.video_url }));
  }

  // hash each source block to detect staleness
  const hashByKey: Record<string, string> = {};
  for (const b of rows) hashByKey[b.key] = await md5(b.title + "\u0000" + b.body);

  const { data: cached } = await sb
    .from("va_portal_help_i18n")
    .select("*")
    .eq("lang", targetLang)
    .in("key", rows.map((b: any) => b.key));
  const cacheByKey: Record<string, any> = {};
  for (const c of (cached || [])) cacheByKey[c.key] = c;

  const needsTranslation = rows.filter((b: any) => {
    const c = cacheByKey[b.key];
    return !c || c.source_hash !== hashByKey[b.key];
  });

  let fresh: Record<string, { title: string; body: string }> = {};
  if (needsTranslation.length) {
    fresh = await translateBlocks(needsTranslation, targetLang);
    const upserts = needsTranslation
      .filter((b: any) => fresh[b.key])
      .map((b: any) => ({
        key: b.key, lang: targetLang,
        title: fresh[b.key].title, body: fresh[b.key].body,
        source_hash: hashByKey[b.key], translated_at: new Date().toISOString(),
      }));
    if (upserts.length) await sb.from("va_portal_help_i18n").upsert(upserts, { onConflict: "key,lang" });
  }

  return rows.map((b: any) => {
    const t = fresh[b.key] || cacheByKey[b.key];
    return {
      key: b.key,
      title: t?.title || b.title,   // fall back to English if translation unavailable
      body: t?.body || b.body,
      video_url: b.video_url,
    };
  });
}

async function save(req: Request, body: any) {
  if (!(await requireAdmin(req))) return json({ error: "admin only" }, 403);
  const key = String(body.key || "").trim();
  if (!key) return json({ error: "key required" }, 400);
  /* Same field map as list(). `area` defaults to 'va' for anything saved through
     THIS endpoint — it is the VA portal's editor, so a block created here is a
     VA block, and leaving it to help_topic_upsert's 'crm' default is how the
     four existing rows drifted to the wrong area in the first place. */
  const row: any = { topic_key: key, area: "va", updated_at: new Date().toISOString() };
  if (body.title !== undefined) row.title = String(body.title);
  if (body.body !== undefined) row.description = String(body.body);
  if (body.video_url !== undefined) row.video_url = body.video_url ? String(body.video_url) : null;
  if (body.sort_order !== undefined) row.sort_order = Number(body.sort_order) || 0;
  if (body.is_active !== undefined) row.is_active = !!body.is_active;
  // title/body required on first insert
  const { data: existing } = await sb.from("help_topics").select("topic_key").eq("topic_key", key).maybeSingle();
  if (!existing && (row.title === undefined || row.description === undefined)) {
    return json({ error: "title and body required for a new block" }, 400);
  }
  /* Never overwrite an existing row's area — an admin may have deliberately set
     it to 'both' so a topic serves the CRM tooltip AND the VA portal. */
  if (existing) delete row.area;
  const { error } = await sb.from("help_topics").upsert(row, { onConflict: "topic_key" });
  if (error) return json({ error: error.message }, 400);
  // invalidate cached translations for this block so they regenerate on next view
  await sb.from("va_portal_help_i18n").delete().eq("key", key);
  return json({ success: true });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";
    if (action === "languages") return json({ languages: LANGUAGES });
    if (action === "list") return json({ blocks: await list(body.lang || "en"), lang: (body.lang || "en").toLowerCase() });
    if (action === "save") return json(await save(req, body));
    return json({ error: "unknown action", actions: ["list", "save", "languages"] }, 400);
  } catch (e: any) {
    return json({ error: e?.message || "error" }, 500);
  }
});
