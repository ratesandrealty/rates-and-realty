// treasury-yields: pulls the U.S. Treasury Daily Yield Curve (public-domain govt data)
// and upserts 2/5/10/30yr into treasury_yields. Legit source (home.treasury.gov XML feed).
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,GET,OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey" };

function num(block: string, tag: string): number | null {
  const m = block.match(new RegExp(`<d:${tag}[^>]*>([\\d.\\-]+)</d:${tag}>`));
  if (!m) return null;
  const v = parseFloat(m[1]);
  return isFinite(v) ? v : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  try {
    const year = new Date().getUTCFullYear();
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`;
    const res = await fetch(url, { headers: { "User-Agent": "RatesAndRealtyBot/1.0 (+https://ratesandrealty.com)", "Accept": "application/xml" } });
    if (!res.ok) return new Response(JSON.stringify({ ok: false, error: `treasury fetch ${res.status}` }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
    const xml = await res.text();

    // split into entries, parse each
    const entries = xml.split("<entry>").slice(1);
    const rows: any[] = [];
    for (const e of entries) {
      const dm = e.match(/<d:NEW_DATE[^>]*>([\d\-T:]+)</);
      if (!dm) continue;
      const date = dm[1].slice(0, 10);
      const y10 = num(e, "BC_10YEAR");
      const y30 = num(e, "BC_30YEAR");
      const y2 = num(e, "BC_2YEAR");
      const y5 = num(e, "BC_5YEAR");
      if (y10 == null && y30 == null) continue;
      rows.push({ yield_date: date, y_10yr: y10, y_30yr: y30, y_2yr: y2, y_5yr: y5, fetched_at: new Date().toISOString() });
    }
    if (!rows.length) return new Response(JSON.stringify({ ok: false, error: "no rows parsed" }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });

    // keep only the most recent ~90 to limit write size, upsert
    const recent = rows.slice(-90);
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const { error } = await sb.from("treasury_yields").upsert(recent, { onConflict: "yield_date" });
    if (error) throw error;

    const latest = recent[recent.length - 1];
    return new Response(JSON.stringify({ ok: true, upserted: recent.length, latest }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
