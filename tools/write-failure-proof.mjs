#!/usr/bin/env node
/* write-failure-proof — prove the eight borrower-data writes in
 * admin/lead-detail.html report failure AND report success.
 *
 * WHY THIS EXISTS
 * 9f87ca6 fixed eight write calls at five locations that swallowed database
 * failures, and its commit message claims they were "proven per site in BOTH
 * directions by CDP interception — forced 400 and forced 204". No such harness
 * was ever committed: `git log --all -S 'Fetch.enable'` and `-S 'fulfillRequest'`
 * both return nothing, and render-check.mjs enables only Emulation, Log, Page,
 * Runtime and Target — not even the Network domain. The claim had no artifact.
 * This is that artifact.
 *
 * HOW IT PROVES ANYTHING
 * supabase-js RESOLVES with { error } instead of throwing, so this entire bug
 * class is about how the page reads an HTTP outcome. That makes the outcome the
 * only thing that has to be real: CDP Fetch interception fulfills the write
 * locally with a forced 400 (break) or a forced 204 (working), and the request
 * never leaves the browser.
 *
 * THE DATABASE IS NEVER WRITTEN TO. Not "should not be" — cannot be. On the
 * Supabase host exactly one thing is ever forwarded to the network: an OPTIONS
 * preflight, which cannot mutate. Every other request is answered locally. That
 * is asserted at RUNTIME (forwardedNonOptions must end at 0, or the run fails)
 * and separately by `--selftest-writes`, which drives the classifier over the
 * mutating shapes and fails if any is routed to the network. A rehearsal that
 * writes is worse than no rehearsal, so the no-write property is measured
 * rather than intended.
 *
 * THE TWO TRAPS THIS AVOIDS, both named in 9f87ca6's own message:
 *   1. OPTIONS is NEVER fulfilled locally. A preflight answered wrongly makes
 *      the browser fail the real request for a CORS reason, so the page shows an
 *      error and the BREAK direction "passes" while proving nothing about the
 *      fix. Preflights are continued to the network, read-only.
 *   2. EVERY fulfilled response carries CORS headers. Same failure mode pointing
 *      the other way: a fulfilled 204 with no Access-Control-Allow-Origin is a
 *      network error to the page, so the WORKING direction would fail for the
 *      wrong reason and read as a regression in the fix.
 *
 * WHAT A GREEN RUN DOES NOT PROVE — printed on every run, deliberately.
 * This is a CLIENT-SIDE proof. A forced 204 proves the page treats success as
 * success; it does NOT prove RLS, a column grant or a CHECK constraint would
 * accept the row. Those need a real role token against the real table, the way
 * the mailbox boundary was proven. Do not read green here as "works end to end".
 *
 * Two things are synthetic and are named so they are never mistaken for proven:
 *   · the SESSION is a locally-minted JWT that no server ever validates (there
 *     is no service-role key in this environment). It exists only to get past
 *     auth-guard's getSession() check, which reads localStorage and does not
 *     call the network while the token is unexpired.
 *   · the Places PICK. api/env.js ships GOOGLE_MAPS_API_KEY:"" so RRPlaces.load()
 *     rejects and the field stays a plain text input — a genuine Google pick
 *     cannot happen here. The harness captures the real onFill closure that
 *     lead-detail.html passes to attachCombined and invokes it directly. From
 *     onFill onward the code under test is the page's own; only the Google
 *     object handed to it is fabricated.
 *
 *   node tools/write-failure-proof.mjs                  # every run
 *   node tools/write-failure-proof.mjs liab             # filter by name
 *   node tools/write-failure-proof.mjs --selftest-writes
 *   node tools/write-failure-proof.mjs --selftest-harness
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  'C:\\Users\\rened\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const BASE = process.env.RC_BASE || 'https://admin.ratesandrealty.com';
const FIXTURE = 'aa74cc5e-2186-4b40-8608-3d2aa033b9ca';   // ZZ-TEST Fixture Borrower
const SUPA_HOST = 'ljywhvbmsibwnssxpesh.supabase.co';
const PAGE = `${BASE}/admin/lead-detail.html?contact_id=${FIXTURE}`;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const filter = argv.filter((a) => !a.startsWith('--'))[0] || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function refuse(msg) { console.error('\n  REFUSED: ' + msg + '\n'); process.exit(2); }

function chromePath() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  refuse('no Chromium/Chrome/Edge binary found. Tried:\n  ' + CHROME_CANDIDATES.join('\n  '));
}

/* ── request classification ────────────────────────────────────────────────
 * ONE function decides what happens to every request, so the no-write property
 * is a property of one readable thing rather than of scattered branches. It is
 * exported to --selftest-writes, which is the only way "nothing is forwarded"
 * is a measurement instead of a claim.
 *   'preflight' → continueRequest (the ONLY thing that reaches the network)
 *   'write'     → fulfilled locally, 400 or 204 per policy
 *   'read'      → fulfilled locally with canned data
 *   'offhost'   → continueRequest (page assets: HTML, JS, CSS, fonts)          */
