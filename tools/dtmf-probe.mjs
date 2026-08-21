#!/usr/bin/env node
/* dtmf-probe — prove that pressing a key on the in-call keypad actually
 * transmits a DTMF tone, end to end, with nobody's phone ringing.
 *
 *   node tools/dtmf-probe.mjs            # sends 1 4 2 # by default
 *   node tools/dtmf-probe.mjs 9051
 *
 * WHY THIS EXISTS
 * "The keypad renders" and "the tones transmit" look identical from the
 * browser, and only the second is the claim worth making. A render-check spec
 * can prove sendDigits() was CALLED; it cannot prove a tone reached Twilio.
 * This does, by measuring the digits TWILIO HEARD.
 *
 * HOW, and why nobody is disturbed
 *   1. mint a Voice token for the automation account (tools/automation-session)
 *   2. open a real Chromium with a FAKE microphone and connect a real Twilio
 *      Voice call to the sentinel destination 'dtmf-probe'
 *   3. twilio-voice answers that sentinel with <Gather> instead of <Dial>, so
 *      the call terminates at Twilio — no PSTN leg, no ringing handset, no
 *      calls_log row
 *   4. drive the REAL admin/js/dtmf-pad.js — the shipped component, not a copy
 *   5. Twilio posts the digits it heard back; read them out of dtmf_probe_log
 *      and compare
 *
 * Exit 0 = the digits pressed are the digits Twilio heard.
 * Exit 1 = they are not, or nothing arrived.  Exit 2 = could not run.
 *
 * process.exitCode, never process.exit(): on Windows a hard exit with sockets
 * open aborts teardown and REPLACES the code with 0 — a gate that always
 * passes. Same rule as browser-cors-check.
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const DIGITS = (process.argv[2] || '142#').split('');
const SB = 'https://ljywhvbmsibwnssxpesh.supabase.co';
const ANON = (readFileSync('api/env.js', 'utf8').match(/eyJ[A-Za-z0-9._-]{40,}/) || [])[0];
if (!ANON) { console.error('refused: no anon key in api/env.js'); process.exitCode = 2; }

const say = (m) => console.log(m);

function chromePath() {
  for (const p of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.CHROME_PATH,
  ]) if (p && existsSync(p)) return p;
  return null;
}

async function cdp(port, sessionId, method, params, id) {
  // minimal CDP over the websocket-less /json/protocol is not possible; use ws
  throw new Error('unused');
}

async function main() {
  if (!ANON) return;
  const chrome = chromePath();
  if (!chrome) { console.error('refused: Chrome not found'); process.exitCode = 2; return; }

  // 1 ─ token
  let token;
  try {
    const access = execFileSync('node', ['tools/automation-session.mjs'], { encoding: 'utf8' }).trim();
    const r = await fetch(`${SB}/functions/v1/twilio-voice`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_token' }),
    });
    const j = await r.json();
    token = j && j.token;
    if (!token) throw new Error('no token in response: ' + JSON.stringify(j).slice(0, 200));
    say('  ✓ voice token minted for the automation account');
  } catch (e) {
    console.error('refused: could not mint a voice token —', e.message);
    process.exitCode = 2; return;
  }

  const ref = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // 2 ─ serve a page that loads the REAL keypad component
  const pad = readFileSync('admin/js/dtmf-pad.js', 'utf8');
  const page = `<!doctype html><meta charset="utf-8"><title>dtmf probe</title>
<script src="https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.11.3/dist/twilio.min.js"></script>
<script>${pad}</script>
<button id="kp">keypad</button>
<script>
  window.__state = 'boot';
  window.__err = '';
  (async () => {
    try {
      const dev = new Twilio.Device(${JSON.stringify(token)}, { codecPreferences: ['opus','pcmu'] });
      await dev.register();
      window.__state = 'registered';
      const call = await dev.connect({ params: { To: 'dtmf-probe', Ref: ${JSON.stringify(ref)} } });
      window.__call = call;
      call.on('accept', () => { window.__state = 'accepted'; });
      call.on('disconnect', () => { window.__state = 'disconnected'; });
      call.on('error', (e) => { window.__err = String(e && e.message || e); window.__state = 'error'; });
      // The REAL component, wired exactly as the dialer wires it.
      window.DTMFPad.attach(document.getElementById('kp'), () => window.__call);
    } catch (e) { window.__err = String(e && e.message || e); window.__state = 'error'; }
  })();
</script>`;
  const srv = createServer((_q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((r) => srv.listen(8802, '127.0.0.1', r));

  // 3 ─ headless Chrome with a FAKE mic
  const profile = mkdtempSync(join(tmpdir(), 'rr-dtmf-'));
  const args = [
    '--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--use-fake-device-for-media-stream',   // a synthetic mic — no hardware needed
    '--use-fake-ui-for-media-stream',       // and no permission prompt to click
    '--autoplay-policy=no-user-gesture-required',
    'http://127.0.0.1:8802/',
  ];
  const proc = spawn(chrome, args, { stdio: 'ignore' });
  say('  ✓ headless Chromium up with a fake microphone');

  const { default: WS } = await import('ws').catch(() => ({ default: null }));
  let ws, msgId = 0, pending = new Map();
  const connectCdp = async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
        const pg = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:8802'));
        if (pg) return pg.webSocketDebuggerUrl;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('CDP never came up');
  };

  let failed = false;
  try {
    if (!WS) throw new Error("the 'ws' package is not available");
    ws = new WS(await connectCdp());
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params) => new Promise((res) => {
      const id = ++msgId; pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      return r.result && r.result.result && r.result.result.value;
    };

    // 4 ─ wait for the call to be accepted by Twilio
    let state = '';
    for (let i = 0; i < 60; i++) {
      state = await evaluate('window.__state');
      if (state === 'accepted' || state === 'error') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (state !== 'accepted') {
      console.error(`  ✗ call never connected (state=${state}) ${await evaluate('window.__err')}`);
      failed = true;
    } else {
      say('  ✓ Twilio accepted the call — no PSTN leg, nothing rang');
      // 5 ─ press the keys through the REAL pad, exactly as a person would
      await evaluate('document.getElementById("kp").click()');
      await new Promise((r) => setTimeout(r, 400));
      for (const d of DIGITS) {
        await evaluate(`document.querySelector('.rrdt-pop [data-d="${d === '#' ? '#' : d}"]').click()`);
        await new Promise((r) => setTimeout(r, 450));   // let each tone land
      }
      const log = await evaluate('JSON.stringify(window.__rrDtmfLog||[])');
      say(`  ✓ pressed ${DIGITS.join('')} through admin/js/dtmf-pad.js — ${log}`);
      /* HOLD THE CALL OPEN. <Gather timeout="5"> only posts once it has stopped
         hearing digits; disconnecting straight after the last key kills the leg
         before Twilio ever reports what it heard, and the probe then blames the
         keypad for its own impatience. */
      say('  … holding the line ~9s so the Gather can complete');
      await new Promise((r) => setTimeout(r, 9000));
      await evaluate('window.__call && window.__call.disconnect()');
    }
  } catch (e) {
    console.error('  ✗ harness error:', e.message);
    failed = true;
  } finally {
    try { ws && ws.close(); } catch (_) {}
    try { proc.kill(); } catch (_) {}
    srv.close();
  }

  // 6 ─ what did TWILIO hear?
  say('  … waiting for Twilio to post the digits it heard');
  let heard = null;
  for (let i = 0; i < 30 && heard === null; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const access = execFileSync('node', ['tools/automation-session.mjs'], { encoding: 'utf8' }).trim();
      const r = await fetch(`${SB}/rest/v1/dtmf_probe_log?select=digits,call_sid&ref=eq.${ref}`, {
        headers: { apikey: ANON, Authorization: `Bearer ${access}` },
      });
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length) heard = rows[0].digits;
    } catch (_) {}
  }

  const want = DIGITS.join('');
  console.log('');
  console.log(`  pressed : ${want}`);
  console.log(`  Twilio heard : ${heard === null ? '(nothing arrived)' : heard}`);
  if (heard !== null && heard === want) {
    console.log('\nPASS — the tones transmitted. Not "sendDigits was called": Twilio heard them.');
  } else {
    console.log('\nFAIL — what was pressed is not what Twilio heard.');
    failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}

main();
