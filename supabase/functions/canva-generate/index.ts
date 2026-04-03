import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const CANVA_TOKEN = Deno.env.get('CANVA_ACCESS_TOKEN');
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  if (!CANVA_TOKEN) {
    return new Response(JSON.stringify({ error: 'CANVA_ACCESS_TOKEN not set. Set it via: npx supabase secrets set CANVA_ACCESS_TOKEN=your_token' }), {
      status: 500, headers: cors
    });
  }
  if (!ANTHROPIC_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), {
      status: 500, headers: cors
    });
  }

  try {
    const { prompt, design_type, contact } = await req.json();
    if (!prompt) {
      return new Response(JSON.stringify({ error: 'prompt required' }), { status: 400, headers: cors });
    }

    // Step 1: Use Claude to generate a design title + description
    console.log('[canva-generate] Prompt:', prompt, 'Type:', design_type);
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `You are a mortgage marketing design assistant for Rene Duarte, a Mortgage Loan Officer at Rates & Realty in Huntington Beach, CA. NMLS #1795044. Phone: 714-472-8508.

Convert this design request into a Canva design title and description.
Design type: ${design_type || 'flyer'}
Request: ${prompt}
${contact?.first_name ? 'For contact: ' + contact.first_name : ''}

Return ONLY valid JSON, no other text:
{"title": "short title max 60 chars", "description": "design description max 150 chars"}`
        }]
      })
    });

    const claudeData = await claudeRes.json();
    const rawText = (claudeData.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    let brief = { title: prompt.substring(0, 60), description: prompt };
    try { brief = JSON.parse(rawText); } catch { console.log('[canva-generate] Claude parse fallback, raw:', rawText); }

    console.log('[canva-generate] Brief:', brief.title);

    // Step 2: Map design_type to Canva design type
    const typeMap: Record<string, string> = {
      'flyer': 'FLYER',
      'social': 'INSTAGRAM_POST',
      'email': 'EMAIL_HEADER',
      'banner': 'EMAIL_HEADER',
      'postcard': 'POSTCARD',
      'presentation': 'PRESENTATION',
    };
    const canvaType = typeMap[design_type || 'flyer'] || 'FLYER';

    // Step 3: Create design via Canva API
    const createRes = await fetch('https://api.canva.com/rest/v1/designs', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CANVA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        design_type: { type: canvaType },
        title: brief.title,
      })
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error('[canva-generate] Canva create error:', createRes.status, errText);
      return new Response(JSON.stringify({
        error: `Canva API error ${createRes.status}`,
        detail: errText,
      }), { status: createRes.status, headers: cors });
    }

    const createData = await createRes.json();
    const design = createData.design || createData;
    console.log('[canva-generate] Design created:', design.id, design.title);

    return new Response(JSON.stringify({
      success: true,
      design_id: design.id,
      title: design.title || brief.title,
      thumbnail: design.thumbnail?.url || null,
      view_url: design.urls?.view_url || null,
      edit_url: design.urls?.edit_url || null,
      brief,
    }), { headers: cors });

  } catch (err: any) {
    console.error('[canva-generate] Error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
});