function classify(method, url) {
  if (!url.includes(SUPA_HOST)) return 'offhost';
  if (method === 'OPTIONS') return 'preflight';
  const path = url.split('?')[0].replace(/^https:\/\/[^/]+/, '');
  const m = path.match(/^\/rest\/v1\/([^/?]+)/);
  const table = m ? m[1] : null;
  if (table && table !== 'rpc' && method !== 'GET' && method !== 'HEAD') return 'write';
  return 'read';
}
function tableOf(url) {
  const path = url.split('?')[0].replace(/^https:\/\/[^/]+/, '');
  const m = path.match(/^\/rest\/v1\/([^/?]+)/);
  return m ? m[1] : null;
}

/* ── CDP ───────────────────────────────────────────────────────────────────
 * render-check's channel accumulates events into an array. That cannot answer a
 * Fetch.requestPaused, and an unanswered pause hangs the load, so this one takes
 * real listeners. */
function cdpChannel(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const handlers = new Map();
    ws.onerror = () => reject(new Error('cdp connect failed: ' + url));
    ws.onopen = () => {
      let id = 0; const pending = new Map();
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
        if (m.method) { const hs = handlers.get(m.method); if (hs) for (const h of hs) { try { h(m.params); } catch (_) {} } }
      };
      const send = (method, params = {}) => {
        const mid = ++id;
        ws.send(JSON.stringify({ id: mid, method, params }));
        return new Promise((res, rej) => {
          pending.set(mid, res);
          setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(method + ' timed out')); } }, 30000);
        });
      };
      const on = (method, fn) => { if (!handlers.has(method)) handlers.set(method, []); handlers.get(method).push(fn); };
      resolve({ send, on, raw: ws });
    };
  });
}

