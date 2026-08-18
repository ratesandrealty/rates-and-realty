import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

/* The shared task-runner secret. NOT a literal any more.
 *
 * It used to be `const CRON_KEY = "rnr-cron-…"` written into the source of this
 * function and two others, identical in all three. That put it in the repo, in
 * every commit that ever touched these files, and in any clone — a secret you
 * cannot rotate without editing and redeploying three functions, and one that
 * anyone with repo access has had all along.
 *
 * Now: minted server-side by gen_random_bytes straight into the vault as
 * `cron_task_key` and never printed, then confirmed by verify_cron_secret(),
 * which answers only true or false. Same shape as internal_db_caller_secret.
 * The value exists in exactly one place.
 *
 * The old literal is dead and must not be accepted as a fallback — it is public
 * forever, so honouring it would make the rotation cosmetic. */
async function cronKeyOk(req: Request): Promise<boolean> {
  const supplied = (req.headers.get("x-cron-key") || "").trim();
  if (!supplied) return false;
  try {
    const { data, error } = await sb.rpc("verify_cron_secret", {
      p_name: "cron_task_key",
      p_secret: supplied,
    });
    return !error && data === true;
  } catch (_e) {
    /* A lookup failure is a NO. Returning true when the check cannot run is how
     * a guard evaporates exactly when something is already wrong. */
    return false;
  }
}
const TODO_LIST = "901708416155";

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const WHEN: Record<string, string> = { "0": "TODAY", "1": "tomorrow", "3": "in 3 days" };

Deno.serve(async (req: Request) => {
  if (!(await cronKeyOk(req))) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  try {
    const url = new URL(req.url);
    const dry = url.searchParams.get("dry") === "1";
    const today = new Date().toISOString().slice(0, 10);
    const d1 = addDays(today, 1);
    const d3 = addDays(today, 3);
    const targets: Record<string, number> = { [today]: 0, [d1]: 1, [d3]: 3 };

    /* completed = false is a FILTER, not a nicety. Without it a date somebody
       had already marked met still produced a ClickUp task at 3 days, 1 day and
       day-of. loan_date_nudge_scan has always excluded them
       (coalesce(kd.completed,false) = false); this engine never did, so the two
       reminder paths disagreed about the same row.
       The column is NOT NULL default false, so eq() needs no coalesce. */
    const { data: rows, error } = await sb.from("loan_key_dates")
      .select("id,contact_id,date_key,label,date_value,reminders_sent, contacts(first_name,last_name)")
      .eq("completed", false)
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
