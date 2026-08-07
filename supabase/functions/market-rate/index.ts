import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const UA = "Mozilla/5.0 (compatible; RatesAndRealtyBot/1.0; +https://ratesandrealty.com)";

/* THE GUARD.
 *
 * The gateway lets anyone through — the anon key that satisfies it is printed in
 * every page — and this function scrapes a third party on every call and writes
 * market_rates with the service role. Open, it costs someone else's bandwidth
 * and lets a stranger overwrite the rate the site publishes.
 *
 * pg_cron job 24 (refresh-market-rate, weekdays 22:00) is the ONLY caller. No
 * page invokes it: the `market-rates` matches in dashboard/admin.html are a
 * dashboard SECTION id, and post-close-followups and refi-watch read the
 * market_rates TABLE, not this function. So there is no frontend half to ship
 * first — checked rather than assumed, because "Tier 4, no browser caller" was
 * already wrong for three of five functions once.
 *
 * WHY THE CHECK IS IN THE DATABASE, NOT IN AN ENV VAR HERE
 * The usual shape — same secret in Deno's env, compared in this file — needs the
 * plaintext to travel from the vault into the secrets store, and every hop on
 * that trip (a transcript, a shell history, a CI log) is somewhere it can
 * outlive its usefulness. proactive_followups_secret was rotated once for
 * exactly that. verify_cron_secret() keeps it inside Postgres: pg_cron reads it
 * from the vault to send, this function hands back what it received, and the
 * database answers only yes or no. Nothing to provision here, no second copy to
 * leak, nothing to keep in sync.
 *
 * FAILS CLOSED — a missing vault entry, an empty header and a wrong-but-
 * right-length value are all NO. */
async function secretOk(req: Request): Promise<boolean> {
  const got = req.headers.get("x-cron-secret") ?? "";
  if (!got) return false;
  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data, error } = await sb.rpc("verify_cron_secret", {
      p_name: "market_rate_cron_secret",
      p_secret: got,
    });
    if (error) {
      console.error("[market-rate] secret check failed:", error.message);
      return false;
    }
    return data === true;
  } catch (e) {
    console.error("[market-rate] secret check threw:", String(e));
    return false;
  }
}

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

Deno.serve(async (req: Request) => {
  /* Before req.json() and before the outbound scrape, so an unauthorised call
   * costs nothing and reaches nothing. */
  if (!(await secretOk(req))) {
    return new Response(JSON.stringify({ ok: false, error: "forbidden" }),
      { status: 403, headers: { "Content-Type": "application/json" } });
  }
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