async function launchBrowser(port, profileDir) {
  const proc = spawn(chromePath(), [
    '--headless=new', `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 80; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (v && v.webSocketDebuggerUrl) { wsUrl = v.webSocketDebuggerUrl; break; }
    } catch (_) {}
    await sleep(250);
  }
  if (!wsUrl) { proc.kill(); refuse('browser never exposed a debuggable endpoint'); }
  const chan = await cdpChannel(wsUrl);
  return { proc, port, send: chan.send, close: () => { try { chan.raw.close(); } catch (_) {} proc.kill(); } };
}

async function newPage(browser) {
  const ctx = await browser.send('Target.createBrowserContext', { disposeOnDetach: false });
  const browserContextId = ctx.result.result ? ctx.result.result.browserContextId : ctx.result.browserContextId;
  const tgt = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const targetId = tgt.result.result ? tgt.result.result.targetId : tgt.result.targetId;
  const chan = await cdpChannel(`ws://127.0.0.1:${browser.port}/devtools/page/${targetId}`);
  return {
    send: chan.send, on: chan.on,
    close: async () => {
      try { chan.raw.close(); } catch (_) {}
      try { await browser.send('Target.closeTarget', { targetId }); } catch (_) {}
      try { await browser.send('Target.disposeBrowserContext', { browserContextId }); } catch (_) {}
    },
  };
}

/* CORS on EVERY fulfilled response — trap 2. */
const CORS = (origin) => ([
  { name: 'Access-Control-Allow-Origin', value: origin || '*' },
  { name: 'Access-Control-Allow-Credentials', value: 'true' },
  { name: 'Access-Control-Expose-Headers', value: 'content-range' },
  { name: 'Content-Type', value: 'application/json' },
]);
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const u8 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const UID = '11111111-2222-3333-4444-555555555555';
function mintJwt() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    exp,
    raw: [
      u8(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
      u8(JSON.stringify({ sub: UID, email: 'rene@ratesandrealty.com', role: 'authenticated', aud: 'authenticated', exp, iat: Math.floor(Date.now() / 1000) })),
      'write-failure-proof-local-only-never-validated',
    ].join('.'),
  };
}

const CONTACT = {
  id: FIXTURE, first_name: 'ZZ-TEST', last_name: 'Fixture Borrower',
  email: 'zz-test@example.invalid', phone: '+15555550100',
  pipeline_status: 'New Lead', lead_source: 'automated-test',
  property_address: '1 Test Way, Testville, CA 90210',
  property_city: 'Testville', property_state: 'CA', property_zip: '90210', county: 'Orange',
  liabilities: [], monthly_income: 10000, monthly_debt: 0,
  estimated_earnings: null, actual_earnings: null, deal_outcome: null, lost_reason: null,
  loan_amount: 500000, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

function readBody(url) {
  const path = url.split('?')[0].replace(/^https:\/\/[^/]+/, '');
  if (path.startsWith('/rest/v1/rpc/')) {
    const fn = path.slice('/rest/v1/rpc/'.length);
    if (fn === 'current_app_role') return '"admin"';
    if (fn === 'my_capabilities') return '{}';
    if (/count/.test(fn)) return '0';
    return '[]';
  }
  if (/\/(contacts_secure|contacts|leads)\b/.test(path)) return JSON.stringify([CONTACT]);
  return '[]';
}

/* PostgREST's own refusal shape. The message is what the page must surface. */
const PG_400 = (table) => JSON.stringify({
  code: '42501', details: null, hint: null,
  message: `new row violates row-level security policy for table "${table}"`,
});

/* ── instrumentation injected at document-start ────────────────────────────
 * RRPlaces is captured through a SETTER, not by assigning over it. places-
 * autocomplete.js assigns `w.RRPlaces = {…}` at the end of its IIFE, so a plain
 * pre-assignment would be silently replaced — the identical trap CLAUDE.md
 * documents for the render-check stub and window.supabase. */
const preamble = (jwt) => `
try{ localStorage.setItem('sb-ljywhvbmsibwnssxpesh-auth-token', ${JSON.stringify(JSON.stringify({
  access_token: jwt.raw, token_type: 'bearer', expires_at: jwt.exp, expires_in: 3600,
  refresh_token: 'write-failure-proof', user: { id: UID, email: 'rene@ratesandrealty.com', aud: 'authenticated', role: 'authenticated' },
}))}); }catch(e){}
window.__wfp = { toasts: [], alerts: [], errors: [], fills: {} };
(function(){
  var _v;
  Object.defineProperty(window, 'RRPlaces', {
    configurable: true,
    get: function(){ return _v; },
    set: function(v){
      _v = v;
      if (v && typeof v.attachCombined === 'function') {
        var orig = v.attachCombined;
        v.attachCombined = function(id, opts){ window.__wfp.fills[id] = opts; return orig.apply(this, arguments); };
      }
    }
  });
})();
// A real dialog blocks headless Chromium forever. The message IS the assertion.
window.alert = function(m){ window.__wfp.alerts.push(String(m)); };
`;

/* Wrapped AFTER load — toast() is defined by the page's own script. Wrapping
   records the call and still runs the real implementation, so #ld-toast is a
   second, independent witness to the same event. */
const INSTRUMENT = `(function(){
  if (window.__wfpWrapped) return 'already';
  window.__wfpWrapped = true;
  ['toast','showToast'].forEach(function(n){
    var orig = window[n];
    if (typeof orig !== 'function') return;
    window[n] = function(msg, isErr){ window.__wfp.toasts.push({ fn:n, msg:String(msg), err:!!isErr }); return orig.apply(this, arguments); };
  });
  var ce = console.error;
  console.error = function(){ try{ window.__wfp.errors.push(Array.prototype.map.call(arguments, function(a){ return (a && a.message) ? a.message : String(a); }).join(' ')); }catch(_){} return ce.apply(console, arguments); };
  return 'ok';
})()`;

const RESET = `(function(){ window.__wfp.toasts=[]; window.__wfp.alerts=[]; window.__wfp.errors=[]; return 'reset'; })()`;

/* ── the runs ──────────────────────────────────────────────────────────────
 * `failTable` names the table forced to 400; null means every write is a forced
 * 204. Sites whose action writes to two tables get one run per table plus one
 * all-succeed run, so each write is proven to be the one that broke. */
const P = { street: '742 Evergreen Ter', city: 'Springfield', state: 'CA', zip: '90210', county: 'Los Angeles', isProperty: true };
const ADDR = '742 Evergreen Ter, Springfield, CA 90210';

const RUNS = [
  {
    name: 'A places-contacts / BREAK', site: 'A', failTable: 'contacts',
    prep: `(function(){ var e=document.getElementById('f-property'); if(e) e.value=''; return !!window.__wfp.fills['f-property']; })()`,
    act: `(async function(){
      var o = window.__wfp.fills['f-property'];
      if (!o || typeof o.onFill !== 'function') return 'NO_ONFILL';
      o.onFill(${JSON.stringify(ADDR)}, { formatted_address: ${JSON.stringify(ADDR)} }, ${JSON.stringify(P)});
      await new Promise(function(r){ setTimeout(r, 2500); });
      return 'done';
    })()`,
  },
  { name: 'B places-1003 / BREAK', site: 'B', failTable: 'mortgage_applications', sameAs: 'A' },
  { name: 'A+B places / OK', site: 'A+B', failTable: null, sameAs: 'A' },

  {
    name: 'C popup-contacts / BREAK', site: 'C', failTable: 'contacts',
    /* The popup's 1003 write is gated on _spParsed, a closure variable set ONLY
       by the onFill that lpSnapEdit hands to window.attachPlacesAddress. Wrap
       that function to capture the page's own closure and invoke it, the same
       way the A/B site captures RRPlaces.attachCombined. Without this the
       mortgage_applications branch never runs and a "D" result would be a run
       that proved nothing while looking green. */
    prep: `(function(){
      if (typeof lpSnapEdit !== 'function') return 'NO_FN';
      if (!window.__wfpApaWrapped) {
        window.__wfpApaWrapped = true;
        var orig = window.attachPlacesAddress;
        window.attachPlacesAddress = function(el, opts){
          window.__wfp.spFill = { el: el, opts: opts };
          return (typeof orig === 'function') ? orig.apply(this, arguments) : null;
        };
      }
      lpSnapEdit('subject_property', { stopPropagation:function(){}, preventDefault:function(){} });
      return document.getElementById('lpSnapEditor') ? 'panel-open' : 'NO_PANEL';
    })()`,
    /* The 10ms setTimeout inside lpSnapEdit overwrites the input with the stored
       address, so the value is typed AFTER it, not before — otherwise the box is
       empty at save time and "the text is still in it" tests nothing. */
    act: `(async function(){
      await new Promise(function(r){ setTimeout(r, 400); });
      var inp = document.getElementById('lpSpAddr');
      if (!inp) return 'NO_INPUT';
      inp.value = ${JSON.stringify(ADDR)};
      var f = window.__wfp.spFill;
      if (!f || !f.opts || typeof f.opts.onFill !== 'function') return 'NO_SPFILL';
      f.opts.onFill(${JSON.stringify({ ...P, formatted: ADDR })}, inp);
      var b = document.getElementById('lpSnapSave');
      if (!b) return 'NO_SAVE_BTN';
      b.click();
      await new Promise(function(r){ setTimeout(r, 2600); });
      return 'done';
    })()`,
  },
  { name: 'D popup-1003 / BREAK', site: 'D', failTable: 'mortgage_applications', sameAs: 'C' },
  { name: 'C+D popup / OK', site: 'C+D', failTable: null, sameAs: 'C' },

  {
    name: 'E liab-add / BREAK', site: 'E', failTable: 'contacts',
    prep: `(function(){
      liabilitiesData = []; contactData.liabilities = [];
      renderLiabilities();
      document.getElementById('liab-creditor').value = 'WFP Probe Card';
      document.getElementById('liab-balance').value  = '12000';
      document.getElementById('liab-payment').value  = '250';
      var t=document.getElementById('liab-type'); if(t && t.options.length) t.selectedIndex = 0;
      return 'ready dti=' + document.getElementById('dti-ratio').textContent;
    })()`,
    act: `(async function(){ await addLiability(); await new Promise(function(r){setTimeout(r,600);}); return 'done'; })()`,
  },
  { name: 'E liab-add / OK', site: 'E', failTable: null, sameAs: 'E' },

  {
    name: 'F liab-remove / BREAK', site: 'F', failTable: 'contacts',
    prep: `(function(){
      var row = { creditor:'WFP Seed Loan', type:'auto', balance:20000, monthly_payment:400, payoff_required:false };
      liabilitiesData = [row]; contactData.liabilities = [row];
      renderLiabilities();
      return 'seeded rows=' + liabilitiesData.length + ' dti=' + document.getElementById('dti-ratio').textContent;
    })()`,
    act: `(async function(){ await removeLiability(0); await new Promise(function(r){setTimeout(r,600);}); return 'done'; })()`,
  },
  { name: 'F liab-remove / OK', site: 'F', failTable: null, sameAs: 'F' },

  {
    name: 'G logActivity / BREAK', site: 'G', failTable: 'activity_events',
    prep: `(function(){ return 'leadId=' + leadId; })()`,
    act: `(async function(){ await logActivity('wfp_probe','write-failure-proof'); await new Promise(function(r){setTimeout(r,400);}); return 'done'; })()`,
  },
  { name: 'G logActivity / OK', site: 'G', failTable: null, sameAs: 'G' },

  {
    name: 'H earnings-contacts / BREAK', site: 'H', failTable: 'contacts',
    prep: `(function(){
      var a=document.getElementById('actualEarnings'); if(!a) return 'NO_INPUT';
      a.value='4200';
      var e=document.getElementById('estimatedEarnings'); if(e) e.value='4000';
      _currentOutcome='won';
      var ind=document.getElementById('autoSaveIndicator');
      if(ind){ ind.textContent='—'; ind.title=''; }
      return 'ready';
    })()`,
    act: `(async function(){ saveEarnings(); await new Promise(function(r){setTimeout(r,2600);}); return 'done'; })()`,
  },
  { name: 'H earnings-closed_deals / BREAK', site: 'H2', failTable: 'closed_deals', sameAs: 'H' },
  { name: 'H earnings / OK', site: 'H', failTable: null, sameAs: 'H' },
];

/* One verdict expression for every run: every observable the eight fixes touch,
   collected together so a run reports what happened rather than a boolean. */
const VERDICT = `(function(){
  var t = document.getElementById('ld-toast');
  var ind = document.getElementById('autoSaveIndicator');
  var panel = document.getElementById('lpSnapEditor');
  var inp = panel ? panel.querySelector('input') : null;
  var fp = document.getElementById('f-property');
  var lp = document.getElementById('lp-prop-addr');
  return JSON.stringify({
    toasts: window.__wfp.toasts,
    alerts: window.__wfp.alerts,
    errors: window.__wfp.errors.filter(function(e){ return /logActivity|saveEarnings|places-sync|\\[/.test(e); }),
    toastEl: t ? { text: t.textContent, cls: t.className } : null,
    liabRows: (typeof liabilitiesData !== 'undefined') ? liabilitiesData.length : null,
    liabNames: (typeof liabilitiesData !== 'undefined') ? liabilitiesData.map(function(l){return l.creditor;}) : null,
    cacheRows: (typeof contactData !== 'undefined' && contactData.liabilities) ? contactData.liabilities.length : null,
    tableText: (document.getElementById('liab-tbody')||{}).textContent ? document.getElementById('liab-tbody').textContent.replace(/\\s+/g,' ').trim().slice(0,120) : '',
    dtiRatio: (document.getElementById('dti-ratio')||{}).textContent || null,
    dtiDebt: (document.getElementById('dti-total-debt')||{}).textContent || null,
    indText: ind ? ind.textContent : null,
    indTitle: ind ? ind.title : null,
    panelOpen: !!panel,
    panelValue: inp ? inp.value : null,
    fProp: fp ? fp.value : null,
    lpAddr: lp ? lp.value : null,
    cProp: (typeof contactData !== 'undefined') ? (contactData.property_address || null) : null,
    cCounty: (typeof contactData !== 'undefined') ? (contactData.county || null) : null
  });
})()`;

async function runOne(browser, run, resolvePrep) {
  const jwt = mintJwt();
  const page = await newPage(browser);
  const stats = { forwardedNonOptions: 0, preflights: 0, writes: [], fulfilled: 0 };

  page.on('Fetch.requestPaused', async (p) => {
    const { requestId, request } = p;
    const kind = classify(request.method, request.url);
    const origin = (request.headers && (request.headers.Origin || request.headers.origin)) || '*';
    try {
      if (kind === 'offhost') { await page.send('Fetch.continueRequest', { requestId }); return; }
      if (kind === 'preflight') {
        stats.preflights++;
        await page.send('Fetch.continueRequest', { requestId });   // the ONLY network path
        return;
      }
      if (kind === 'write') {
        const table = tableOf(request.url);
        const breaking = run.failTable && table === run.failTable;
        stats.writes.push({ table, method: request.method, forced: breaking ? 400 : 204 });
        stats.fulfilled++;
        if (breaking) {
          await page.send('Fetch.fulfillRequest', {
            requestId, responseCode: 400, responseHeaders: CORS(origin), body: b64(PG_400(table)),
          });
        } else {
          await page.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: CORS(origin) });
        }
        return;
      }
      stats.fulfilled++;
      await page.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200, responseHeaders: CORS(origin), body: b64(readBody(request.url)),
      });
    } catch (_) { /* target gone */ }
  });

  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: preamble(jwt) });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: `*${SUPA_HOST}*`, requestStage: 'Request' }] });
  await page.send('Page.navigate', { url: PAGE });

  // Wait for the page's own functions, rather than a fixed sleep that is either
  // slow or flaky depending on the day.
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const r = await page.send('Runtime.evaluate', {
      expression: `(typeof addLiability==='function' && typeof saveEarnings==='function' && typeof toast==='function' && typeof contactId!=='undefined' && !!contactId)`,
      returnByValue: true,
    });
    if (r.result?.result?.value === true) { ready = true; break; }
    await sleep(500);
  }
  if (!ready) {
    const href = await page.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    await page.close();
    return { run: run.name, ERROR: 'page never became ready; at ' + (href.result?.result?.value || '?') };
  }
  await sleep(1500);   // let first-paint fetches settle before instrumenting
  await page.send('Runtime.evaluate', { expression: INSTRUMENT, returnByValue: true });
  await page.send('Runtime.evaluate', { expression: RESET, returnByValue: true });

  const prepSrc = run.prep || resolvePrep(run.sameAs).prep;
  const actSrc = run.act || resolvePrep(run.sameAs).act;

  const prep = await page.send('Runtime.evaluate', { expression: prepSrc, returnByValue: true, awaitPromise: true });
  const act = await page.send('Runtime.evaluate', { expression: actSrc, returnByValue: true, awaitPromise: true });
  const v = await page.send('Runtime.evaluate', { expression: VERDICT, returnByValue: true });

  await page.close();
  let parsed = {};
  try { parsed = JSON.parse(v.result?.result?.value || '{}'); } catch (_) { parsed = { PARSE_FAIL: v.result?.result?.value }; }
  return {
    run: run.name, failTable: run.failTable || '(none — all forced 204)',
    prep: prep.result?.result?.value ?? prep.result?.exceptionDetails?.text ?? '?',
    act: act.result?.result?.value ?? act.result?.exceptionDetails?.text ?? '?',
    stats, ...parsed,
  };
}

