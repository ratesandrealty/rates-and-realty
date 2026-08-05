/* sms-inbound-reconcile — closes the 11200 blind spot.
 *
 * WHY THIS EXISTS
 * Twilio delivers inbound SMS by calling our webhook. When that call fails
 * (error 11200, "HTTP retrieval failure") Twilio has the message and we never
 * do — there is no retry, and nothing in our database records that anything
 * arrived. The audit found 20 such failures. None happened to be a STOP, but a
 * missed STOP is exactly the failure this class of bug produces: the message
 * exists at the carrier, the CRM keeps texting, and nothing shows why.
 *
 * So: pull Twilio's own inbound list, compare against what we stored, report the
 * difference. Twilio is the source of truth for what was received.
 *
 * Runs on cron. verify_jwt=false (cron has no user); read-only against Twilio,
 * so the worst a stray caller gets is a report.
 *
 * It does one more thing deliberately: any missed inbound whose body is a STOP
 * is suppressed on the spot. An opt-out dropped by a webhook failure must not
 * stay dropped until a human reads a report.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const sb = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const J = { 'Content-Type': 'application/json' };

const last10 = (p: string) => String(p || '').replace(/\D/g, '').slice(-10);
// Identical to twilio-inbound.classifyIntent and sms-assistant.isOptOut.
const isOptOut = (b: string) =>
  /^(stop|unsubscribe|quit|cancel|end|optout|opt out|stopall|remove)\b/.test(String(b || '').toLowerCase().trim());

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const days = Math.min(Number(body.days) || 7, 90);
  const dryRun = !!body.dry_run;
  const since = new Date(Date.now() - days * 86400000);
  const out: Record<string, unknown> = { ok: true, days, dry_run: dryRun };

  try {
    if (!TWILIO_SID || !TWILIO_TOKEN) {
      return new Response(JSON.stringify({ ok: false, error: 'twilio not configured' }), { headers: J });
    }

    // Twilio's inbound — the source of truth for what actually arrived.
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json?PageSize=1000`;
    const tr = await fetch(url, { headers: { Authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`) } });
    if (!tr.ok) {
      const t = await tr.text();
      console.error('[reconcile] twilio list failed', tr.status, t.slice(0, 200));
      return new Response(JSON.stringify({ ok: false, error: `twilio ${tr.status}` }), { headers: J });
    }
    const msgs = ((await tr.json()).messages || []) as Array<Record<string, string>>;
    const inbound = msgs.filter((m) => m.direction === 'inbound' && new Date(m.date_sent) >= since);

    /* What we stored. Three lanes, three tables: the 866 lands in sms_log via
     * twilio-inbound; the 888 and 714 land in sms_assistant_log; twilio_inbound
     * is the raw webhook log. A message counts as seen if ANY lane holds it, so
     * a correctly-routed assistant message is never reported as missing. */
    const [logRes, asstRes, rawRes] = await Promise.all([
      sb.from('sms_log').select('to_phone,body,created_at').eq('direction', 'inbound').gte('created_at', since.toISOString()).limit(2000),
      sb.from('sms_assistant_log').select('from_phone,inbound_text,created_at').gte('created_at', since.toISOString()).limit(2000),
      sb.from('twilio_inbound').select('body,created_at').gte('created_at', since.toISOString()).limit(2000),
    ]);
    const snip = (t: unknown) => String(t || '').trim().slice(0, 60).toLowerCase();
    const seen = new Set<string>();
    for (const r of logRes.data || []) seen.add(`${last10((r as any).to_phone)}|${snip((r as any).body)}`);
    for (const r of asstRes.data || []) seen.add(`${last10((r as any).from_phone)}|${snip((r as any).inbound_text)}`);
    // twilio_inbound stores no phone column, so that lane matches on body alone.
    const seenBodies = new Set((rawRes.data || []).map((r: any) => snip(r.body)));

    const missing = inbound.filter((m) => {
      if (seen.has(`${last10(m.from)}|${snip(m.body)}`)) return false;
      return !seenBodies.has(snip(m.body));
    });

    const byLine: Record<string, { twilio: number; missing: number }> = {};
    for (const m of inbound) {
      byLine[m.to] = byLine[m.to] || { twilio: 0, missing: 0 };
      byLine[m.to].twilio++;
    }
    for (const m of missing) if (byLine[m.to]) byLine[m.to].missing++;

    out.twilio_inbound = inbound.length;
    out.missing_count = missing.length;
    out.by_line = byLine;
    out.missing = missing.slice(0, 50).map((m) => ({
      from: m.from, to: m.to, date: m.date_sent, body: String(m.body || '').slice(0, 80),
    }));

    // A dropped STOP is repaired immediately, not left for a human to notice.
    const droppedOptOuts: string[] = [];
    for (const m of missing) {
      if (!isOptOut(m.body)) continue;
      droppedOptOuts.push(m.from);
      if (!dryRun) {
        try {
          await sb.rpc('sms_record_optout', { p_phone: m.from, p_source: 'reconcile', p_body: m.body });
        } catch (e) { console.error('[reconcile] suppression write failed', String(e)); }
      }
    }
    out.dropped_optouts_recovered = droppedOptOuts;

    /* Alert only when there is something to act on, at most once a day, reusing
     * the rate-limit table rather than inventing new state. */
    if (!dryRun && missing.length > 0) {
      const { data: gate } = await sb.from('video_chat_limits').select('*').eq('bucket_key', 'reconcile_alert').maybeSingle();
      const now = Date.now();
      const last = gate ? new Date(gate.window_start).getTime() : 0;
      if (!gate || now - last > 86400_000) {
        if (gate) await sb.from('video_chat_limits').update({ hits: 1, window_start: new Date().toISOString() }).eq('bucket_key', 'reconcile_alert');
        else await sb.from('video_chat_limits').insert({ bucket_key: 'reconcile_alert', hits: 1, window_start: new Date().toISOString() });
        try {
          /* app_notify_system, not app_notify_mentions. The old call scanned this
           * body for @handles, found none, and inserted nothing — so this alert
           * has never once reached Rene, including the OPT-OUT case, which is a
           * compliance signal. out.alerted was set to true regardless, so the
           * response reported success for a notification nobody received. */
          const notified = await sb.rpc('app_notify_system', {
            p_source_kind: 'sms',
            p_source_id: null,
            p_body: `⚠️ ${missing.length} inbound text(s) in the last ${days}d reached Twilio but never reached the CRM`
              + (droppedOptOuts.length ? ` — including ${droppedOptOuts.length} OPT-OUT(s), now suppressed.` : '.')
              + ' Usually a webhook failure (Twilio error 11200).',
            p_actor_display: 'SMS reconciliation',
            p_contact_id: null,
          });
          // Report what actually happened, not that we tried.
          out.alerted = !notified.error && Number(notified.data || 0) > 0;
          if (notified.error) console.error('[reconcile] notify failed:', notified.error.message);
        } catch (e) { console.error('[reconcile] notify failed', String(e)); out.alerted = false; }
      } else out.alerted = 'throttled';
    }
    return new Response(JSON.stringify(out, null, 2), { headers: J });
  } catch (e) {
    console.error('[reconcile] fatal', String(e));
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { headers: J });
  }
});
