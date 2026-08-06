import { requireStaff } from "../_shared/require-staff.ts";
// parse-signature (v1) — reads an email-signature screenshot and returns structured contact fields.
// Vision via claude-sonnet-4-6. CORS allow-list includes x-client-info. Errors return HTTP 200 {error}.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ALLOWED_MEDIA = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  /* GUARD FIRST — before the body or query string is read, so an action
     added later is covered by default rather than by remembering.
     verify_jwt=true does NOT do this: the anon key is a project-signed JWT
     printed in every page's source. See docs/PINNED-NOT-GUARDED.md. */
  const _auth = await requireStaff(req);
  if (!_auth.ok) return new Response(JSON.stringify({ error: _auth.msg || 'not authorized' }),
    { status: _auth.status || 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' });

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'missing_api_key', detail: 'ANTHROPIC_API_KEY not set' });

    let payload: Record<string, unknown> = {};
    try { payload = await req.json(); } catch { return json({ error: 'bad_json' }); }

    let image_base64 = String(payload.image_base64 ?? '').trim();
    let media_type = String(payload.media_type ?? '').trim().toLowerCase();
    const role = (payload.role ?? null) as string | null;

    if (!image_base64) return json({ error: 'no_image', detail: 'image_base64 is required' });

    // Accept full data URLs (data:image/png;base64,xxxx) and split off the prefix.
    const m = image_base64.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) {
      if (!media_type) media_type = m[1].toLowerCase();
      image_base64 = m[2];
    }
    if (!media_type) media_type = 'image/png';
    if (!ALLOWED_MEDIA.includes(media_type)) {
      return json({ error: 'unsupported_media', detail: `media_type ${media_type} not supported` });
    }

    const instruction =
      'You extract contact details from an email-signature screenshot for a mortgage CRM. ' +
      'Respond with ONLY a JSON object (no markdown, no commentary) using exactly these keys: ' +
      'name, title, company, phone, email, website. ' +
      'name = the person\u2019s full name. title = their job title/role if shown. company = business/brokerage name. ' +
      'phone = the best direct/mobile phone number, digits and common formatting preserved. ' +
      'email = their email address. website = company website if shown. ' +
      'Use null (not empty string) for any field that is not clearly present. Never invent or guess values. ' +
      'If multiple phone numbers appear, prefer the one labeled mobile/cell/direct.';

    const anthropicReq = {
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type, data: image_base64 } },
            { type: 'text', text: instruction },
          ],
        },
      ],
    };

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(anthropicReq),
    });

    const raw = await resp.json().catch(() => null);
    if (!resp.ok) {
      return json({ error: 'anthropic_error', detail: raw?.error?.message ?? `status ${resp.status}` });
    }

    const text = Array.isArray(raw?.content)
      ? raw.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('').trim()
      : '';

    // Defensive: pull the first {...} block in case the model adds stray text.
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      return json({ error: 'parse_failed', detail: 'Could not read structured data from the image', raw_text: text });
    }

    const clean = (v: unknown) => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      return s === '' || s.toLowerCase() === 'null' ? null : s;
    };

    const data = {
      name: clean(parsed.name),
      title: clean(parsed.title),
      company: clean(parsed.company),
      phone: clean(parsed.phone),
      email: clean(parsed.email),
      website: clean(parsed.website),
    };

    return json({ ok: true, role, data });
  } catch (e) {
    return json({ error: 'unexpected', detail: String((e as Error)?.message ?? e) });
  }
});
