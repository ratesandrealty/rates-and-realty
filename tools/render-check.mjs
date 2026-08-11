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

/* The boundary DIFFERS BY MODE. Printing the stubbed one during a real-session
   run is the same defect this file exists to catch: it understates what the run
   proved AND misdescribes what it did. */
const BOUNDARY_REAL = [
  'WHAT THIS RUN PROVES : the page renders AND a REAL session was used — RLS,',
  '                       column grants and in-function role checks were all',
  '                       exercised as this user.',
  'WHAT IT DOES NOT     : anything about OTHER roles. A pass as an admin says',
  '                       nothing about what a va or agent would receive; that',
  '                       needs a token for that role.',
];
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
function stubSource(role, email, stubRow, rpcMap, fetchMap, rpcFns, staleRole, invokeMap, tableMap) {
  const fnsSrc = '{' + Object.entries(rpcFns || {})
    .map(([k, src]) => `${JSON.stringify(k)}: (${src})`).join(',') + '}';
  return `(() => {
    /* Declared before anything else can call an edge function, and never
       re-created: this array is the record a spec asserts a click against. */
    try { if (!window.__RC_CALLS) window.__RC_CALLS = []; } catch (_) {}
    const RES = (data) => Promise.resolve({ data, error: null });
    const RPC_STATE = {};
    const RPC_FNS = ${fnsSrc};
    /* TABLE ROWS, keyed by the .from() name (spec.tables). Unknown tables still
       answer [], so no page depends on the harness knowing all of them.
       Without this only the REFUSING direction of a gate can be tested: the
       e-sign Send button needs a signature_templates row to become enabled, and
       a spec that can only ever see the disabled state proves half a control.
       Same reason absent-assertions here are paired with present-assertions. */
    const TABLES = ${JSON.stringify(tableMap || {})};
    const q = (tbl) => { const t = RES(Object.prototype.hasOwnProperty.call(TABLES, tbl) ? TABLES[tbl] : []);
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
      /* Named RPC responses, so a page whose whole content comes from one RPC can
         be asserted on. Unnamed RPCs still return [] — a page must not depend on
         the harness knowing every call it makes. */
      from: q,
      /* STATEFUL RPCs (spec.rpcFns). A fixed response per name cannot express
         write-then-read: click Send, the page calls staff_message_send and then
         re-fetches staff_thread_messages, and a constant reply hands back the
         list from BEFORE the send — wiping the message the page correctly
         rendered. The harness then reports a working page as broken, which is
         the stub-under-delivers failure this file has already hit twice.
         Each entry is (args, state) => data, sharing one mutable state object,
         so a spec can model the write its assertion depends on. */
      rpc: (n, args) => (n === 'current_app_role' ? RES(${JSON.stringify(role)})
                 : (Object.prototype.hasOwnProperty.call(RPC_FNS, n)
                    ? RES(RPC_FNS[n](args || {}, RPC_STATE))
                 : (Object.prototype.hasOwnProperty.call(${JSON.stringify(rpcMap || {})}, n)
                    ? RES(${JSON.stringify(rpcMap || {})}[n]) : RES([])))),
      /* EDGE-FUNCTION CALLS ARE RECORDED, not just answered.
         A Send button that "does nothing" fails no presence assertion: the
         button is there, the modal is there, the page is not blank. The only
         thing that distinguishes a live Send from a dead one is whether it
         reached the network — so every functions.invoke is appended to
         window.__RC_CALLS, which a spec asserts on via calls[]. Without this the
         harness can prove a Send button EXISTS and nothing more, which is the
         presence-only shape this file already exists to reject.
         spec.invoke supplies the response body per function name; anything
         unnamed still answers {} so a page cannot depend on the harness knowing
         every function it calls. */
      functions: { invoke: (name, opts) => {
        try { window.__RC_CALLS.push({ fn: name, body: (opts && opts.body) || null }); } catch (_) {}
        const IM = ${JSON.stringify(invokeMap || {})};
        return RES(Object.prototype.hasOwnProperty.call(IM, name) ? IM[name] : {});
      } },
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
    /* ROLE CACHE SEEDING.
       auth-guard caches the role keyed on the uid it was fetched for, so the
       harness seeds BOTH — otherwise every spec would exercise the cache-MISS
       path and never the hit path real page loads take.

       spec.staleRole seeds the opposite: a role left behind by a DIFFERENT user,
       which is what same-tab "View as" produces. The uid deliberately does not
       match the stub session, so a correct guard must discard it and re-read. */
    /* SEED ONCE PER TAB, NOT ONCE PER DOCUMENT.
       This script is installed with Page.addScriptToEvaluateOnNewDocument, which
       fires for EVERY document — measured at 7 per lead-detail load, because the
       page mounts iframes. Re-seeding on each one overwrites sessionStorage
       AFTER auth-guard has already resolved the role, so a correctly-working
       guard reads back as if it had never run. That cost a real debugging
       detour: the fix was live and verified in the shipped bytes while this
       harness insisted the bug was still there.
       Same family as the two stub defects documented in CLAUDE.md — a stub that
       under-delivers reads as a broken page; one that over-writes reads as an
       unfixed bug. */
    try {
      if (sessionStorage.getItem('rnr_rc_seeded')) throw 0;
      sessionStorage.setItem('rnr_rc_seeded', '1');
      const STALE = ${JSON.stringify(staleRole || null)};
      /* A record of what was PLANTED, under a key the guard never touches.
         Without it the staleRole spec can pass vacuously: if the seed silently
         failed, the guard would find no cached role, fetch 'va' anyway, and the
         assertions would all hold having tested nothing. Asserting on this
         proves the stale role really was there to be discarded. */
      sessionStorage.setItem('rnr_rc_seeded_role', STALE || ${JSON.stringify(role)});
      if (STALE) {
        sessionStorage.setItem('rnr_app_role', STALE);
        sessionStorage.setItem('rnr_app_role_uid', '00000000-0000-4000-8000-0000000ad311');
      } else {
        sessionStorage.setItem('rnr_app_role', ${JSON.stringify(role)});
        sessionStorage.setItem('rnr_app_role_uid', session.user.id);
      }
    } catch (_) {}
    /* RAW-FETCH STUBBING. Some pages call an edge function with fetch() rather
       than through the supabase client, so owning window.supabase is not enough
       to control what they see. Each entry maps a URL substring to a status and
       body — which is how a 403-vs-200 difference can be exercised without a
       real session for each role. */
    const FETCH_MAP = ${JSON.stringify(fetchMap || [])};
    /* ALWAYS installed, even with an empty FETCH_MAP, because the wrapper does
       two jobs now. Some pages bypass the supabase client and POST an edge
       function with raw fetch (_esignSubmit does), so recording only
       functions.invoke would leave exactly those Send buttons unobservable —
       and they are the ones being asserted on. Edge-function URLs are appended
       to the SAME __RC_CALLS list, so a spec asserts "this fired" without
       caring which transport the page happened to use. */
    {
      const realFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const hit = url.indexOf('/functions/v1/');
        if (hit >= 0) {
          let body = null;
          try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) { body = null; }
          try { window.__RC_CALLS.push({ fn: url.slice(hit + 14).split('?')[0], body: body }); } catch (_) {}
        }
        for (const m of FETCH_MAP) {
          if (url.includes(m.match)) {
            return Promise.resolve(new Response(
              typeof m.body === 'string' ? m.body : JSON.stringify(m.body === undefined ? {} : m.body),
              { status: m.status || 200, headers: { 'Content-Type': 'application/json' } }));
          }
        }
        return realFetch(input, init);
      };
    }
    window.__RC_STUB = true;
  })();`;
}

