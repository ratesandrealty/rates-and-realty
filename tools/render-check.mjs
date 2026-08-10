#!/usr/bin/env node
/* render-check — load real pages in a real browser and fail if they are broken.
 *
 * WHY THIS EXISTS
 * `verify-deploy.mjs` proves the right BYTES shipped. That is not the same as the
 * page working: admin/settings.html once served byte-perfect, correct-hash HTML
 * and rendered nothing at all, because an inline script had a SyntaxError. Every
 * byte-level check passed while the page was blank.
 *
 * So this harness runs the page. By default it does so with NO credentials: the
 * Supabase client is stubbed before any page script runs, which means it can run
 * unattended, mints no auth.sessions row, and attributes nothing to a real user.
 *
 * WHAT IT CANNOT PROVE — printed on every run, deliberately, because a green run
 * from a rendering harness starts reading as "verified" for things it never
 * touched. See BOUNDARY below.
 *
 *   node tools/render-check.mjs                 # all specs, stubbed
 *   node tools/render-check.mjs lead-detail     # one spec by name substring
 *   node tools/render-check.mjs --url file:///…/x.html --expect "#nope"
 *   node tools/render-check.mjs --token tok.txt # real session (checks exp FIRST)
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  'C:\\Users\\rened\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const BASE = process.env.RC_BASE || 'https://admin.ratesandrealty.com';
const FIXTURE = 'aa74cc5e-2186-4b40-8608-3d2aa033b9ca';   // ZZ-TEST Fixture Borrower

const BOUNDARY = [
  'WHAT THIS RUN PROVES : the page renders — scripts parse and execute, the',
  '                       expected elements exist, no uncaught or console error.',
  'WHAT IT DOES NOT     : anything about AUTHORIZATION. The Supabase client is',
  '                       stubbed, so no role gate, RLS policy, column grant or',
  '                       mailbox refusal is exercised. A green run here says',
  '                       NOTHING about whether a va can reach rene@.',
  '                       Those are proven by calling the edge function directly',
  '                       with a real role token — see the va-probe in the',
  '                       scratchpad and the role checks in gmail-inbox.',
];

/* ── option A, applied here: a real token is checked for expiry FIRST ────────
 * A token that expired 90 minutes ago used to surface at the verification step,
 * after the change was already deployed. Refuse before doing any work. */
function assertTokenFresh(file) {
  if (!existsSync(file)) fail(`token file not found: ${file}\nPaste a fresh one: sign in, copy the access_token, save it there.`);
  const raw = readFileSync(file, 'utf8').trim();
  let p;
  try { p = JSON.parse(Buffer.from(raw.split('.')[1], 'base64url')); }
  catch { fail(`${file} does not look like a JWT.\nPaste a fresh one.`); }
  const leftMs = p.exp * 1000 - Date.now();
  if (leftMs <= 0) fail(`token in ${file} EXPIRED ${Math.round(-leftMs / 60000)} minutes ago (${p.email || p.sub}).\nPaste a fresh one — do not run the check against a dead session.`);
  if (leftMs < 120000) fail(`token in ${file} expires in ${Math.round(leftMs / 1000)}s — too little to finish a run.\nPaste a fresh one.`);
  console.log(`token: ${p.email || p.sub}, ${Math.round(leftMs / 60000)} min left\n`);
  return { raw, payload: p };
}
function fail(msg) { console.error('\nREFUSED: ' + msg); process.exit(2); }

/* ── the stub ───────────────────────────────────────────────────────────────
 * Installed via Page.addScriptToEvaluateOnNewDocument, so it is in place before
 * auth-guard.js runs. auth-guard calls window.supabase.createClient(), so owning
 * that one symbol owns the whole data layer.
 *
 * Every unknown table returns [] and every unknown function returns {} rather
 * than throwing: the harness is asserting on RENDERING, and a stub that throws
 * would produce console errors that the harness then reports as page failures —
 * turning gaps in the stub into false alarms about the page. */
