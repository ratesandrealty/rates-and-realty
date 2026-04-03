import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CANVA_ACCESS_TOKEN = Deno.env.get('CANVA_ACCESS_TOKEN');
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  if (!CANVA_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ error: 'CANVA_ACCESS_TOKEN not set' }), {
      status: 500, headers: cors
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { action, continuation } = body;

    if (action === 'list_designs') {
      const url = new URL('https://api.canva.com/rest/v1/designs');
      url.searchParams.set('limit', '50');
      url.searchParams.set('sort_by', 'modified_descending');
      if (continuation) url.searchParams.set('continuation', continuation);

      const res = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${CANVA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        }
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error('[canva-proxy] Canva API error:', res.status, errText);
        return new Response(JSON.stringify({ error: `Canva API ${res.status}`, detail: errText }), {
          status: res.status, headers: cors
        });
      }

      const data = await res.json();
      const designs = (data.items || []).map((item: any) => {
        const d = item.design || item;
        return {
          id: d.id,
          title: d.title || 'Untitled',
          thumbnail: d.thumbnail?.url || null,
          thumbnail_width: d.thumbnail?.width || 300,
          thumbnail_height: d.thumbnail?.height || 300,
          view_url: d.urls?.view_url || null,
          edit_url: d.urls?.edit_url || null,
          page_count: d.page_count || 1,
          updated_at: d.updated_at,
        };
      });

      return new Response(JSON.stringify({
        designs,
        continuation: data.continuation || null,
      }), { headers: cors });
    }

    if (action === 'get_thumbnail') {
      const { design_id } = body;
      if (!design_id) return new Response(JSON.stringify({ error: 'design_id required' }), { status: 400, headers: cors });

      const res = await fetch(`https://api.canva.com/rest/v1/designs/${design_id}`, {
        headers: { 'Authorization': `Bearer ${CANVA_ACCESS_TOKEN}` }
      });
      if (!res.ok) return new Response(JSON.stringify({ error: 'Failed to get design' }), { status: res.status, headers: cors });
      const data = await res.json();
      const d = data.design || data;
      return new Response(JSON.stringify({
        id: d.id,
        title: d.title,
        thumbnail: d.thumbnail?.url || null,
        view_url: d.urls?.view_url || null,
      }), { headers: cors });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: cors });
  } catch (err: any) {
    console.error('[canva-proxy] Error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
});