// ── specs ───────────────────────────────────────────────────────────────────
const SPECS = [
  /* The pipeline strip renders nine stages into whatever width the header row
     has left over. Rene saw "Ne[Cnt]loweAntrProcTClose,os" — nine labels each
     cut mid-word. Checked at two widths because the failure is width-dependent
     and a single width proves only that width. */
  {
    name: 'pipeline strip legible @1440',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin', width: 1440,
    present: ['#pipelineTimeline'],
    noClip: ['#pipelineTimeline > *'],
    /* Google logs "included multiple times" when its bootstrap runs twice.
       Counting the tags says whether that is a second <script> or something
       else — a warning alone does not. */
    rowCount: { selector: 'script[src*="maps.googleapis.com/maps/api/js"]', expect: 1 },
  },
  {
    name: 'pipeline strip legible @1100',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin', width: 1100,
    present: ['#pipelineTimeline'],
    noClip: ['#pipelineTimeline > *'],
  },
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
    // Scope is now a CHOICE. Both offers must be on the page, not just the mode.
    expectText: ['This borrower', 'Full mailbox'],
  },
  {
    /* A masked address cannot be searched for, but a TAG is a stored thread_id
       and needs no address. So the va keeps the narrow view and is told which
       half of it is unavailable — rather than landing in the whole mailbox. */
    name: 'lead-detail inbox as va with a masked address — tags only',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'va',
    stubRow: { email: 'b9f2c1@masked.local', secondary_email: null,
               first_name: 'ZZ-TEST', last_name: 'Fixture Borrower', property_address: '' },
    rpc: { lead_email_threads: [] },
    steps: [{ click: '.ld-tab-btn[onclick*="\'inbox\'"]', waitMs: 3500 }],
    expectText: ['Showing tagged threads only', 'This borrower', 'Full mailbox'],
    // The supersede: the whole mailbox must NOT mount itself under this lead.
    absent: ['#tab-inbox .gm-inbox'],
  },
  {
    /* The toggle has to SWITCH, not merely render. Clicking Full mailbox must
       mount the unscoped component and bring back the folder rail that scoped
       mode removes — asserting on the text alone would pass on a dead button. */
    name: 'lead-detail inbox toggle actually switches to full mailbox',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    steps: [
      { click: '.ld-tab-btn[onclick*="\'inbox\'"]', waitMs: 3000 },
      { click: '#lpInboxScopeBar button[onclick*="\'full\'"]', waitMs: 3500 },
    ],
    present: ['#tab-inbox .gm-inbox', '#tab-inbox [data-fd]'],
    absent: ['#tab-inbox .gm-rail-scoped'],
    expectText: ['not necessarily about this borrower'],
  },
  {
    /* ── "SEND FOR SIGNATURE" ACTUALLY SENDS ────────────────────────────────
     * Reported dead on BOTH the LOE composer and the E-Signature Status panel:
     * no toast, no console error, no network call. Nothing was broken about
     * either click. Two separate causes wearing the same silhouette:
     *
     *   1. Every toast raised from inside a modal was painted BEHIND it —
     *      .ld-toast was z-index:1000 against overlays at 20000–2147483000. So
     *      loeSendNow()'s own "The letter is empty" refusal was invisible, and
     *      a working guard read as a dead button.
     *   2. #esignSubmitBtn really was disabled, gated on signers with nothing
     *      on screen saying so — and gated on the wrong condition, since
     *      _esignSubmit needs a template document too.
     *
     * These specs assert on the SEND, not on the button. #loeSendBtn is
     * present, enabled and correctly labelled on a page where clicking it does
     * nothing — the #shell-present-and-empty shape again. Only calls[]
     * separates the two, which is why the stub records edge-function calls. */
    name: 'LOE composer Send actually sends',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    /* Mirrors what the real RPC returns for this fixture, checked against
       production: one row, primary borrower, person_contact_id SET — so the
       checkbox is pre-checked and carries a non-empty value. Two of
       esign_signer_suggestions' six branches return null::uuid there, and a
       null renders a checkbox that looks checkable and is silently dropped by
       _loeSelectedSigners; a stub that always supplied an id would hide that. */
    rpc: {
      esign_signer_suggestions: [
        { name: 'ZZ-TEST Fixture Borrower', email: 'zz-test.fixture@example.invalid',
          role: 'borrower', source: 'Primary borrower', person_contact_id: FIXTURE },
      ],
      loe_save: FIXTURE,
    },
    steps: [
      { click: 'button[onclick="loeOpenEditor(null)"]', waitMs: 2500 },
      { fill: '#loeBody', value: 'RC-LOE-PROBE letter body', waitMs: 300 },
      { click: '#loeSendBtn', waitMs: 3000 },
    ],
    // THE assertion. Not "the button exists" — "loe-send was invoked".
    calls: ['loe-send'],
    // A successful send closes the editor. Paired with calls[] so neither can
    // pass vacuously: an editor that never opened would also be absent here.
    absent: ['#loeEditorOverlay'],
  },
  {
    /* The refusal path, which is the half that was invisible. Same composer,
     * NO letter body — so loeSendNow must stop at its own guard, must NOT
     * reach the network, and must put its message where it can be READ. */
    name: 'LOE composer Send refuses an empty letter, VISIBLY',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    rpc: {
      esign_signer_suggestions: [
        { name: 'ZZ-TEST Fixture Borrower', email: 'zz-test.fixture@example.invalid',
          role: 'borrower', source: 'Primary borrower', person_contact_id: FIXTURE },
      ],
    },
    steps: [
      { click: 'button[onclick="loeOpenEditor(null)"]', waitMs: 2500 },
      { click: '#loeSendBtn', waitMs: 1500 },
    ],
    callsAbsent: ['loe-send'],
    present: ['#loeEditorOverlay'],
    /* THE ORIGINAL BUG, AS GEOMETRY RATHER THAN TEXT. The toast element was
       always in the DOM with the right words in it — an innerText assertion
       passed all along and would pass on the broken page today. What failed is
       that the modal was painted over it, so the assertion has to be "what is
       actually at the toast's own coordinates". Same lesson as the #shell
       break test: presence was never the thing in doubt. */
    evals: [
      ['document.getElementById("ld-toast").textContent',
       'The letter is empty — draft it first.'],
      /* STACKING, not hit-testing. elementFromPoint was the obvious way to ask
         "what is on top here" and it is USELESS for this: the toast is
         pointer-events:none, so hit testing skips it and returns the overlay
         underneath — the assertion failed identically on the fixed page and
         the broken one. Compare painted order instead: every positioned body
         child covering the toast's centre must have a LOWER z-index than the
         toast. Verified to still fail at the old z-index:1000. */
      ['(function(){'
        + 'var t=document.getElementById("ld-toast"),r=t.getBoundingClientRect();'
        + 'var cx=r.left+r.width/2,cy=r.top+r.height/2;'
        + 'var tz=parseInt(getComputedStyle(t).zIndex,10)||0;'
        + 'var bad=Array.prototype.slice.call(document.querySelectorAll("body > *")).filter(function(e){'
        + 'if(e===t||t.contains(e))return false;var s=getComputedStyle(e);'
        + 'if(s.display==="none"||s.visibility==="hidden"||s.position==="static")return false;'
        + 'var b=e.getBoundingClientRect();'
        + 'if(!(b.left<=cx&&b.right>=cx&&b.top<=cy&&b.bottom>=cy))return false;'
        + 'return (parseInt(s.zIndex,10)||0)>=tz;'
        + '}).map(function(e){return (e.id||e.tagName)+":"+getComputedStyle(e).zIndex;});'
        + 'return bad.length?"COVERED BY "+bad.join(", "):"toast on top";})()',
       'toast on top'],
    ],
  },
  {
    /* The e-sign workspace's Send is legitimately disabled with no signer, and
     * that is fine — what was not fine is that it said nothing, so a refusal
     * and a dead button looked identical. Assert the reason is ON SCREEN and
     * that the click really does stay inert. */
    name: 'e-sign Send says WHY it is disabled',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    steps: [
      { click: 'button[onclick="openEsignSendModal()"]', waitMs: 3000 },
      { click: '#esignSubmitBtn', waitMs: 1500 },
    ],
    present: ['#esignSendOverlay', '#esignSubmitBtn', '#esignSendNote'],
    callsAbsent: ['esign'],
    evals: [
      ['String(document.getElementById("esignSubmitBtn").disabled)', 'true'],
      // VISIBLE, not merely populated — the whole failure was invisible text.
      ['getComputedStyle(document.getElementById("esignSendNote")).display !== "none"', true],
      /* Both halves are missing HERE because the stub answers signature_templates
         from .from(), which always returns [] and is not spec-controllable — so
         there is no template either. That is why the expected string names a
         document as well as a signer. On production, where templates exist, the
         same code path yields the signer-only sentence. The assertion that
         matters is identical in both: the button names what is missing instead
         of being silently inert. */
      ['document.getElementById("esignSendNote").textContent',
       'Add a document and at least one signer to send.'],
    ],
  },
  {
    /* THE OTHER DIRECTION, and it is not optional. Making a button explain why
     * it is disabled is only half a change — the half that is easy to get
     * wrong is leaving it disabled when it should not be, which would turn a
     * confusing button into an unusable one and look like the same bug. The
     * gate now reads two conditions instead of one, so both have to be shown
     * satisfiable together, ending in an actual send. */
    name: 'e-sign Send enables and sends once a doc and signer exist',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    tables: {
      signature_templates: [{ key: 'loe', name: 'Letter of Explanation' }],
    },
    // _esignSubmit POSTs esign with raw fetch, so the response comes from here
    // rather than from invoke[]; the call itself is still recorded.
    fetchMap: [{ match: '/functions/v1/esign', status: 200, body: { signers: [] } }],
    /* THE TEMPLATE IS NOT ADDED VIA "+ Add", DELIBERATELY. That button
       auto-previews the template, which itself POSTs esign
       (action:'template_preview') — so calls:['esign'] below would pass
       without any send having happened, which is precisely the vacuous
       assertion these specs exist to avoid. Selecting the template instead
       leaves the submit as the only thing that can produce an esign call, and
       _esignSubmit falls back to the select's value exactly as the gate does. */
    steps: [
      { click: 'button[onclick="openEsignSendModal()"]', waitMs: 3000 },
      { fill: '#esignManualName', value: 'ZZ-TEST Fixture Borrower', waitMs: 150 },
      { fill: '#esignManualEmail', value: 'zz-test.fixture@example.invalid', waitMs: 150 },
      { click: 'button[onclick="_esignAddManual()"]', waitMs: 1200 },
      { click: '#esignSubmitBtn', waitMs: 2500 },
    ],
    calls: ['esign'],
    // A send that reached the network closes the workspace.
    absent: ['#esignSendOverlay'],
  },
  {
    /* THE RECORDING CHOICE IS REACHABLE FROM THE DIAL PAD.
     * Rene dialled from the pad, recording started on its own, and the only
     * control on screen was the read-only live badge. The toggle was not
     * missing — renderReady() has always rendered it — but the pad's go()
     * reopens the modal and clicks Call in the same tick, so it was mounted and
     * replaced by the badge before anyone could touch it.
     *
     * The second assertion is the one that would catch a lazy fix. The obvious
     * way to add the toggle here is to reuse wireRecToggle() as-is, whose click
     * handler calls renderReady() — which repaints the whole action area and
     * takes the pad, and the number typed into it, with it. So the spec types a
     * number, toggles recording, and requires the number to still be there. */
    name: 'dial pad offers the recording choice BEFORE dialling',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    steps: [
      { click: '#rr-dial-fab', waitMs: 1200 },
      // 714-555-0142: real timezone, NANPA-reserved fictional exchange.
      { fill: '#cmPadNum', value: '7145550142', waitMs: 200 },
      { click: '#cmRecToggle', waitMs: 800 },
    ],
    present: ['#cmPadNum', '#cmPadDial', '#cmRecToggle'],
    // Toggled OFF, and the consequence is spelled out rather than implied.
    expectText: ['Recording off', 'No announcement, no transcript, no AI summary.'],
    // The pad survived the toggle. Without the rerender parameter this is ''.
    values: { '#cmPadNum': '7145550142' },
  },
  {
    /* "CREATE FOLDER" DISAPPEARING IS GUARD 2 WORKING, and it read as a bug
     * because the control simply swapped itself for a different one. The server
     * refuses to create a second folder — the first has borrower documents in
     * it and a duplicate would strand them — but nothing on screen said so.
     * A refusal and a breakage must not look alike. */
    name: 'Create Folder does not silently vanish when a folder exists',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    stubRow: {
      gdrive_folder_id: 'RC-FOLDER-ID',
      gdrive_folder_url: 'https://drive.google.com/drive/folders/RC-FOLDER-ID',
    },
    present: ['#driveFolderBtn', '#driveFolderBtnLabel'],
    // Names the STATE, not just the action it happens to offer.
    values: { '#driveFolderBtnLabel': '📁 Drive folder ✓' },
    evals: [
      ['document.getElementById("driveFolderBtn").title.includes("already HAS a Drive folder")', true],
      // The sentence that answers Rene's actual question.
      ['document.getElementById("driveFolderBtn").title.includes("that is not a missing button")', true],
    ],
  },
  {
    /* MULTI-LOE. loe-send has carried action:'send_package' with loe_ids[] and
     * nothing called it, so three letters meant three envelopes and the
     * borrower signed three times for one loan condition.
     *
     * Three drafted letters: two share a signer set, the third does not. The
     * spec picks the two, and asserts BOTH halves of the design —
     *   · send_package fired with exactly those two loe_ids (calls[] + body), and
     *   · the odd-signer letter was DISABLED rather than silently accepted.
     * The second is the one worth having. The server refuses mixed signer sets,
     * so a picker that lets you select them is not broken until you send, and
     * then it is an error message instead of a rule you could see. */
    name: 'multi-LOE package sends several letters as one envelope',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    rpc: {
      esign_signer_suggestions: [
        { name: 'ZZ-TEST Fixture Borrower', email: 'zz-test.fixture@example.invalid',
          role: 'borrower', source: 'Primary borrower', person_contact_id: FIXTURE },
      ],
      loe_list_for_lead: [
        { id: 'aaaaaaaa-0000-4000-8000-000000000001', contact_id: FIXTURE, status: 'drafted',
          category: 'large_deposit', title: 'Large deposit March', body: 'Letter one body',
          signer_contact_ids: [FIXTURE], created_at: '2026-08-11T10:00:00Z' },
        { id: 'aaaaaaaa-0000-4000-8000-000000000002', contact_id: FIXTURE, status: 'drafted',
          category: 'credit_inquiry', title: 'Credit inquiry April', body: 'Letter two body',
          signer_contact_ids: [FIXTURE], created_at: '2026-08-11T09:00:00Z' },
        /* Different signer set — the server would refuse this in the same
           package, so the picker must not offer it alongside the other two. */
        { id: 'aaaaaaaa-0000-4000-8000-000000000003', contact_id: FIXTURE, status: 'drafted',
          category: 'employment_gap', title: 'Joint letter with co-borrower', body: 'Letter three body',
          signer_contact_ids: [FIXTURE, '11111111-1111-4111-8111-111111111111'],
          created_at: '2026-08-11T08:00:00Z' },
      ],
    },
    steps: [
      { click: '#tab-btn-processing', waitMs: 3000 },
      { click: '#loePackageBtn', waitMs: 2000 },
      { click: '.loe-pkg-cb[value="aaaaaaaa-0000-4000-8000-000000000001"]', waitMs: 400 },
      { click: '.loe-pkg-cb[value="aaaaaaaa-0000-4000-8000-000000000002"]', waitMs: 400 },
      { click: '#loePkgSendBtn', waitMs: 2500 },
    ],
    calls: ['loe-send'],
    absent: ['#loePkgOverlay'],
    evals: [
      // Exactly the two same-signer letters, and the package action.
      ['(function(){var c=(window.__RC_CALLS||[]).filter(function(x){return x.fn==="loe-send";}).pop();'
        + 'return c&&c.body?c.body.action+":"+(c.body.loe_ids||[]).length:"(no call)";})()',
       'send_package:2'],
      ['(function(){var c=(window.__RC_CALLS||[]).filter(function(x){return x.fn==="loe-send";}).pop();'
        + 'return c&&c.body&&(c.body.loe_ids||[]).indexOf("aaaaaaaa-0000-4000-8000-000000000003")>=0;})()',
       false],
    ],
  },
  {
    /* The lock itself, asserted before the send rather than through it. Same
     * three letters; pick ONE, and the odd-signer row must go disabled while
     * its same-signer sibling stays selectable. Without this the spec above
     * would still pass on a picker that simply happened not to be clicked. */
    name: 'multi-LOE picker locks to one signer set',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    rpc: {
      esign_signer_suggestions: [
        { name: 'ZZ-TEST Fixture Borrower', email: 'zz-test.fixture@example.invalid',
          role: 'borrower', source: 'Primary borrower', person_contact_id: FIXTURE },
      ],
      loe_list_for_lead: [
        { id: 'aaaaaaaa-0000-4000-8000-000000000001', contact_id: FIXTURE, status: 'drafted',
          category: 'large_deposit', title: 'Large deposit March', body: 'Letter one body',
          signer_contact_ids: [FIXTURE], created_at: '2026-08-11T10:00:00Z' },
        { id: 'aaaaaaaa-0000-4000-8000-000000000002', contact_id: FIXTURE, status: 'drafted',
          category: 'credit_inquiry', title: 'Credit inquiry April', body: 'Letter two body',
          signer_contact_ids: [FIXTURE], created_at: '2026-08-11T09:00:00Z' },
        { id: 'aaaaaaaa-0000-4000-8000-000000000003', contact_id: FIXTURE, status: 'drafted',
          category: 'employment_gap', title: 'Joint letter with co-borrower', body: 'Letter three body',
          signer_contact_ids: [FIXTURE, '11111111-1111-4111-8111-111111111111'],
          created_at: '2026-08-11T08:00:00Z' },
      ],
    },
    steps: [
      { click: '#tab-btn-processing', waitMs: 3000 },
      { click: '#loePackageBtn', waitMs: 2000 },
      { click: '.loe-pkg-cb[value="aaaaaaaa-0000-4000-8000-000000000001"]', waitMs: 500 },
    ],
    // Nothing sent — this spec is entirely about what the picker allows.
    callsAbsent: ['loe-send'],
    evals: [
      ['document.querySelector(\'.loe-pkg-cb[value="aaaaaaaa-0000-4000-8000-000000000003"]\').disabled', true],
      ['document.querySelector(\'.loe-pkg-cb[value="aaaaaaaa-0000-4000-8000-000000000002"]\').disabled', false],
      // Send stays refused at one letter — that is the row button's job.
      ['document.getElementById("loePkgSendBtn").disabled', true],
    ],
    expectText: ['different signers'],
  },
  /* ── EMPTY SEARCH TELLS THE TRUTH ─────────────────────────────────────────
   * The reported bug: searching SC-27335-BU in Full mailbox said "Nothing in
   * Inbox" while that thread was visible in the same lead's filed list. The
   * search was not broken — every thread carrying that number is in rene@ and
   * the panel was searching processing@. Two separate lies made it unreadable:
   * the empty state named neither the query nor the mailbox, and the banner
   * went on describing the toggle rather than the search.
   *
   * The stub returns no threads for any list_threads, so every search is empty
   * here — which is exactly the state under test. Run for BOTH roles: an admin
   * has two mailboxes and must be told the other was not searched; a va has one
   * and must not be offered a mailbox the server would refuse her. */
  ...['admin', 'va'].map((r) => ({
    name: `empty search names the query and the mailbox (${r})`,
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: r,
    steps: [
      { click: '.ld-tab-btn[onclick*="\'inbox\'"]', waitMs: 3000 },
      { click: '#lpInboxScopeBar button[onclick*="\'full\'"]', waitMs: 3000 },
      { fill: '#tab-inbox .gm-search input', value: 'SC-27335-BU' },
      { click: '#tab-inbox [data-gm="go"]', waitMs: 3500 },
    ],
    // The query and the searched mailbox both named, and the Inbox-only claim gone.
    expectText: ['No matches for', 'SC-27335-BU', 'whole mailbox'],
    absentText: ['Nothing in Inbox'],
    evals: [
      // The banner describes the SEARCH, not the toggle. This is the exact
      // sentence Rene saw while a query was active and returning nothing.
      ["!/Showing the whole/.test(document.getElementById('lpInboxNote').innerText)", true],
      ["/Showing .*result/.test(document.getElementById('lpInboxNote').innerText)", true],
    ],
  })),
  {
    /* ISOLATION REGRESSION TEST — must stay immediately after the toggle spec.
     * The toggle persists the choice to localStorage, so this spec sees the
     * scoped rail only if the previous spec's "full" did NOT survive into it.
     * That is the whole promise of one-incognito-context-per-spec; without a
     * spec that would FAIL on a leak, the promise is untested and a shared
     * profile would quietly change what every later spec measures.
     * If this starts failing, suspect the harness before the page. */
    name: 'scope choice does NOT leak between specs (context isolation)',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    steps: [{ click: '.ld-tab-btn[onclick*="\'inbox\'"]', waitMs: 3000 }],
    present: ['#tab-inbox .gm-rail-scoped'],
    absent: ['#tab-inbox [data-fd]'],
  },
  {
    /* SAME-TAB "VIEW AS" — the exact path that produced the stale-role bug.
     *
     * Rene signs in as admin; sessionStorage holds rnr_app_role='admin'. He then
     * opens a View-as magic link IN THE SAME TAB (the settings modal only
     * SUGGESTS incognito, and a web page cannot force a private window). The
     * Supabase session becomes the VA's; sessionStorage is untouched by a
     * sign-in, so the tab still claimed 'admin'.
     *
     * staleRole seeds that: role 'admin' stamped with a DIFFERENT user's uid,
     * over a session whose current_app_role() answers 'va'.
     *
     * The three evals are the bug itself, not proxies for it:
     *   rnr_app_role      — the cache was discarded and re-read, not reused
     *   _ldNonAdmin()     — the page now knows it is a VA session
     *   _smsDest(...)     — and therefore sends NULL instead of a real phone
     *                       number, letting the server resolve it from
     *                       contact_id. This is the one with a consequence
     *                       outside the browser: a text to a real handset.
     *
     * Before the fix all three came back the admin answers. */
    name: 'same-tab View-as: a stale admin role does not survive the user change',
    url: '/admin/lead-detail?id=' + FIXTURE,
    role: 'va',
    staleRole: 'admin',
    steps: [{ waitMs: 2500 }],
    evals: [
      // The stale admin role really was planted — otherwise everything below
      // would hold vacuously, on a tab that simply had no cached role.
      ["sessionStorage.getItem('rnr_rc_seeded_role')", 'admin'],
      ["sessionStorage.getItem('rnr_app_role')", 'va'],
      ['_ldNonAdmin()', true],
      ["_smsDest('7145550142')", null],
    ],
  },
  {
    /* The other half of the pair, and the reason the one above is not vacuous:
     * the same three expressions must give the ADMIN answers for an admin. If
     * they were somehow pinned to the VA result, this fails. It also guards the
     * regression that matters least dramatically and would be noticed most —
     * the fix quietly demoting admins. */
    name: 'admin session still resolves as admin (the evals discriminate)',
    url: '/admin/lead-detail?id=' + FIXTURE,
    role: 'admin',
    steps: [{ waitMs: 2500 }],
    evals: [
      ["sessionStorage.getItem('rnr_app_role')", 'admin'],
      ['_ldNonAdmin()', false],
      ["_smsDest('7145550142')", '+17145550142'],
    ],
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
    /* "Shared with me" as the VA. The stub returns the five shared leads with
       the masks va_shared_leads() applies, so this proves the PAGE renders what
       it is handed and never unmasks — it cannot prove the SQL masks, which is
       verified separately against the live function. */
    name: 'va-people renders five masked rows as VA',
    url: '/admin/va-people',
    role: 'va',
    rpc: {
      va_shared_leads: [
        { contact_id: '11111111-1111-4111-8111-111111111111', name: 'Karina Bernal',
          phone: '(562) ***-**94', email: 'lead-bdcf3712@masked.local', pipeline_status: 'Pre-Approved', open_tasks: 2, tasks: [] },
        { contact_id: '22222222-2222-4222-8222-222222222222', name: 'Marlon Vasquez Ramos',
          phone: '(714) ***-**12', email: 'lead-5608430c@masked.local', pipeline_status: 'Processing', open_tasks: 0, tasks: [] },
        { contact_id: '33333333-3333-4333-8333-333333333333', name: 'Juan Davila',
          phone: '(949) ***-**77', email: 'lead-6134fbe8@masked.local', pipeline_status: 'Processing', open_tasks: 1, tasks: [] },
        { contact_id: '44444444-4444-4444-8444-444444444444', name: 'Vincent Solis',
          phone: '(310) ***-**03', email: 'lead-54bb0987@masked.local', pipeline_status: 'Contacted', open_tasks: 0, tasks: [] },
        { contact_id: '55555555-5555-4555-8555-555555555555', name: 'Rafael Hernandez Andrade',
          phone: '(818) ***-**41', email: 'lead-07b1e13d@masked.local', pipeline_status: 'Closed', open_tasks: 0, tasks: [] },
      ],
    },
    steps: [{ waitMs: 2500 }],
    present: ['.rows .row', '.stage.done'],
    rowCount: { selector: '.rows .row', expect: 5 },
    // A raw email or an unmasked 10-digit phone on this page is the failure.
    absentText: ['@gmail.com', '@yahoo.com', '@ratesandrealty.com'],
    absent: ['#assigned_to', '[data-assigned-to]'],
  },
  {
    /* NEGATIVE CASE. 'agent' is a real staff role that is NOT in va-people's
       PAGE_ACCESS list, so auth-guard must cover the page with its denial
       overlay. Asserting the overlay TEXT rather than absence of rows, because
       an empty list and a denied page look identical from the outside — and
       "renders nothing" is exactly the failure this whole harness exists for. */
    name: 'va-people is denied to a role without access',
    url: '/admin/va-people',
    role: 'agent',
    rpc: { va_shared_leads: [
      { contact_id: '99999999-9999-4999-8999-999999999999', name: 'Should Not Appear',
        phone: '(000) ***-**00', email: 'lead-99999999@masked.local',
        pipeline_status: 'Processing', open_tasks: 0, tasks: [] } ] },
    steps: [{ waitMs: 2500 }],
    // The overlay is the proof the gate fired. The absent row is the proof it
    // SUPPRESSED something — an overlay over a rendered list would still leak
    // the names underneath it, and "an overlay exists" alone would pass that.
    expectText: ['Access restricted'],
    absentText: ['Should Not Appear'],
  },
  /* THE THREE dashboard/admin.html insights specs were REMOVED, not left failing.
     api/auth-api.js builds its OWN supabase client as an ES module, so pinning
     window.supabase does not reach it: it finds no session, redirects to the
     borrower portal, and the harness ends up asserting against the wrong page.
     Stubbing a module-scoped client is a much deeper change than this
     verification warrants. A permanently-red suite trains people to ignore it,
     which is worse than an acknowledged gap — the hide-on-403 behaviour on that
     dashboard is verified by reading and by the single-consumer check, NOT by
     this harness. Recorded so nobody assumes it is covered. */
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
  {
    /* SEND MUST SEND. Rene reported Send doing nothing while the button rendered
     * perfectly — the same shape as #shell being present and empty. Asserting
     * that [data-sc-send] EXISTS passes on a dead button, so this spec types a
     * body, clicks Send, and asserts the text reaches the message pane.
     *
     * The absent-assertion is paired with a present one on purpose: #sc-input
     * must be there, or "the composer did not clear" and "the composer never
     * mounted" are the same green.
     *
     * Boundary: this proves the BROWSER path — handler wired, send() reached,
     * RPC called with the body, result rendered. It says nothing about
     * staff_message_send's own SQL, RLS, or the notification upsert behind it;
     * the stub answers for all three. Those are proven against the real DB. */
    name: 'staff chat Send actually sends',
    url: '/admin/chat.html',
    role: 'admin',
    rpcFns: {
      staff_threads_list: `(a, st) => { st.msgs = st.msgs || [{ id: 'm1', sender_user_id: 'u2',
        sender_email: 'teammate@ratesandrealty.com', body: 'Existing message', mine: false,
        created_at: new Date().toISOString(), attachments: [] }];
        return [{ thread_id: 't-render-check', is_group: false, title: 'Render check thread',
          last_message_at: new Date().toISOString(), last_message: 'Existing message',
          last_sender: 'teammate@ratesandrealty.com', unread: 0,
          others: [{ user_id: 'u2', email: 'teammate@ratesandrealty.com' }] }]; }`,
      // NEWEST FIRST, matching the documented contract — the page re-reverses it.
      staff_thread_messages: `(a, st) => (st.msgs || []).slice().reverse()`,
      staff_message_send: `(a, st) => { const row = { id: 'm-sent', sender_user_id: null,
        sender_email: 'render-check@local', body: a.p_body, mine: true,
        created_at: new Date().toISOString(), attachments: a.p_attachments || [] };
        st.msgs = (st.msgs || []).concat([row]); return row; }`,
      staff_thread_mark_read: `() => null`,
    },
    steps: [
      { click: '[data-sc-thread]', waitMs: 1500 },
      { fill: '#sc-input', value: 'RC-SEND-PROBE', waitMs: 300 },
      { click: '[data-sc-send]', waitMs: 2500 },
    ],
    present: ['#sc-full-messages', '#sc-input'],
    expectText: ['RC-SEND-PROBE'],
    // The composer clears only on a send that reached the RPC.
    values: { '#sc-input': '' },
  },
  {
    /* The SAME assertion against the FLOATING panel, which is the mount Rene
     * actually reported and the one on 34 pages — chat.html is the only page
     * using the full mount. Same composer markup, different container and a
     * tab/open state in front of it, so one passing does not prove the other. */
    name: 'staff chat Send actually sends — floating panel',
    url: '/admin/people',
    role: 'admin',
    rpcFns: {
      staff_threads_list: `(a, st) => { st.msgs = st.msgs || [{ id: 'm1', sender_user_id: 'u2',
        sender_email: 'teammate@ratesandrealty.com', body: 'Existing message', mine: false,
        created_at: new Date().toISOString(), attachments: [] }];
        return [{ thread_id: 't-render-check', is_group: false, title: 'Render check thread',
          last_message_at: new Date().toISOString(), last_message: 'Existing message',
          last_sender: 'teammate@ratesandrealty.com', unread: 0,
          others: [{ user_id: 'u2', email: 'teammate@ratesandrealty.com' }] }]; }`,
      staff_thread_messages: `(a, st) => (st.msgs || []).slice().reverse()`,
      staff_message_send: `(a, st) => { const row = { id: 'm-sent', sender_user_id: null,
        sender_email: 'render-check@local', body: a.p_body, mine: true,
        created_at: new Date().toISOString(), attachments: a.p_attachments || [] };
        st.msgs = (st.msgs || []).concat([row]); return row; }`,
      staff_thread_mark_read: `() => null`,
    },
    steps: [
      { click: '[data-sc-toggle]', waitMs: 1800 },
      { click: '[data-sc-thread]', waitMs: 1500 },
      { fill: '#sc-input', value: 'RC-SEND-PROBE', waitMs: 300 },
      { click: '[data-sc-send]', waitMs: 2500 },
    ],
    present: ['#sc-messages', '#sc-input'],
    expectText: ['RC-SEND-PROBE'],
    values: { '#sc-input': '' },
  },
  /* NO ESCROW # SPEC, and that is a gap rather than an oversight — recorded here
   * so nobody concludes the Loan Snapshot is covered.
   *
   * Two attempts, both abandoned. Under the STUB the processing tab never
   * renders its cards. With a REAL va token on a lead she can open, #tab-processing
   * IS visible and she gets her four allowed tabs, yet neither the new "Escrow #"
   * nor the PRE-EXISTING "Loan #" nor even the STATIC "Loan Snapshot" heading
   * appears in the page text. Static markup being absent while its container
   * reports visible means the cause sits inside the processing tab and is
   * upstream of anything the escrow work touched.
   *
   * That last point is the one worth keeping: the paired assertion is what made
   * it diagnosable. Asserting "Escrow #" alone would have read as "the new field
   * is broken". Asserting the pre-existing sibling alongside it said "the whole
   * card is missing", which is a different bug with a different owner.
   *
   * Escrow # is therefore NOT harness-verified. It needs a human to open the
   * Loan Snapshot on a real lead — which is what this repo's own rule about
   * having a person confirm a frontend change already asks for. */
];