function stubSource(role, email, stubRow) {
  return `(() => {
    const RES = (data) => Promise.resolve({ data, error: null });
    const q = () => { const t = RES([]);
      const h = { then: t.then.bind(t), catch: t.catch.bind(t), finally: t.finally.bind(t) };
      for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte',
                       'like','ilike','is','in','contains','order','limit','range','filter','not','or','match'])
        h[m] = () => h;
      /* .single() must hand back a plausible ROW, not null. Pages routinely bail
         out of rendering when their subject record is missing — which is correct
         behaviour, but it means a null here makes the harness assert against a
         page that deliberately stopped, and report a stub gap as a page defect. */
      const row = () => Object.assign({ id: '${FIXTURE}', contact_id: '${FIXTURE}',
        first_name: 'ZZ-TEST', last_name: 'Fixture Borrower',
        email: 'zz-test@example.com', pipeline_status: 'New Lead', created_at: new Date().toISOString() },
        ${JSON.stringify(stubRow || {})});
      h.single = () => RES(row()); h.maybeSingle = () => RES(row()); h.csv = () => RES('');
      return h; };
    const session = { access_token: 'stub', token_type: 'bearer', expires_at: Math.floor(Date.now()/1000)+3600,
      user: { id: '00000000-0000-4000-8000-00000000dead', email: ${JSON.stringify(email)},
              aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} } };
    const client = {
      auth: {
        getSession: () => RES({ session }), getUser: () => RES({ user: session.user }),
        signOut: () => RES(null), refreshSession: () => RES({ session }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
      },
      from: q, rpc: (n) => (n === 'current_app_role' ? RES(${JSON.stringify(role)}) : RES([])),
      functions: { invoke: () => RES({}) },
      storage: { from: () => ({ list: () => RES([]), createSignedUrl: () => RES({ signedUrl: '' }),
                                upload: () => RES({}), remove: () => RES([]) }) },
      channel: () => { const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => ch }; return ch; },
      removeChannel: () => {}, getChannels: () => [],
    };
    /* DEFINE, don't assign. This script runs at document-start, but the page then
       loads the real supabase-js via <script src>, which assigns window.supabase
       and would silently replace the stub — the harness then hits real PostgREST
       and reports the resulting errors as page defects. A non-writable property
       with a swallowing setter makes the stub survive the real library loading. */
    const pin = (k, v) => Object.defineProperty(window, k, {
      configurable: false, get: () => v, set: () => {},
    });
    pin('supabase', { createClient: () => client });
    pin('_supabaseClient', client);
    try { sessionStorage.setItem('rnr_app_role', ${JSON.stringify(role)}); } catch (_) {}
    window.__RC_STUB = true;
  })();`;
}

// ── specs ───────────────────────────────────────────────────────────────────
const SPECS = [
  {
    name: 'lead-detail tab order',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    // Inbox must sit between 1003 Application and Fee Sheet, as RENDERED.
    order: ['1003 Application', 'Inbox', 'Fee Sheet'],
    orderSel: '.ld-tab-btn',
    present: ['#tab-btn-application', '#tab-btn-inbox', '#tab-btn-fee-sheet', '.ld-tabs-nav'],
  },
  {
    name: 'lead-detail scoped inbox rail',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    // The tab mounts lazily, so click it by NAME first.
    steps: [{ click: '.ld-tab-btn[onclick*="\'inbox\'"]', waitMs: 3500 }],
    present: ['#tab-inbox .gm-rail-scoped', '#tab-inbox .gm-scope', '#tab-inbox .gm-search input'],
    // The whole point: the controls that cleared q must not exist to be clicked.
    absent: ['#tab-inbox [data-fd]', '#tab-inbox [data-ct]', '#tab-inbox .gm-compose'],
  },
  {
    /* Shelley Hurle's real stored values, fed through the stub. This proves the
     * BINDING (contacts.address → #f-home-address) renders them; that the row
     * exists is proven separately by SQL. The stub cannot prove both at once —
     * see the boundary note. */
    name: 'lead-detail home address field (Shelley Hurle values)',
    url: `/admin/lead-detail?contact_id=68a22836-243b-443e-935d-29ba5bb7cbe1`,
    role: 'admin',
    stubRow: { address: '1742 West Avenue L', city: 'Lancaster', state: 'CA', zip: '93534',
               first_name: 'Shelley', last_name: 'Hurle', property_address: '' },
    present: ['#f-home-address', '#f-home-city', '#f-home-state', '#f-home-zip', '#lpHomeEstBtn'],
    values: {
      '#f-home-address': '1742 West Avenue L',
      '#f-home-city': 'Lancaster',
      '#f-home-state': 'CA',
      '#f-home-zip': '93534',
      // Address present → the button offers to price it.
      '#lpHomeEstBtn': 'Get home estimate',
      // property_address is an EMPTY STRING on this record. It must read as
      // absent, or the estimate button offers to price nothing.
      '#lpPropEstBtn': 'Enter a property address first',
    },
  },
  {
    name: 'settings page renders',
    url: '/admin/settings',
    role: 'admin',
    present: ['body'],
    // The outage this harness exists for: a SyntaxError left the page blank.
    // Assert real content, not just that the document exists.
    minVisibleText: 200,
  },
  {
    name: 'inbox page is NOT scoped (whole mailbox is the product there)',
    url: '/admin/inbox',
    role: 'admin',
    steps: [{ waitMs: 2500 }],
    present: ['.gm-rail', '[data-fd="INBOX"]'],
    absent: ['.gm-rail-scoped'],
  },
];

