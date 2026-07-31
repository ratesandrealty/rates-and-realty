// news-feed: pulls mortgage/real-estate HEADLINES + the publisher's own RSS <description> blurb
// (title + link + the feed-provided summary) from public RSS feeds meant for syndication, and
// caches them in market_news. We store ONLY what the publisher puts in their syndication feed
// (headline, their own short description, link back) — never scraped article body. Copyright-safe.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey' };
const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const FEEDS: { url: string; source: string }[] = [
  { url: 'https://www.cnbc.com/id/10000115/device/rss/rss.html', source: 'CNBC Real Estate' },
  { url: 'https://www.nationalmortgagenews.com/feed', source: 'National Mortgage News' },
  { url: 'https://www.housingwire.com/feed', source: 'HousingWire' },
  { url: 'https://themortgagereports.com/feed', source: 'The Mortgage Reports' }
];

function decodeEntities(s: string): string {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#0*38;/g, '&').replace(/&amp;/gi, '&')
    .replace(/&#0*60;/g, '<').replace(/&lt;/gi, '<')
    .replace(/&#0*62;/g, '>').replace(/&gt;/gi, '>')
    .replace(/&#0*34;/g, '"').replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'").replace(/&apos;/gi, "'")
    .replace(/&#8217;/g, '\u2019').replace(/&#8216;/g, '\u2018')
    .replace(/&#8220;/g, '\u201c').replace(/&#8221;/g, '\u201d')
    .replace(/&#8211;/g, '\u2013').replace(/&#8212;/g, '\u2014')
    .replace(/&nbsp;/gi, ' ').replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ').trim();
}

function clip(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > n * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + '\u2026';
}

function parseItems(xml: string): { title: string; link: string; desc: string; pub: string | null }[] {
  const out: { title: string; link: string; desc: string; pub: string | null }[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  const useAtom = blocks.length === 0;
  const chunks = useAtom ? xml.split(/<entry[\s>]/i).slice(1) : blocks;
  for (const c of chunks) {
    const tm = c.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    let link = '';
    const lm = c.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    if (lm && lm[1].trim()) link = lm[1].trim();
    if (!link) { const lh = c.match(/<link[^>]*href="([^"]+)"/i); if (lh) link = lh[1].trim(); }
    const pm = c.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i);
    // publisher-provided summary: RSS <description> or Atom <summary>
    const dm = c.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || c.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
    const title = tm ? decodeEntities(tm[1]) : '';
    const desc = dm ? clip(decodeEntities(dm[1]), 200) : '';
    if (title && link && /^https?:\/\//i.test(link)) out.push({ title, link, desc, pub: pm ? pm[1].trim() : null });
    if (out.length >= 12) break;
  }
  return out;
}

async function tryFeed(f: { url: string; source: string }) {
  try {
    const res = await fetch(f.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RatesAndRealtyBot/1.0; +https://ratesandrealty.com)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      }
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const items = parseItems(xml);
    if (items.length) return items.map(i => ({ ...i, source: f.source }));
    return null;
  } catch (_e) { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || new URL(req.url).searchParams.get('action') || 'refresh';

    if (action === 'list') {
      const { data } = await db.from('market_news').select('title,link,source,description,published_at').order('published_at', { ascending: false, nullsFirst: false }).limit(6);
      return json({ ok: true, items: data || [] });
    }

    let picked: any[] | null = null; let usedSource = '';
    for (const f of FEEDS) {
      const items = await tryFeed(f);
      if (items && items.length) { picked = items; usedSource = f.source; break; }
    }
    if (!picked) return json({ ok: false, error: 'no feed reachable', tried: FEEDS.map(f => f.source) }, 502);

    const rows = picked.slice(0, 10).map(i => ({
      title: i.title.slice(0, 300), link: i.link, source: i.source, description: i.desc || null,
      published_at: i.pub ? new Date(i.pub).toISOString() : null, fetched_at: new Date().toISOString()
    })).filter(r => r.title && r.link);

    if (rows.length) await db.from('market_news').upsert(rows, { onConflict: 'link', ignoreDuplicates: false });
    const { data: keep } = await db.from('market_news').select('id').order('fetched_at', { ascending: false }).limit(30);
    if (keep && keep.length === 30) {
      const minId = Math.min(...keep.map((k: any) => k.id));
      await db.from('market_news').delete().lt('id', minId);
    }
    return json({ ok: true, source: usedSource, upserted: rows.length, with_desc: rows.filter(r => r.description).length });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