/* ── selftest: the no-write property, measured ─────────────────────────────
 * Drives classify() over the mutating shapes these five locations actually
 * produce and fails if ANY is routed anywhere but a local fulfillment. This is
 * the check that makes "the rehearsal writes nothing" a fact about the code. */
function selftestWrites() {
  const H = 'https://' + SUPA_HOST;
  const cases = [
    ['PATCH', H + '/rest/v1/contacts?id=eq.' + FIXTURE, 'write'],
    ['PATCH', H + '/rest/v1/mortgage_applications?contact_id=eq.' + FIXTURE, 'write'],
    ['POST', H + '/rest/v1/activity_events', 'write'],
    ['POST', H + '/rest/v1/closed_deals?on_conflict=contact_id', 'write'],
    ['DELETE', H + '/rest/v1/contacts?id=eq.' + FIXTURE, 'write'],
    ['PUT', H + '/rest/v1/contacts', 'write'],
    ['GET', H + '/rest/v1/contacts_secure?select=*', 'read'],
    ['POST', H + '/rest/v1/rpc/current_app_role', 'read'],
    ['OPTIONS', H + '/rest/v1/contacts', 'preflight'],
    ['GET', 'https://admin.ratesandrealty.com/admin/lead-detail.html', 'offhost'],
  ];
  let bad = 0;
  console.log('\n  no-write selftest — every mutating shape must classify as "write" (fulfilled locally, never forwarded)\n');
  for (const [m, u, want] of cases) {
    const got = classify(m, u);
    const ok = got === want;
    if (!ok) bad++;
    console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${m.padEnd(7)} ${u.replace(H, '').slice(0, 58).padEnd(60)} → ${got}${ok ? '' : '   WANTED ' + want}`);
  }
  const forwarded = cases.filter(([m, u]) => u.includes(SUPA_HOST) && classify(m, u) === 'preflight' && m !== 'OPTIONS');
  console.log(`\n   mutating shapes forwarded to the network: ${forwarded.length}`);
  if (bad || forwarded.length) { console.error('\n  SELFTEST FAILED\n'); process.exit(1); }
  console.log('\n  PASS — the only request kind that reaches the network is an OPTIONS preflight.\n');
}

const BOUNDARY = `
  ── WHAT THIS RUN DID NOT PROVE ────────────────────────────────────────────
  Client-side only. A forced 204 proves the page treats success as success; it
  does NOT prove RLS, a column grant or a CHECK constraint would accept the row.
  The session is a locally-minted JWT no server validated. The Places pick is
  synthetic (api/env.js ships GOOGLE_MAPS_API_KEY:"") — the real onFill closure
  is invoked directly. Nothing was written to the database: only OPTIONS
  preflights reached the network.
`;

async function main() {
  if (has('--selftest-writes')) { selftestWrites(); return; }
  selftestWrites();   // always runs first — the rehearsal must be proven inert before it runs

  const byName = new Map(RUNS.map((r) => [r.site, r]));
  const resolvePrep = (site) => {
    const base = RUNS.find((r) => r.site === site && r.prep);
    if (!base) refuse('no base run carrying prep/act for site ' + site);
    return base;
  };

  let runs = RUNS;
  if (filter) runs = RUNS.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()));
  if (!runs.length) refuse(`no run matches "${filter}"`);

  const browser = await launchBrowser(9457, `${process.env.TEMP || '/tmp'}/wfp-${process.pid}`);
  const out = [];
  for (const r of runs) {
    process.stdout.write(`  running ${r.name} … `);
    const res = await runOne(browser, r, resolvePrep);
    out.push(res);
    console.log(res.ERROR ? 'ERROR' : `writes=${res.stats.writes.map((w) => w.table + ':' + w.forced).join(',') || 'none'} fwd=${res.stats.forwardedNonOptions}`);
  }
  browser.close();

  console.log('\n' + JSON.stringify(out, null, 2));
  console.log(BOUNDARY);

  const leaked = out.filter((o) => o.stats && o.stats.forwardedNonOptions > 0);
  if (leaked.length) { console.error('  A NON-OPTIONS REQUEST WAS FORWARDED. Treat every result as void.\n'); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
