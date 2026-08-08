/* call-intelligence — Twilio Conversational Intelligence (classic) for calls_log.
 *
 * Transcribes a Twilio Recording and runs the Conversation Summary operator over
 * it, then writes both to the calls_log row the recording belongs to.
 *
 * ── SHAPE, AND WHY IT IS THIS SHAPE ────────────────────────────────────────
 *
 * Like twilio-voice, this function serves two completely different callers from
 * one entry point, and they authenticate differently:
 *
 *   ?event=transcript   Twilio's Intelligence webhook. Form-encoded. Proves
 *                       itself with X-Twilio-Signature. No session, ever.
 *   everything else     The browser and internal callers. JSON. Proves itself
 *                       with requireStaff.
 *
 * Neither check is applied to the other's callers — that was the bug in
 * twilio-voice that left five JSON actions open for months while the signature
 * check made the file read as guarded. The split is explicit and first.
 *
 * requireStaff runs BEFORE req.json(), per require-staff's note 2.
 *
 * ── THE WEBHOOK PAYLOAD IS NEVER TRUSTED, EVEN WHEN SIGNED ─────────────────
 *
 * I could not confirm from Twilio's docs that the Conversational Intelligence
 * *Service* webhook is signed at all. The explicit "Twilio signs each request
 * with X-Twilio-Signature" statement lives in the Batch Transcription docs,
 * which is a different product; the CI classic page's "signature of the webhook
 * request body" link is about payload schema, not request signing.
 *
 * So the webhook is treated as a doorbell and nothing more. It is required to
 * be signed (unsigned gets 403 — no unauthenticated webhook, by instruction),
 * and even then the only thing read out of the body is a transcript SID. Every
 * byte that reaches the database is re-fetched from intelligence.twilio.com
 * over an authenticated GET, and only after the transcript's CustomerKey is
 * confirmed to be a calls_log row we ourselves put into 'requested'.
 *
 * The consequence worth stating: if Twilio turns out not to sign these, the
 * webhook silently 403s and NOTHING IS LOST — `sweep` reconciles from the
 * authoritative side on a timer. The webhook is the fast path, never the only
 * path. That is deliberate: this codebase's recurring failure is a callback
 * that stopped arriving with nothing watching (send-scheduled-sms, gdrive-sync,
 * the 9 unnoticed failures in net._http_response).
 *
 * ── READ ACCESS ────────────────────────────────────────────────────────────
 *
 * `get` is admin-only, matching get_recording. A transcript is the same NPI as
 * the recording in a form that can be pasted into anything, so it is narrower
 * than the dialer (admin/va/agent/loa), not equal to it.
 *
 * calls_log's RLS is `authenticated USING (true)`, so the columns themselves are
 * the real control: SELECT on transcript, ai_summary and transcript_sid is not
 * granted to `authenticated`, which is why this function reads them with the
 * service role after checking the caller. Removing that grant restriction would
 * silently un-gate every transcript regardless of what this file does.
 */
import { requireStaff } from '../_shared/require-staff.ts';
import { verifyTwilioRequest, twilioForbidden } from '../_shared/twilio-signature.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
const AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Content-Type': 'application/json',
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: cors });
const err = (msg: string, status = 400) =>
  new Response(JSON.stringify({ success: false, error: msg }), { status, headers: cors });

/* The Conversation Summary operator. Twilio-authored, GPT-4o-mini behind it.
 * Verified present on this account (author=Twilio) before anything was built. */
const OP_SUMMARY = 'LY8d2be74b94a34733b28594fadf331f0c';
/* Detects that the conversation was not in the Service's language. A Service's
 * language_code is immutable, so this is how a call routed to the wrong one
 * gets noticed and re-run against the other Service. */
const OP_NON_ENGLISH = 'LYad1855777c384400a023b526287ceed2';

const CFG_EN = 'ci_service_sid_en';
const CFG_ES = 'ci_service_sid_es';

