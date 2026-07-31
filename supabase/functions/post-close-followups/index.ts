import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_KEY = "rnr-cron-9b1f7a3e8c2d460a85f4e6172c0d9b3e";
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const TODO_LIST = "901708416155";

function pickApp(apps: any): any {
  if (!Array.isArray(apps) || !apps.length) return null;
  return apps.slice().sort((a, b) => String(b.closed_rate_date || "").localeCompare(String(a.closed_rate_date || "")))[0];
}
function rateOf(c: any, app: any) { return app?.closed_rate ?? app?.locked_rate ?? c.current_interest_rate ?? null; }
const fmtPct = (v: any) => v == null ? "\u2014" : Number(v).toFixed(2) + "%";
const fmt$ = (v: any) => v == null ? "\u2014" : "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 });

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-cron-key") !== CRON_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  try {
    const url = new URL(req.url);
    const dry = url.searchParams.get("dry") === "1";
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 5);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const { data: latest } = await sb.from("market_rates").select("*").order("rate_date", { ascending: false }).limit(1);
    const mkt = latest?.[0] || {};

    const { data: rows, error } = await sb.from("contacts")
      .select("id,first_name,last_name,email,phone,closed_date,closing_lender,closing_loan_type,loan_type,loan_amount,current_interest_rate, mortgage_applications(closed_rate,locked_rate,current_interest_rate,loan_amount,closed_rate_date)")
      .eq("deal_outcome", "won")
      .not("closed_date", "is", null)
      .lte("closed_date", cutoffStr)
      .is("post_close_task_at", null)
      .limit(100);
    if (error) throw error;

    const tasks = (rows || []).map((c: any) => {
      const app = pickApp(c.mortgage_applications);
      const their = rateOf(c, app);
      const amt = app?.loan_amount ?? c.loan_amount ?? null;
      const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || "Client";
      const desc = [
        `**5-month post-close touchpoint \u2014 ${name}**`,
        ``,
        `Closed: ${c.closed_date}${c.closing_lender ? ` \u00b7 Lender: ${c.closing_lender}` : ""}`,
        `Loan amount: ${fmt$(amt)}${their != null ? ` \u00b7 Their rate: ${fmtPct(their)}` : ""}`,
        `Today's market: 30yr ${fmtPct(mkt.rate_30yr)} \u00b7 FHA ${fmtPct(mkt.rate_fha)} \u00b7 15yr ${fmtPct(mkt.rate_15yr)}`,
        ``,
        `**Do:**`,
        `- Call/text to check in \u2014 how does the home & payment feel?`,
        `- Review whether current rates make a refi worth a look`,
        `- Ask for referrals and a Google review`,
        ``,
        `Contact: ${c.phone || "\u2014"}${c.email ? ` \u00b7 ${c.email}` : ""}`,
      ].join("\n");
      return { contact_id: c.id, name: `5-mo check-in: ${name}`, content: desc, list_id: TODO_LIST };
    });

    if (!dry && tasks.length) {
      const ids = tasks.map((t: any) => t.contact_id);
      await sb.from("contacts").update({ post_close_task_at: new Date().toISOString() }).in("id", ids);
    }
    return new Response(JSON.stringify({ ok: true, count: tasks.length, dry, tasks }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
