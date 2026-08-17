#!/usr/bin/env node
/* Call an edge function from a REAL browser, the way the page does.
 *
 *   node tools/browser-fn-probe.mjs voe-form-fill
 *   node tools/browser-fn-probe.mjs voe-form-fill gmail-inbox
 *
 * browser-cors-check.mjs reads one header off one preflight. This actually makes
 * the call: real Chromium, real admin.ratesandrealty.com origin, real preflight,
 * real CORS enforcement, through the page's OWN supabase-js.
 *
 * WHY IT MUST BE THE PAGE'S LIBRARY. The header at issue — x-client-info — is one
 * supabase-js adds by itself. A probe that hand-builds a fetch chooses its own
 * headers and can pass while the page fails, which is the entire class of bug
 * this exists to catch. Do not "simplify" this into a fetch().
 *
 * READ THE VERDICT CAREFULLY:
 *   REACHED — the request left the browser and a server answered. A 4xx here is
 *             still REACHED; a status means the server replied.
 *   BLOCKED — supabase-js FunctionsFetchError, "Failed to send a request to the
 *             Edge Function". No status, because there is no response. The
 *             browser refused to send it, almost always a CORS preflight that
 *             did not allow back every requested header.
 *
 * REACHED does NOT mean the feature works — only that CORS is not the obstacle.
 *
 * An earlier version imported supabase-js from esm.sh inside the page and the
 * page CSP blocked it, which the probe reported as BLOCKED. It was measuring its
 * own import failure and blaming the function. Hence harness_ok: the probe says
 * when it cannot judge instead of returning a verdict it has not earned.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  'C:\\Users\\rened\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const CHROME = CHROME_CANDIDATES.find(existsSync);
if (!CHROME) {
  console.error('no Chromium/Chrome found. Tried:\n  ' + CHROME_CANDIDATES.join('\n  '));
  process.exit(2);
}

const SB = 'https://ljywhvbmsibwnssxpesh.supabase.co';
const PAGE = 'https://admin.ratesandrealty.com/admin/lead-detail.html';
// Public anon key — printed in every page of the site.
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxqeXdodmJtc2lid25zc3hwZXNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNjE2NTUsImV4cCI6MjA4OTYzNzY1NX0.QaewUhTWdATj35VewvmfQcHB_b3I9FhhwXSRuqNBKvw';

/* --body '<json>' sends a real payload instead of the default probe body, and
   --show prints the response instead of only the reached/blocked verdict. Added
   because "the page gets a different answer than curl" is the same shape as the
   CORS bug, and answering it needs the BROWSER's actual response, not a
   reconstruction of it. */
const argv = process.argv.slice(2);
let bodyOverride = null;
let show = false;
const slugs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--body') { bodyOverride = argv[++i]; continue; }
  if (argv[i] === '--show') { show = true; continue; }
  slugs.push(argv[i]);
}
if (!slugs.length) {
  console.error('usage: browser-fn-probe.mjs [--body <json>] [--show] <slug> [slug...]');
  process.exit(2);
}

const TOKEN = execFileSync('node', ['tools/automation-session.mjs'], { encoding: 'utf8' }).trim();

const PORT = 9400 + Math.floor(Math.random() * 400);
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu',
  `--user-data-dir=${process.env.TEMP}\\browser-fn-probe-${PORT}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
      if (r.ok) return r.json();
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chromium did not expose a debugging target');
}

let ws, seq = 0;
const pending = new Map();
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

let failed = 0;
try {
  const target = await newTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  };

  await send('Page.enable', {});
  await send('Runtime.enable', {});
  // The real origin: CORS is decided by where the request comes FROM.
  await send('Page.navigate', { url: PAGE });
  await sleep(6000);

  for (const slug of slugs) {
    const expression = `(async () => {
      const ns = window.supabase;
      if (!ns || typeof ns.createClient !== 'function') {
        return ({ harness_ok: false, why: 'window.supabase.createClient missing — cannot judge' });
      }
      const c = ns.createClient(${JSON.stringify(SB)}, ${JSON.stringify(ANON)}, {
        global: { headers: { Authorization: 'Bearer ' + ${JSON.stringify(TOKEN)} } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      try {
        const r = await c.functions.invoke(${JSON.stringify(slug)}, {
          body: ${bodyOverride || JSON.stringify({ order_id: '00000000-0000-0000-0000-000000000000' })},
        });
        const e = r.error;
        const msg = e ? String(e.message || '') : '';
        var out = {
          harness_ok: true,
          reached: !/Failed to send a request/i.test(msg),
          err_name: e ? (e.name || '') : '',
          err_msg: msg.slice(0, 140),
          status: (e && e.context && e.context.status) || (e ? null : 200),
        };
        if (${show ? 'true' : 'false'} && r.data) {
          // Never print base64 payloads — they are megabytes and tell you nothing.
          var d = JSON.parse(JSON.stringify(r.data));
          if (d && typeof d.content === 'string') d.content = '<' + d.content.length + ' base64 chars>';
          out.data = d;
        }
        return out;
      } catch (ex) {
        return ({ harness_ok: true, reached: false, err_name: 'threw', err_msg: String((ex && ex.message) || ex).slice(0, 160) });
      }
    })()`;

    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      console.log(`  HARNESS-FAIL ${slug} — ${r.exceptionDetails.text}`);
      failed++;
      continue;
    }
    const v = r.result.value || {};
    if (v.harness_ok === false) {
      console.log(`  HARNESS-FAIL ${slug} — ${v.why}`);
      failed++;
      continue;
    }
    console.log(`  ${v.reached ? 'REACHED' : 'BLOCKED'}  ${slug}  ${JSON.stringify(v)}`);
    if (!v.reached) failed++;
  }
} finally {
  try { ws && ws.close(); } catch (_) { /* already gone */ }
  proc.kill();
}

console.log(failed
  ? `\n${failed} of ${slugs.length} could not be reached from a browser.`
  : `\nAll ${slugs.length} reached from a real browser. CORS is not the obstacle.`);
console.log('REACHED means the request arrived and was answered — not that the feature works.');
// exitCode, not exit(): see browser-cors-check.mjs for why exit() lies here.
process.exitCode = failed ? 1 : 0;
