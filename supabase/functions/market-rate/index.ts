import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const UA = "Mozilla/5.0 (compatible; RatesAndRealtyBot/1.0; +https://ratesandrealty.com)";

function parseRate(html: string, label: string): number | null {
  // Find `label`, then the FIRST NN.NNN% that follows it (the current rate,
  // which precedes the 52-week-range values).
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(esc + "[\\s\\S]{0,400}?(\\d{1,2}\\.\\d{1,3})\\s*%");
  const m = html.match(re);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return (v > 1 && v < 20) ? v : null;
}

Deno.serve(async (_req: Request) => {
  try {
    const res = await fetch("https://www.mortgagenewsdaily.com/mortgage-rates", { headers: { "User-Agent": UA } });
    if (!res.ok) {
      return new Response(JSON.stringify({ ok: false, error: `fetch ${res.status}` }), { status: 502, headers: { "Content-Type": "application/json" } });
    }
    const html = await res.text();

    // 30/15 come from the header ticker ("30YR Fixed Rate6.58%").
    const rate30 = parseRate(html, "30YR Fixed");
    const rate15 = parseRate(html, "15YR Fixed");
    // FHA/VA/Jumbo come from the product table ("30 Yr. FHA" ... "6.14%").
    const fha = parseRate(html, "30 Yr. FHA");
    const va = parseRate(html, "30 Yr. VA");
    const jumbo = parseRate(html, "30 Yr. Jumbo");

    if (rate30 == null && rate15 == null && fha == null) {
      return new Response(JSON.stringify({ ok: false, error: "parse_failed", sample: html.slice(0, 400) }), { status: 502, headers: { "Content-Type": "application/json" } });
    }

    const today = new Date().toISOString().slice(0, 10);
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const { error } = await sb.from("market_rates").upsert({
      rate_date: today,
      rate_30yr: rate30,
      rate_15yr: rate15,
      rate_fha: fha,
      rate_va: va,
      rate_jumbo: jumbo,
      source: "mortgagenewsdaily",
      fetched_at: new Date().toISOString(),
    }, { onConflict: "rate_date" });
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, rate_date: today, rate_30yr: rate30, rate_15yr: rate15, rate_fha: fha, rate_va: va, rate_jumbo: jumbo }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
