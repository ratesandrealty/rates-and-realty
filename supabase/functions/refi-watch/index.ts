import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const CRON_KEY = "rnr-cron-9b1f7a3e8c2d460a85f4e6172c0d9b3e";
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const TODO_LIST = "901708416155";
const THRESHOLD = 0.5;

function pickApp(apps: any): any {
  if (!Array.isArray(apps) || !apps.length) return null;
  return apps.slice().sort((a, b) => String(b.closed_rate_date || "").localeCompare(String(a.closed_rate_date || "")))[0];
}
function rateOf(c: any, app: any) { return app?.closed_rate ?? app?.locked_rate ?? c.current_interest_rate ?? null; }
function monthlyPI(principal: number | null, annualPct: number, years = 30): number | null {
  if (!principal) return null;
  const r = annualPct / 100 / 12; const n = years * 12;
  if (!r) return null;
  return principal * r / (1 - Math.pow(1 + r, -n));
}
function marketFor(loanType: string, mkt: any): number | null {
  const t = (loanType || "").toLowerCase();
  if (t.includes("fha")) return mkt.rate_fha ?? mkt.rate_30yr;
  if (t.includes("va")) return mkt.rate_va ?? mkt.rate_30yr;
  if (t.includes("jumbo")) return mkt.rate_jumbo ?? mkt.rate_30yr;
  return mkt.rate_30yr;
}
const fmtPct = (v: any) => v == null ? "\u2014" : Number(v).toFixed(2) + "%";
const fmt$ = (v: any) => v == null ? "\u2014" : "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 });

async function aiNote(name: string, their: string, market: string, amt: number | null, monthlySave: number | null): Promise<string | null> {
  try {
    const prompt = `A past mortgage client, ${name}, has a loan at ${their}%. Today's comparable market rate is ${market}%. Loan amount ~$${amt || "unknown"}. Estimated monthly P&I savings if they refinanced: ~$${monthlySave ? Math.round(monthlySave) : "unknown"}. In 2-3 sentences, give the loan officer a quick, practical take on whether it's worth reaching out about a refinance now. Mention the rough break-even on closing costs and that this is not a guaranteed quote. Be concise and actionable.`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d.content?.[0]?.text || null;
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-cron-key") !== CRON_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  try {
    const url = new URL(req.url);
    const dry = url.searchParams.get("dry") === "1";

    const { data: latest } = await sb.from("market_rates").select("*").order("rate_date", { ascending: false }).limit(1);
    const mkt = latest?.[0];
    if (!mkt) return new Response(JSON.stringify({ ok: false, error: "no_market_rate" }), { status: 503, headers: { "Content-Type": "application/json" } });

    const { data: rows, error } = await sb.from("contacts")
      .select("id,first_name,last_name,email,phone,closed_date,closing_lender,closing_loan_type,loan_type,loan_amount,current_interest_rate,refi_alert_last_at,refi_alert_last_rate, mortgage_applications(closed_rate,locked_rate,current_interest_rate,loan_amount,closed_rate_date)")
      .eq("deal_outcome", "won").not("closed_date", "is", null)
      // READ FILTER. DEFENSIVE, not a fix: no ghost qualifies today because none
      // is deal_outcome=won. A merged past client would, and this sends.
      .is("merged_into_contact_id", null)
      .limit(500);
    if (error) throw error;

    const now = Date.now();
    const tasks: any[] = [];
    const flag: any[] = [];
    for (const c of rows || []) {
      const app = pickApp(c.mortgage_applications);
      const their = rateOf(c, app);
      if (their == null) continue;
      const loanType = c.closing_loan_type || c.loan_type || "";
      const market = marketFor(loanType, mkt);
      if (market == null) continue;
      const savingsPP = Number(their) - Number(market);
      if (savingsPP < THRESHOLD) continue;
      if (c.refi_alert_last_at) {
        const days = (now - new Date(c.refi_alert_last_at).getTime()) / 86400000;
        const droppedFurther = c.refi_alert_last_rate != null && (Number(c.refi_alert_last_rate) - Number(market)) >= 0.25;
        if (days < 90 && !droppedFurther) continue;
      }
      const amt = app?.loan_amount ?? c.loan_amount ?? null;
      const piNow = monthlyPI(amt, Number(their));
      const piNew = monthlyPI(amt, Number(market));
      const monthlySave = (piNow != null && piNew != null) ? (piNow - piNew) : null;
      const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || "Client";
      const note = await aiNote(name, Number(their).toFixed(3), Number(market).toFixed(3), amt, monthlySave);
      const desc = [
        `**Refi opportunity \u2014 ${name}**`,
        ``,
        `Their rate: **${fmtPct(their)}** (${loanType || "conventional"})  \u2192  Market: **${fmtPct(market)}**  =  **${savingsPP.toFixed(2)}% lower**`,
        `Loan amount: ${fmt$(amt)}${monthlySave != null ? ` \u00b7 Est. monthly P&I savings: ~${fmt$(monthlySave)}` : ""}`,
        `Closed: ${c.closed_date}${c.closing_lender ? ` \u00b7 ${c.closing_lender}` : ""}`,
        ``,
        note ? `**AI take:** ${note}` : ``,
        ``,
        `Contact: ${c.phone || "\u2014"}${c.email ? ` \u00b7 ${c.email}` : ""}`,
        ``,
        `_Market: MND ${mkt.rate_date}. Not a guaranteed quote._`,
      ].join("\n");
      tasks.push({ contact_id: c.id, name: `Refi opp: ${name} (${savingsPP.toFixed(2)}% lower)`, content: desc, list_id: TODO_LIST });
      flag.push({ id: c.id, market });
    }

    if (!dry) {
      for (const f of flag) {
        await sb.from("contacts").update({ refi_alert_last_at: new Date().toISOString(), refi_alert_last_rate: f.market }).eq("id", f.id);
      }
    }
    return new Response(JSON.stringify({ ok: true, count: tasks.length, dry, market: { date: mkt.rate_date, rate_30yr: mkt.rate_30yr, rate_fha: mkt.rate_fha, rate_va: mkt.rate_va }, tasks }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