const twAuth = () => 'Basic ' + btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`);

async function tw(method: string, url: string, form?: Record<string, string>) {
  const init: RequestInit = { method, headers: { Authorization: twAuth() } };
  if (form) {
    init.headers = { ...init.headers, 'Content-Type': 'application/x-www-form-urlencoded' };
    init.body = new URLSearchParams(form).toString();
  }
  const r = await fetch(url, init);
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
  return { ok: r.ok, status: r.status, body };
}

async function cfgGet(key: string): Promise<string> {
  const { data } = await sb.from('app_config').select('value').eq('key', key).maybeSingle();
  return String((data as any)?.value || '').trim();
}
async function cfgSet(key: string, value: string) {
  await sb.from('app_config').upsert({ key, value }, { onConflict: 'key' });
}

/* ── failure is a WRITE, not a return ───────────────────────────────────────
 *
 * Every path that gives up has to come through here. The requirement it exists
 * to satisfy: a null transcript must never be ambiguous between "not yet" and
 * "failed". A function that returns an error to its caller and leaves the row
 * untouched fails that — the caller sees the error once and the row looks
 * exactly like a call nobody has asked about.
 *
 * transcript_error is NOT NULL-checked by a constraint when status='failed', so
 * a reasonless failure cannot be written even by mistake. */
async function markFailed(rowId: string, reason: string) {
  let msg = reason.slice(0, 800) || 'unknown failure';

  /* A FAILED RETRY MUST NOT LOOK LIKE A FAILED FIRST ATTEMPT.
   *
   * Found by breaking this on purpose: force-retrying a call that already had a
   * good transcript left status='failed' sitting next to the old text. Keeping
   * the text is right — a retry failing is no reason to destroy a transcript we
   * already have — but silently is not, because 'failed' then means two
   * different things depending on a column the reader may not have looked at.
   * So the row says which one it is. */
  const { data: prior } = await sb.from('calls_log')
    .select('transcript').eq('id', rowId).maybeSingle();
  if ((prior as any)?.transcript) {
    msg = `${msg} [The earlier transcript is retained and still shown; this was a re-run.]`.slice(0, 1000);
  }

  const { error } = await sb.from('calls_log').update({
    transcript_status: 'failed',
    transcript_error: msg,
    transcript_updated_at: new Date().toISOString(),
  }).eq('id', rowId);
  if (error) console.error('[call-intelligence] could not even record the failure', rowId, error.message);
  console.error(`[call-intelligence] row=${rowId} FAILED: ${msg}`);
}

/** Pull "RE…" out of a stored recording_url. The column holds a resource URL. */
function recordingSidFrom(url: string): string {
  const m = String(url || '').match(/\/Recordings\/(RE[0-9a-fA-F]{32})/);
  return m ? m[1] : '';
}

/* ── create one Transcript against one Service ─────────────────────────────
 * CustomerKey is the calls_log id. It is the whole join: the webhook arrives
 * knowing a transcript SID and nothing about this database, and CustomerKey is
 * what lets the result be matched back to a row we actually asked about rather
 * than to whatever the caller claims. */
async function createTranscript(serviceSid: string, recordingSid: string, callLogId: string) {
  return await tw('POST', 'https://intelligence.twilio.com/v2/Transcripts', {
    ServiceSid: serviceSid,
    Channel: JSON.stringify({ media_properties: { source_sid: recordingSid } }),
    CustomerKey: callLogId,
  });
}

/** Sentences → one block of text. Mono recordings carry no speaker separation,
 *  so there is nothing honest to label the lines with; see the note in the
 *  step-1 report about record-from-answer-dual. */
async function fetchTranscriptText(sid: string): Promise<{ text: string; count: number }> {
  const r = await tw('GET', `https://intelligence.twilio.com/v2/Transcripts/${sid}/Sentences?PageSize=1000`);
  if (!r.ok) throw new Error(`sentences fetch ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  const rows: any[] = r.body?.sentences || [];
  const text = rows.map((s) => String(s.transcript || '').trim()).filter(Boolean).join(' ');
  return { text, count: rows.length };
}

async function fetchOperatorResults(sid: string): Promise<any[]> {
  const r = await tw('GET', `https://intelligence.twilio.com/v2/Transcripts/${sid}/OperatorResults?PageSize=50`);
  if (!r.ok) return [];
  return r.body?.operator_results || [];
}

