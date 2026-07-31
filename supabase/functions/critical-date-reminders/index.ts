import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_KEY = "rnr-cron-9b1f7a3e8c2d460a85f4e6172c0d9b3e";
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const TODO_LIST = "901708416155";

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const WHEN: Record<string, string> = { "0": "TODAY", "1": "tomorrow", "3": "in 3 days" };

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-cron-key") !== CRON_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  try {
    const url = new URL(req.url);
    const dry = url.searchParams.get("dry") === "1";
    const today = new Date().toISOString().slice(0, 10);
    const d1 = addDays(today, 1);
    const d3 = addDays(today, 3);
    const targets: Record<string, number> = { [today]: 0, [d1]: 1, [d3]: 3 };

    const { data: rows, error } = await sb.from("loan_key_dates")
      .select("id,contact_id,date_key,label,date_value,reminders_sent, contacts(first_name,last_name)")
      .in("date_value", [today, d1, d3]);
    if (error) throw error;

    const tasks: any[] = [];
    const updates: { id: string; reminders_sent: any }[] = [];

    for (const r of (rows || [])) {
      const offset = targets[r.date_value as string];
      if (offset === undefined) continue;
      const sent = (r.reminders_sent as any) || {};
      if (sent[String(offset)] === r.date_value) continue;

      const c: any = r.contacts || {};
      const borrower = [c.first_name, c.last_name].filter(Boolean).join(" ") || "Client";
      const label = r.label || r.date_key || "Critical date";
      const when = WHEN[String(offset)];
      const name = `\u23f0 ${label} ${when} \u2014 ${borrower}`;
      const content = [
        `**${label}** for **${borrower}** is due **${r.date_value}** (${when}).`,
        ``,
        `Critical-date reminder pulled from the loan file \u2014 make sure this milestone is on track.`,
      ].join("\n");
      const due_ts = new Date(r.date_value + "T17:00:00Z").getTime();

      tasks.push({ key_date_id: r.id, contact_id: r.contact_id, name, content, list_id: TODO_LIST, due_date: r.date_value, due_ts });
      updates.push({ id: r.id, reminders_sent: { ...sent, [String(offset)]: r.date_value } });
    }

    if (!dry && updates.length) {
      for (const u of updates) {
        await sb.from("loan_key_dates").update({ reminders_sent: u.reminders_sent }).eq("id", u.id);
      }
    }
    return new Response(JSON.stringify({ ok: true, count: tasks.length, dry, tasks }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