/* BREAK TEST for the two Send specs above. tools/fixtures/dead-send.html is a
 * composer with a perfect [data-sc-send] and NO handler behind it. Run it and
 * the two specs must fail on it — if they pass, they are presence-only again
 * and prove nothing:
 *
 *   node tools/render-check.mjs --url "file://<repo>/tools/fixtures/dead-send.html" \
 *        --expect "#sc-input" --min-text 50
 *
 * or paste the fixture path into a spec's url with the same steps. Verified
 * 2026-08-10: both assertions fire (composer never cleared, text never
 * appeared) while #sc-input and #sc-messages are both present — which is the
 * exact #shell-present-and-empty shape presence-only assertions miss. */

// ── CDP plumbing ────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function chromePath() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  fail('no Chromium/Chrome/Edge binary found. Tried:\n  ' + CHROME_CANDIDATES.join('\n  '));
}

/* Wrap one WebSocket in the request/response + event-buffer shape runSpec wants. */
function cdpChannel(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onerror = () => reject(new Error('cdp connect failed: ' + url));
    ws.onopen = () => {
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
      resolve({ send, events, raw: ws });
    };
  });
}

/* ── ONE BROWSER FOR THE WHOLE RUN ─────────────────────────────────────────
 * This used to spawn a Chrome per spec, each with its own --user-data-dir. On
 * Windows that is the dominant cost — profile creation, not page load — and at
 * eleven specs the suite ran past the 6m40s tool ceiling. A suite that can only
 * be run one spec at a time stops being run.
 *
 * WHAT IS STILL ISOLATED, because this is the part worth being precise about.
 * Each spec gets its own INCOGNITO BROWSER CONTEXT, not just its own tab. A
 * context has its own cookie jar, localStorage, sessionStorage, IndexedDB,
 * cache and service workers, and it is destroyed after the spec. That property
 * is load-bearing now: the Inbox scope toggle persists the user's choice to
 * localStorage, so a shared profile would let the toggle spec's "full" leak
 * into the next spec and quietly change what it tested.
 *
 * WHAT IS NO LONGER ISOLATED, stated rather than discovered later:
 *   · the browser PROCESS is shared, so a browser-level crash ends the run
 *     instead of failing one spec. Renderer crashes stay per-tab.
 *   · command-line flags and any browser-global state are common to all specs
 *     (they were already identical, so nothing changes in practice).
 *   · DNS and socket pools are shared, so specs are no longer independent for
 *     network TIMING. Nothing here asserts on timing.
 * Specs still run SEQUENTIALLY. Running them concurrently would be faster
 * again, but eleven headless pages against one host is what produced the
 * intermittent "Google Maps included multiple times" warning earlier, and a
 * suite that fails randomly under its own load is worse than a slow one. */