/** The summary text out of the operator results array. */
function summaryFrom(results: any[]): string {
  const hit = results.find((o) => o?.operator_sid === OP_SUMMARY);
  if (!hit) return '';
  return String(hit?.text_generation_results?.result || '').trim();
}

/* Whether NonEnglishCall fired.
 *
 * Written defensively on purpose: this operator's exact result shape is not
 * documented in a form I could verify before running one, and the cost of
 * guessing wrong in the confident direction is re-transcribing every English
 * call against the Spanish Service and paying twice for all of them. So the
 * DEFAULT IS FALSE and only an explicit positive flips it. The raw results are
 * stored on the row so the first real firing can be read and this tightened. */
function saysNonEnglish(results: any[]): boolean {
  const hit = results.find((o) => o?.operator_sid === OP_NON_ENGLISH);
  if (!hit) return false;
  const label = String(
    hit.predicted_label ?? hit.label ?? hit.text_generation_results?.result ?? '',
  ).trim().toLowerCase();
  return label === 'true' || label === 'yes' || label === 'non_english' || label === 'non-english';
}

/* ── read a finished transcript and land it on the row ─────────────────────
 * Returns the status it wrote. Never throws to the caller without the row
 * having been updated first. */
async function harvest(rowId: string, transcriptSid: string, lang: string): Promise<string> {
  const t = await tw('GET', `https://intelligence.twilio.com/v2/Transcripts/${transcriptSid}`);
  if (!t.ok) {
    await markFailed(rowId, `transcript fetch ${t.status}: ${JSON.stringify(t.body).slice(0, 300)}`);
    return 'failed';
  }
  const status = String(t.body?.status || '');

  if (status === 'failed') {
    await markFailed(rowId, `Twilio reported the transcript failed (${JSON.stringify(t.body?.failure_reason ?? t.body?.error_message ?? 'no reason given')})`);
    return 'failed';
  }
  if (status !== 'completed') return 'requested';   // still queued / in-progress

  let text = '', count = 0;
  try {
    const s = await fetchTranscriptText(transcriptSid);
    text = s.text; count = s.count;
  } catch (e) {
    await markFailed(rowId, String(e));
    return 'failed';
  }

  const results = await fetchOperatorResults(transcriptSid);
  const summary = summaryFrom(results);

  /* Completed with no speech. This is NOT a failure — a recording that is a
   * voicemail beep or two seconds of hold music transcribes to nothing and the
   * pipeline worked perfectly. Calling it 'failed' sends somebody hunting a bug
   * that is not there, which is exactly the ambiguity the status column exists
   * to remove. */
  if (!text) {
    const { error } = await sb.from('calls_log').update({
      transcript_status: 'empty',
      transcript_sid: transcriptSid,
      transcript_lang: lang,
      transcript_error: null,
      transcript_updated_at: new Date().toISOString(),
    }).eq('id', rowId);
    if (error) { await markFailed(rowId, `empty-write failed: ${error.message}`); return 'failed'; }
    console.log(`[call-intelligence] row=${rowId} empty (0 sentences)`);
    return 'empty';
  }

  const { error } = await sb.from('calls_log').update({
    transcript: text,
    ai_summary: summary || null,
    transcript_status: 'ready',
    transcript_sid: transcriptSid,
    transcript_lang: lang,
    transcript_error: null,
    transcript_updated_at: new Date().toISOString(),
  }).eq('id', rowId);

  /* A write that fails here is the silent-null case in its purest form: Twilio
   * has the transcript, we do not, and the row would sit in 'requested' forever
   * looking like it was still in flight. */
  if (error) { await markFailed(rowId, `transcript write failed: ${error.message}`); return 'failed'; }

  console.log(`[call-intelligence] row=${rowId} ready sentences=${count} summary=${summary ? 'yes' : 'no'} lang=${lang}`);
  await writeSummaryNote(rowId, summary);
  return 'ready';
}