// ── CDP plumbing ────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function chromePath() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  fail('no Chromium/Chrome/Edge binary found. Tried:\n  ' + CHROME_CANDIDATES.join('\n  '));
}

async function newBrowser(port, profileDir) {
  const proc = spawn(chromePath(), [
    '--headless=new', `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch (_) { /* not listening yet */ }
    await sleep(250);
  }
  if (!target) { proc.kill(); fail('browser never exposed a debuggable page target'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp connect failed')); });

  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method) events.push(m);
  };
  const send = (method, params = {}) => {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method, params }));
    return new Promise((res, rej) => {
      pending.set(mid, res);
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(method + ' timed out')); } }, 30000);
    });
  };
  return { proc, send, events, close: () => { try { ws.close(); } catch (_) {} proc.kill(); } };
}

async function runSpec(spec, opts) {
  const port = 9400 + opts.index;
  const profile = `${opts.tmp}/rc-${opts.index}`;
  const b = await newBrowser(port, profile);
  const problems = [];
  const notes = [];

  try {
    await b.send('Page.enable');
    await b.send('Runtime.enable');
    await b.send('Log.enable').catch(() => {});

    if (opts.token) {
      // Real-session mode: seed the token supabase-js would have stored.
      await b.send('Page.addScriptToEvaluateOnNewDocument', { source:
        `try{localStorage.setItem('sb-ljywhvbmsibwnssxpesh-auth-token', ${JSON.stringify(JSON.stringify({
          access_token: opts.token.raw, token_type: 'bearer', expires_at: opts.token.payload.exp,
          refresh_token: 'render-check', user: { id: opts.token.payload.sub, email: opts.token.payload.email },
        }))});}catch(e){}` });
    } else {
      await b.send('Page.addScriptToEvaluateOnNewDocument', {
        source: stubSource(spec.role || 'admin', 'render-check@local', spec.stubRow),
      });
    }

    const url = spec.url.startsWith('file://') || spec.url.startsWith('http') ? spec.url : BASE + spec.url;
    await b.send('Page.navigate', { url });

    // Wait for the document to actually finish, and FAIL rather than assume.
    let ready = '';
    for (let i = 0; i < 60; i++) {
      const r = await b.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }).catch(() => null);
      ready = r && r.result && r.result.result ? r.result.result.value : '';
      if (ready === 'complete') break;
      await sleep(400);
    }
    if (ready !== 'complete') problems.push(`page never reached readyState=complete (stuck at "${ready}")`);
    await sleep(spec.settleMs || 2500);

    for (const step of spec.steps || []) {
      if (step.click) {
        const r = await b.send('Runtime.evaluate', {
          expression: `(()=>{const e=document.querySelector(${JSON.stringify(step.click)});if(!e)return 'MISSING';e.click();return 'ok';})()`,
          returnByValue: true,
        });
        const v = r.result.result.value;
        if (v === 'MISSING') problems.push(`step: nothing matched ${step.click} to click`);
      }
      await sleep(step.waitMs || 1500);
    }

    // ── assertions ──────────────────────────────────────────────────────────
    const probe = await b.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const vis = (s) => { const e = document.querySelector(s); return !!e && (e.offsetParent !== null || e === document.body); };
        const has = (s) => !!document.querySelector(s);
        return {
          present: ${JSON.stringify(spec.present || [])}.map(s => [s, has(s), vis(s)]),
          absent:  ${JSON.stringify(spec.absent || [])}.map(s => [s, has(s)]),
          order:   Array.from(document.querySelectorAll(${JSON.stringify(spec.orderSel || 'nothing')}))
                        .map(e => (e.textContent || '').trim()),
          values:  Object.entries(${JSON.stringify(spec.values || {})}).map(([sel, want]) => {
                     const e = document.querySelector(sel);
                     // <button> HAS a .value property (empty by default), so keying
                     // on "value in e" reads buttons as blank. Gate on tag instead.
                     const isField = e && /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName);
                     return [sel, want, e ? (isField ? e.value : (e.textContent || '')) : '(no element)'];
                   }),
          textLen: (document.body ? (document.body.innerText || '').trim().length : 0),
          title:   document.title,
        };
      })()`,
    });
    const p = probe.result.result.value;

    for (const [sel, exists] of p.present) if (!exists) problems.push(`expected element ABSENT: ${sel}`);
    for (const [sel, exists] of p.absent) if (exists) problems.push(`element that must NOT exist is present: ${sel}`);
    for (const [sel, want, got] of p.values || []) {
      if (String(got).trim() !== String(want)) problems.push(`${sel} rendered "${got}", expected "${want}"`);
      else notes.push(`${sel} = "${got}"`);
    }

    if (spec.order) {
      const idx = spec.order.map((label) => p.order.findIndex((t) => t.includes(label)));
      const missing = spec.order.filter((_, i) => idx[i] < 0);
      if (missing.length) problems.push(`tab(s) not rendered at all: ${missing.join(', ')}`);
      else {
        const sorted = idx.every((v, i) => i === 0 || idx[i - 1] < v);
        const consecutive = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
        if (!sorted || !consecutive) {
          problems.push(`tab order wrong — got [${p.order.join(' | ')}]`);
        } else notes.push(`order ok: ${spec.order.map((l, i) => `${idx[i] + 1}.${l}`).join('  ')}`);
      }
    }
    if (spec.minVisibleText && p.textLen < spec.minVisibleText) {
      problems.push(`page rendered only ${p.textLen} chars of visible text (need ≥ ${spec.minVisibleText}) — this is the blank-page signature`);
    }
    if (p.textLen) notes.push(`visible text: ${p.textLen} chars · title "${p.title}"`);

    // ── failures the page itself reported ───────────────────────────────────
    for (const ev of b.events) {
      if (ev.method === 'Runtime.exceptionThrown') {
        const d = ev.params.exceptionDetails;
        const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown';
        problems.push('UNCAUGHT: ' + String(desc).split('\n')[0]);
      }
      if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
        const txt = (ev.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        const allowed = (spec.allowConsole || []).find((s) => txt.includes(s));
        if (allowed) notes.push(`console error ALLOWED by spec ("${allowed}"): ${txt.slice(0, 110)}`);
        else problems.push('CONSOLE ERROR: ' + txt.slice(0, 160));
      }
    }
  } catch (e) {
    problems.push('harness error: ' + e.message);
  } finally {
    b.close();
  }
  return { problems, notes };
}

