import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info' };
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

function generateSlug(length = 6): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const { action } = body;

    if (action === 'create') {
      const { destination_url, contact_id, saved_search_id } = body;
      if (!destination_url) return err('destination_url required');

      // Check if URL already has a short link
      const { data: existing } = await sb.from('short_links')
        .select('slug')
        .eq('destination_url', destination_url)
        .limit(1)
        .single();
      if (existing) {
        return ok({ slug: existing.slug, short_url: `https://homes.ratesandrealty.com/s/${existing.slug}`, existing: true });
      }

      // Generate unique slug
      let slug = generateSlug();
      let attempts = 0;
      while (attempts < 10) {
        const { data: conflict } = await sb.from('short_links').select('id').eq('slug', slug).single();
        if (!conflict) break;
        slug = generateSlug();
        attempts++;
      }

      const { data, error } = await sb.from('short_links').insert({
        slug,
        destination_url,
        contact_id: contact_id || null,
        saved_search_id: saved_search_id || null
      }).select().single();

      if (error) return err(error.message, 500);
      return ok({ slug, short_url: `https://homes.ratesandrealty.com/s/${slug}`, id: data.id });
    }

    if (action === 'resolve') {
      const { slug } = body;
      if (!slug) return err('slug required');
      const { data } = await sb.from('short_links').select('destination_url, click_count').eq('slug', slug).single();
      if (!data) return err('Link not found', 404);
      // Increment click count
      await sb.from('short_links').update({ click_count: (data.click_count || 0) + 1 }).eq('slug', slug);
      return ok({ destination_url: data.destination_url });
    }

    return err('Unknown action');
  } catch(e: any) {
    return err(e.message || 'Server error', 500);
  }
});