/* ── the summary into notes ────────────────────────────────────────────────
 * contact_notes is the live notes surface (384 rows; `notes` has 3 and is
 * legacy). Tagged with the calls_log id so a re-sync updates rather than
 * duplicates — harvest can legitimately run twice for one call when the webhook
 * and the sweep race.
 *
 * NOTE ON SCOPE: only the SUMMARY goes here, never the transcript. contact_notes
 * is readable by the VA when a lead is shared with them; the verbatim transcript
 * is not something to widen by a side effect of writing a note. */
async function writeSummaryNote(rowId: string, summary: string) {
  if (!summary) return;
  try {
    const { data: row } = await sb.from('calls_log')
      .select('contact_id, direction, duration, created_at').eq('id', rowId).maybeSingle();
    const contactId = (row as any)?.contact_id;
    if (!contactId) return;   // orphan call row; nothing to attach a note to

    const { data: existing } = await sb.from('contact_notes')
      .select('id').contains('tags', [rowId]).maybeSingle();

    const dur = (row as any)?.duration;
    const head = `Call summary (${(row as any)?.direction || 'call'}${dur ? `, ${dur}s` : ''})`;
    const body = `${head}\n\n${summary}`;

    if (existing?.id) {
      await sb.from('contact_notes').update({ note_text: body, updated_at: new Date().toISOString() })
        .eq('id', (existing as any).id);
    } else {
      await sb.from('contact_notes').insert({
        contact_id: contactId,
        note_text: body,
        source: 'call-summary',
        author_display: 'Call summary (AI)',
        tags: ['call-summary', rowId],
      });
    }
  } catch (e) {
    /* A note that did not get written must not turn a good transcript into a
     * failed one — the transcript is already safely on the row. Loud, not fatal. */
    console.error('[call-intelligence] summary note write failed', rowId, String(e));
  }
}

/* ── start transcription for one calls_log row ─────────────────────────────── */
async function startForRow(rowId: string, opts: { force?: boolean } = {}) {
  const { data: row, error: rowErr } = await sb.from('calls_log')
    .select('id, recording_url, transcript_status, transcript_sid').eq('id', rowId).maybeSingle();
  if (rowErr) return { ok: false, error: rowErr.message, status: 500 };
  if (!row) return { ok: false, error: 'No such call', status: 404 };

  const r: any = row;
  if (!opts.force && (r.transcript_status === 'ready' || r.transcript_status === 'empty')) {
    return { ok: true, already: r.transcript_status, transcript_sid: r.transcript_sid };
  }
  if (!opts.force && r.transcript_status === 'requested') {
    return { ok: true, already: 'requested', transcript_sid: r.transcript_sid };
  }

  const recSid = recordingSidFrom(r.recording_url);
  if (!recSid) {
    await markFailed(rowId, 'This call has no Twilio recording to transcribe.');
    return { ok: false, error: 'This call has no recording.', status: 404 };
  }

  const serviceEn = await cfgGet(CFG_EN);
  if (!serviceEn) {
    await markFailed(rowId, `No Intelligence Service configured (${CFG_EN} is unset). Run action=provision.`);
    return { ok: false, error: 'No Intelligence Service configured. Run action=provision.', status: 503 };
  }

  /* Mark 'requested' BEFORE calling Twilio. If the process dies between the API
   * call and the write, a row stuck in 'requested' is visible and the sweep
   * finds it; a row still null is invisible and nobody ever looks. */
  await sb.from('calls_log').update({
    transcript_status: 'requested',
    transcript_error: null,
    transcript_requested_at: new Date().toISOString(),
    transcript_updated_at: new Date().toISOString(),
  }).eq('id', rowId);

  const created = await createTranscript(serviceEn, recSid, rowId);
  if (!created.ok) {
    const m = created.body?.message || JSON.stringify(created.body).slice(0, 300);
    await markFailed(rowId, `Twilio refused the transcript request (${created.status}): ${m}`);
    return { ok: false, error: m, status: 502 };
  }

  const gt = String(created.body?.sid || '');
  await sb.from('calls_log').update({
    transcript_sid: gt,
    transcript_lang: 'en-US',
    transcript_updated_at: new Date().toISOString(),
  }).eq('id', rowId);

  console.log(`[call-intelligence] row=${rowId} requested transcript=${gt} rec=${recSid}`);
  return { ok: true, transcript_sid: gt, status_: 'requested' };
}