async function launchBrowser(port, profileDir) {
  const proc = spawn(chromePath(), [
    '--headless=new', `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (v && v.webSocketDebuggerUrl) { wsUrl = v.webSocketDebuggerUrl; break; }
    } catch (_) { /* not listening yet */ }
    await sleep(250);
  }
  if (!wsUrl) { proc.kill(); fail('browser never exposed a debuggable endpoint'); }

  const chan = await cdpChannel(wsUrl);
  return {
    proc, port, send: chan.send,
    close: () => { try { chan.raw.close(); } catch (_) {} proc.kill(); },
  };
}

/* A fresh context + page per spec. Returns the same {send, events, close}
   shape the old per-browser object had, so runSpec is unchanged below. */
async function newPage(browser) {
  const ctx = await browser.send('Target.createBrowserContext', { disposeOnDetach: false });
  const browserContextId = ctx.result.result ? ctx.result.result.browserContextId : ctx.result.browserContextId;
  const tgt = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const targetId = tgt.result.result ? tgt.result.result.targetId : tgt.result.targetId;

  const chan = await cdpChannel(`ws://127.0.0.1:${browser.port}/devtools/page/${targetId}`);
  return {
    send: chan.send, events: chan.events,
    close: async () => {
      try { chan.raw.close(); } catch (_) {}
      /* Dispose BOTH. Closing only the target leaves the context — and its
         storage — alive for the rest of the run, which is the isolation this
         design depends on. */
      try { await browser.send('Target.closeTarget', { targetId }); } catch (_) {}
      try { await browser.send('Target.disposeBrowserContext', { browserContextId }); } catch (_) {}
    },
  };
}

async function runSpec(spec, opts) {
  const b = await newPage(opts.browser);
  const problems = [];
  const notes = [];

  try {
    await b.send('Page.enable');
    await b.send('Runtime.enable');
    await b.send('Log.enable').catch(() => {});

    /* Headless Chrome's default viewport is 800×600. A layout check that does not
       STATE its width is testing an accidental one — and 800 is narrow enough
       that a bug present only there reads as "reproduced" when the real screen is
       fine, and vice versa. Every spec runs at a declared width. */
    const vw = spec.width || opts.width || 1440;
    const vh = spec.height || 900;
    await b.send('Emulation.setDeviceMetricsOverride', {
      width: vw, height: vh, deviceScaleFactor: 1, mobile: false,
    }).catch(() => {});

    if (opts.token) {
      // Real-session mode: seed the token supabase-js would have stored.
      await b.send('Page.addScriptToEvaluateOnNewDocument', { source:
        `try{localStorage.setItem('sb-ljywhvbmsibwnssxpesh-auth-token', ${JSON.stringify(JSON.stringify({
          access_token: opts.token.raw, token_type: 'bearer', expires_at: opts.token.payload.exp,
          refresh_token: 'render-check', user: { id: opts.token.payload.sub, email: opts.token.payload.email },
        }))});}catch(e){}` });
    } else {
      await b.send('Page.addScriptToEvaluateOnNewDocument', {
        source: stubSource(spec.role || 'admin', 'render-check@local', spec.stubRow, spec.rpc, spec.fetchMap, spec.rpcFns, spec.staleRole, spec.invoke, spec.tables),
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
      /* fill: put text in a field before the click that consumes it. Sets .value
         and fires input+change, because a page may read either the property or
         the event — and a fill that silently matched nothing would make the
         click that follows look like the failure. */
      if (step.fill) {
        const r = await b.send('Runtime.evaluate', {
          expression: `(()=>{const e=document.querySelector(${JSON.stringify(step.fill)});if(!e)return 'MISSING';
            e.focus(); e.value=${JSON.stringify(step.value ?? '')};
            e.dispatchEvent(new Event('input',{bubbles:true}));
            e.dispatchEvent(new Event('change',{bubbles:true}));return 'ok';})()`,
          returnByValue: true,
        });
        if (r.result.result.value === 'MISSING') problems.push(`step: nothing matched ${step.fill} to fill`);
      }
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
          hidden:  ${JSON.stringify(spec.hidden || [])}.map(s => [s, vis(s), has(s)]),
          order:   Array.from(document.querySelectorAll(${JSON.stringify(spec.orderSel || 'nothing')}))
                        .map(e => (e.textContent || '').trim()),
          values:  Object.entries(${JSON.stringify(spec.values || {})}).map(([sel, want]) => {
                     const e = document.querySelector(sel);
                     // <button> HAS a .value property (empty by default), so keying
                     // on "value in e" reads buttons as blank. Gate on tag instead.
                     const isField = e && /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName);
                     return [sel, want, e ? (isField ? e.value : (e.textContent || '')) : '(no element)'];
                   }),
          rowCount: ${spec.rowCount ? `document.querySelectorAll(${JSON.stringify(spec.rowCount.selector)}).length` : 'null'},
          missingText: ${JSON.stringify(spec.expectText || [])}.filter((t) =>
                        !(document.body ? (document.body.innerText || '') : '').includes(t)),
          badText: ${JSON.stringify(spec.absentText || [])}.filter((t) =>
                     (document.body ? (document.body.innerText || '') : '').includes(t)),
          /* Text clipped by its own box. An element with overflow:hidden whose
             scrollWidth exceeds its clientWidth is showing a FRAGMENT of its
             label, and if it is also centred the fragment is cut at BOTH ends —
             mid-word — so adjacent cells read as one garbled string. Nothing
             throws, no console error, the text is all "on the page" as far as
             innerText is concerned. Only geometry catches it. */
          clip: ${JSON.stringify(spec.noClip || [])}.map(sel => {
            const all = Array.from(document.querySelectorAll(sel));
            const bad = all.filter(e => e.scrollWidth > e.clientWidth + 1)
              .map(e => ((e.textContent || '').trim() || '(empty)')
                        + ' needs ' + e.scrollWidth + 'px in ' + e.clientWidth + 'px');
            return [sel, all.length, bad];
          }),
          /* JS-EXPRESSION ASSERTIONS.
             Some things a role gate decides are not rendering at all. _smsDest()
             returning null for a VA is what stops an outbound text going to a
             real number the page should never have handed over — there is no
             element to select for that, and asserting on a proxy would be
             asserting on something else. Each entry is [expr, expected]; the
             result is JSON-compared so null, false and '' stay distinct. */
          evals: ${JSON.stringify(spec.evals || [])}.map(([expr, want]) => {
            let got;
            try { got = eval(expr); } catch (e) { got = '(threw: ' + (e && e.message) + ')'; }
            return [expr, JSON.stringify(want) || 'undefined', JSON.stringify(got) || 'undefined'];
          }),
          /* Every edge-function call the page made, in order. */
          calls: (window.__RC_CALLS || []).map(c => c.fn),
          callBodies: (window.__RC_CALLS || []),
          textLen: (document.body ? (document.body.innerText || '').trim().length : 0),
          title:   document.title,
        };
      })()`,
    });
    const p = probe.result.result.value;

    for (const [expr, want, got] of p.evals || []) {
      if (got !== want) problems.push(`eval mismatch: ${expr} → ${got}, expected ${want}`);
      else notes.push(`${expr} = ${got}`);
    }
    for (const [sel, exists] of p.present) if (!exists) problems.push(`expected element ABSENT: ${sel}`);
    for (const [sel, exists] of p.absent) if (exists) problems.push(`element that must NOT exist is present: ${sel}`);
    for (const [sel, visible, exists] of p.hidden || []) {
      /* MUST EXIST AND BE INVISIBLE. Without the exists check this passes on any
         page where the element is simply absent — which is how it "passed" on a
         page the harness had been redirected away from. A vacuous assertion is
         worse than none: it reports coverage it does not have. */
      if (!exists) problems.push(`hidden-check target not on the page at all: ${sel} (assertion would be vacuous)`);
      else if (visible) problems.push(`element must be HIDDEN for this role but is visible: ${sel}`);
      else notes.push(`present and hidden, as required: ${sel}`);
    }
    /* CALLS — the assertion that a button DID something.
       spec.calls is a list of edge-function names the run must have invoked.
       This is the whole point of a click spec: #loeSendBtn is present, enabled
       and correctly labelled on a page where clicking it is a no-op, so every
       presence assertion passes while the feature is dead. Only "loe-send was
       called" separates the two. spec.callsAbsent is the paired negative, so a
       spec can also prove a click did NOT fire something. */
    for (const want of spec.calls || []) {
      if (!(p.calls || []).includes(want)) {
        problems.push(`edge function NEVER CALLED: ${want} — the click did nothing.`
          + ` Calls seen: ${(p.calls || []).length ? p.calls.join(', ') : '(none)'}`);
      } else {
        const b = (p.callBodies || []).find((c) => c.fn === want);
        notes.push(`called ${want} with ${JSON.stringify(b && b.body)}`);
      }
    }
    for (const bad of spec.callsAbsent || []) {
      if ((p.calls || []).includes(bad)) problems.push(`edge function called but must NOT be: ${bad}`);
    }
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
    if (spec.rowCount && p.rowCount !== spec.rowCount.expect) {
      problems.push(`expected ${spec.rowCount.expect} rows matching ${spec.rowCount.selector}, rendered ${p.rowCount}`);
    } else if (spec.rowCount) notes.push(`${spec.rowCount.selector} × ${p.rowCount}`);
    /* Forbidden text is how a mask failure shows up: the page renders fine and
       the wrong value is simply in it. Asserting on absence of the raw form is
       the only check that fails when a mask is dropped. */
    for (const t of p.badText || []) problems.push(`UNMASKED VALUE ON PAGE: visible text contains "${t}"`);
    for (const t of p.missingText || []) problems.push(`expected text NOT on page: "${t}"`);
    if (spec.expectText && !(p.missingText || []).length) notes.push(`found: ${spec.expectText.join(' | ')}`);
    if (spec.absentText && !(p.badText || []).length) notes.push(`no forbidden text (${spec.absentText.length} pattern(s) checked)`);
    for (const [sel, count, bad] of p.clip || []) {
      /* Same lesson as the hidden[] check: zero matches is not a pass. */
      if (!count) problems.push(`no-clip target matched nothing: ${sel} (assertion would be vacuous)`);
      else if (bad.length) {
        problems.push(`TEXT CLIPPED at ${vw}px — ${bad.length}/${count} of ${sel} cannot show their own label:\n      · ` + bad.join('\n      · '));
      } else notes.push(`no clipping at ${vw}px: ${sel} × ${count}`);
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
    await b.close();
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
  /* tokenOnly: skipped without --token, and the skip is PRINTED. Some panes
     cannot be reached by the stub at all — the processing tab needs a lead the
     signed-in user can actually load, and .single() returning no row makes the
     page bail before the tabs exist. Leaving such a spec in the default suite
     would make it permanently red, which trains people to ignore red; deleting
     it would lose the coverage silently. This is the third option, and it is
     announced on every run for the same reason allowConsole exclusions are. */
  if (!token) {
    const skipped = specs.filter((s) => s.tokenOnly);
    specs = specs.filter((s) => !s.tokenOnly);
    if (skipped.length) {
      console.log(`SKIPPED without --token (${skipped.length}): ${skipped.map((s) => s.name).join(' | ')}`);
      console.log('  These assert on panes the stub cannot reach. Run with --token to cover them.\n');
    }
    if (!specs.length) fail(`every spec matching "${filter}" is tokenOnly. Re-run with --token <file>.`);
  }
}

const tmp = process.env.TEMP || process.env.TMPDIR || '.';
console.log(`render-check — ${specs.length} page(s) against ${BASE}`);
console.log(token ? 'mode: REAL SESSION\n' : 'mode: STUBBED CLIENT (no credentials, no session row)\n');

const t0 = Date.now();
const browser = await launchBrowser(9400, `${tmp}/rc-shared-${process.pid}`);

let failed = 0;
for (let i = 0; i < specs.length; i++) {
  const s = specs[i];
  process.stdout.write(`  ${s.name} … `);
  const { problems, notes } = await runSpec(s, { index: i, tmp, token, browser });
  if (problems.length) {
    failed++;
    console.log('FAIL');
    for (const pr of problems) console.log(`      ✗ ${pr}`);
  } else {
    console.log('pass');
  }
  for (const n of notes) console.log(`      · ${n}`);
}

browser.close();

console.log('\n' + (token ? BOUNDARY_REAL : BOUNDARY).join('\n'));
console.log(`\n${specs.length - failed}/${specs.length} page(s) rendered clean`
  + ` in ${Math.round((Date.now() - t0) / 1000)}s`
  + ` (one browser, one incognito context per spec).`);
if (failed) { console.log(`${failed} FAILED.`); process.exit(1); }