// ── main ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (f) => { const i = argv.indexOf(f); return i < 0 ? null : argv[i + 1]; };
const tokenFile = argOf('--token');
const token = tokenFile ? assertTokenFresh(tokenFile) : null;

let specs;
const adhocUrl = argOf('--url');
if (adhocUrl) {
  specs = [{
    name: 'ad-hoc: ' + adhocUrl, url: adhocUrl, role: 'admin',
    present: argv.filter((a, i) => argv[i - 1] === '--expect'),
    minVisibleText: argOf('--min-text') ? Number(argOf('--min-text')) : 0,
  }];
} else {
  const filter = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--token')[0];
  specs = filter ? SPECS.filter((s) => s.name.includes(filter)) : SPECS;
  if (!specs.length) fail(`no spec matching "${filter}". Known: ${SPECS.map((s) => s.name).join(' | ')}`);
}

const tmp = process.env.TEMP || process.env.TMPDIR || '.';
console.log(`render-check — ${specs.length} page(s) against ${BASE}`);
console.log(token ? 'mode: REAL SESSION\n' : 'mode: STUBBED CLIENT (no credentials, no session row)\n');

let failed = 0;
for (let i = 0; i < specs.length; i++) {
  const s = specs[i];
  process.stdout.write(`  ${s.name} … `);
  const { problems, notes } = await runSpec(s, { index: i, tmp, token });
  if (problems.length) {
    failed++;
    console.log('FAIL');
    for (const pr of problems) console.log(`      ✗ ${pr}`);
  } else {
    console.log('pass');
  }
  for (const n of notes) console.log(`      · ${n}`);
}

console.log('\n' + BOUNDARY.join('\n'));
console.log(`\n${specs.length - failed}/${specs.length} page(s) rendered clean.`);
if (failed) { console.log(`${failed} FAILED.`); process.exit(1); }