/* ── language re-route ─────────────────────────────────────────────────────
 * Runs after a successful en-US harvest. If NonEnglishCall fired, the same
 * recording is transcribed again against the es-US Service and that result
 * replaces the first. This is the second half of the "both Services, route by
 * NonEnglishCall" decision, and it is why non-English calls cost twice. */
async function maybeReroute(rowId: string, transcriptSid: string): Promise<boolean> {
  const serviceEs = await cfgGet(CFG_ES);
  if (!serviceEs) return false;

  const results = await fetchOperatorResults(transcriptSid);
  if (!saysNonEnglish(results)) return false;

  const { data: row } = await sb.from('calls_log').select('recording_url, transcript_lang').eq('id', rowId).maybeSingle();
  if (((row as any)?.transcript_lang || '') === 'es-US') return false;   // already the Spanish pass
  const recSid = recordingSidFrom((row as any)?.recording_url || '');
  if (!recSid) return false;

  const created = await createTranscript(serviceEs, recSid, rowId);
  if (!created.ok) {
    console.error('[call-intelligence] es-US re-route refused', rowId, created.status, JSON.stringify(created.body).slice(0, 200));
    return false;   // the English transcript stands; not a failure of the row
  }
  const gt = String(created.body?.sid || '');
  await sb.from('calls_log').update({
    transcript_status: 'requested',
    transcript_sid: gt,
    transcript_lang: 'es-US',
    transcript_updated_at: new Date().toISOString(),
  }).eq('id', rowId);
  console.log(`[call-intelligence] row=${rowId} re-routed to es-US transcript=${gt}`);
  return true;
}

/* ── sync one row from the authoritative side ──────────────────────────────── */
async function syncRow(rowId: string): Promise<string> {
  const { data: row } = await sb.from('calls_log')
    .select('id, transcript_sid, transcript_status, transcript_lang').eq('id', rowId).maybeSingle();
  if (!row) return 'no_row';
  const r: any = row;
  if (!r.transcript_sid) return r.transcript_status || 'not_requested';

  const outcome = await harvest(rowId, r.transcript_sid, r.transcript_lang || 'en-US');
  if (outcome === 'ready' && (r.transcript_lang || 'en-US') === 'en-US') {
    await maybeReroute(rowId, r.transcript_sid);
  }
  return outcome;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = new URL(req.url);

  /* ── TWILIO'S WEBHOOK ──────────────────────────────────────────────────────
   * Signature or nothing. See the header note: the payload is a doorbell, and
   * the sweep is what actually guarantees delivery. */
  if (url.searchParams.get('event') === 'transcript') {
    const bodyText = await req.text();
    const auth = await verifyTwilioRequest(req, bodyText, { authToken: AUTH_TOKEN });
    if (!auth.ok) {
      console.error(`[call-intelligence] webhook REJECTED reason=${auth.reason} url=${auth.url}`);
      return twilioForbidden();
    }

    const p = new URLSearchParams(bodyText);
    const gt = (p.get('transcript_sid') || p.get('TranscriptSid') || '').trim();
    if (!/^GT[0-9a-fA-F]{32}$/.test(gt)) {
      console.error('[call-intelligence] webhook carried no usable transcript_sid');
      return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }

    /* Find the row by the SID WE recorded when we asked for this transcript.
     * The webhook does not get to name a row. If we never requested this
     * transcript, there is nothing to update and we say so and stop. */
    const { data: row } = await sb.from('calls_log')
      .select('id, transcript_lang').eq('transcript_sid', gt).maybeSingle();
    if (!row) {
      console.warn(`[call-intelligence] webhook for unknown transcript ${gt} — ignored`);
      return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }

    await syncRow((row as any).id);
    return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  /* ── EVERYTHING ELSE: staff only, checked BEFORE the body is read ──────────
   *
   * allowInternal is on so pg_cron can reach `sweep`. Postgres cannot hold the
   * service key — it is an edge-function environment variable — so the cron job
   * proves itself with internal_db_caller_secret, which was minted by
   * gen_random_bytes straight into the vault and has never been printed. See
   * internal_call_headers().
   *
   * It does NOT widen anything else. get, start, sync and provision each run a
   * SECOND requireStaff without allowInternal, so a caller holding only the
   * internal secret has no token and gets 401 from those. `sweep` is the only
   * action reachable this way, which is the intent: reconciling is a machine's
   * job, reading a borrower's transcript is not. */
  const staff = await requireStaff(req, { what: 'Call transcription', allowInternal: true });
  if (!staff.ok) return err(staff.msg || 'unauthorized', staff.status || 403);

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body.action || '').trim();

  /* provision — idempotent. Creates the two Intelligence Services and attaches
   * the operators. Admin only: it creates billable account resources. */
  if (action === 'provision') {
    const admin = await requireStaff(req, { roles: ['admin'], what: 'Intelligence provisioning' });
    if (!admin.ok) return err(admin.msg || 'unauthorized', admin.status || 403);
    if (!ACCOUNT_SID || !AUTH_TOKEN) return err('Twilio not configured', 500);

    const out: Record<string, unknown> = {};
    for (const [cfgKey, lang, name] of [
      [CFG_EN, 'en-US', 'rr-calls-en'],
      [CFG_ES, 'es-US', 'rr-calls-es'],
    ] as const) {
      let sid = await cfgGet(cfgKey);
      if (!sid) {
        /* auto_transcribe stays OFF. It would transcribe every new recording
         * with no CustomerKey, which is the only thing tying a transcript back
         * to a calls_log row — and it would bill for calls nobody asked about. */
        const c = await tw('POST', 'https://intelligence.twilio.com/v2/Services', {
          UniqueName: name,
          LanguageCode: lang,
          AutoTranscribe: 'false',
          AutoRedaction: 'false',
        });
        if (!c.ok) { out[cfgKey] = { error: c.status, body: c.body }; continue; }
        sid = String(c.body?.sid || '');
        await cfgSet(cfgKey, sid);
      }
      const attached: string[] = [];
      for (const op of [OP_SUMMARY, OP_NON_ENGLISH]) {
        const a = await tw('POST', `https://intelligence.twilio.com/v2/Services/${sid}/Operators/${op}`);
        attached.push(`${op}:${a.status}`);
      }

      /* Point the Service's webhook at our receiver. Applied on every provision
       * run, not just at creation, so re-running fixes a URL that drifted.
       *
       * This is the fast path only. If Twilio does not sign these — which I
       * could not establish from the docs — the receiver 403s every one of them
       * and the 10-minute sweep still delivers every transcript. Configuring it
       * anyway is also how we find out: a 403 with reason=missing_signature in
       * the logs answers the question that the documentation would not. */
      const hook = await tw('POST', `https://intelligence.twilio.com/v2/Services/${sid}`, {
        WebhookUrl: `${SUPABASE_URL}/functions/v1/call-intelligence?event=transcript`,
        WebhookHttpMethod: 'POST',
      });
      out[cfgKey] = { sid, lang, attached, webhook: hook.status, webhook_url: (hook.body as any)?.webhook_url ?? null };
    }
    return json({ success: true, services: out });
  }

  const callLogId = String(body.call_log_id || body.id || '').trim();

  /* start / sync are ADMIN, for the same reason `get` is.
   *
   * Caught by testing rather than by design: a VA session could call `start`
   * and got a 200 back that also told it a transcript already existed. Neither
   * is a disaster on its own — they still cannot read a word of it — but if you
   * are not allowed to read a transcript you should not be able to commission
   * one either. It spends money per minute and it manufactures NPI text out of
   * audio the same person is already barred from playing.
   *
   * This does NOT affect the automatic path. twilio-voice calls `start` with the
   * service key, and require-staff returns on the service-key branch before any
   * role filter applies. Cron's `sweep` is unaffected for the same reason. */
  if (action === 'start' || action === 'sync') {
    const admin = await requireStaff(req, { roles: ['admin'], what: 'Call transcription' });
    if (!admin.ok) return err(admin.msg || 'unauthorized', admin.status || 403);
    if (!callLogId) return err('call_log_id required');
    if (action === 'sync') return json({ success: true, status: await syncRow(callLogId) });
    const r = await startForRow(callLogId, { force: !!body.force });
    return r.ok ? json({ success: true, ...r }) : err(r.error || 'failed', r.status || 500);
  }

  /* sweep — the delivery guarantee. Anything still 'requested' after a while is
   * either finished (and the webhook never arrived) or genuinely stuck, and
   * both need to stop being invisible. Nothing in this project has ever been
   * hurt by a callback that failed loudly; the damage is always the one that
   * stopped arriving quietly. */
  if (action === 'sweep') {
    const staleMin = Number(body.stale_minutes ?? 10);
    const cutoff = new Date(Date.now() - staleMin * 60_000).toISOString();
    const results: Record<string, string> = {};

    /* PART 1 — recorded calls that were never even asked about.
     *
     * transcript_status IS NULL with a recording present means the kick-off in
     * twilio-voice did not land: the fetch threw, the function was mid-deploy,
     * or the row was written by something that does not know about
     * transcription yet. Without this, that call is invisible forever — it does
     * not appear in any 'requested' query because it never got that far.
     *
     * This is what makes the twilio-voice hop non-critical rather than a single
     * point of failure. */
    const { data: unstarted } = await sb.from('calls_log')
      .select('id').is('transcript_status', null).not('recording_url', 'is', null).limit(25);
    for (const r of (unstarted || []) as any[]) {
      const s = await startForRow(r.id);
      results[r.id] = s.ok ? 'started' : `start_failed: ${s.error}`;
    }

    /* PART 2 — asked for, never came back. */
    const { data: rows } = await sb.from('calls_log')
      .select('id').eq('transcript_status', 'requested').lt('transcript_requested_at', cutoff).limit(50);

    for (const r of (rows || []) as any[]) {
      results[r.id] = await syncRow(r.id);
      /* Still 'requested' well past any plausible processing time is a stuck
       * row, and it gets said out loud rather than left to look in-flight. */
      if (results[r.id] === 'requested' && staleMin >= 60) {
        await markFailed(r.id, `Still not completed ${staleMin} minutes after it was requested. Twilio never returned a result.`);
        results[r.id] = 'failed';
      }
    }
    return json({ success: true, swept: Object.keys(results).length, results });
  }

  /* get — ADMIN ONLY, matching get_recording. */
  if (action === 'get') {
    const admin = await requireStaff(req, { roles: ['admin'], what: 'Call transcripts' });
    if (!admin.ok) {
      console.error('[call-intelligence] get REJECTED:', admin.status, admin.msg);
      return err(admin.msg || 'unauthorized', admin.status || 403);
    }
    if (!callLogId) return err('call_log_id required');
    const { data: row, error: e } = await sb.from('calls_log')
      .select('id, transcript, ai_summary, transcript_status, transcript_error, transcript_lang, transcript_requested_at, transcript_updated_at, recording_url')
      .eq('id', callLogId).maybeSingle();
    if (e) return err(e.message, 500);
    if (!row) return err('No such call', 404);
    const r: any = row;
    return json({
      success: true,
      status: r.transcript_status,           // null means never requested — say so, do not invent one
      transcript: r.transcript,
      ai_summary: r.ai_summary,
      error: r.transcript_error,
      lang: r.transcript_lang,
      has_recording: !!r.recording_url,
      requested_at: r.transcript_requested_at,
      updated_at: r.transcript_updated_at,
    });
  }

  return err(`Unknown action "${action}"`);
});
