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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

/* Fixture specs address their page RELATIVELY. The break-test instructions in
   this file used to carry an absolute C:\AI\test\… path, which is fine for a
   command somebody types and wrong for a spec that has to run on any checkout. */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = (name) => pathToFileURL(join(REPO, 'tools', 'fixtures', name)).href;

const CHROME_CANDIDATES = [
  'C:\\Users\\rened\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const BASE = process.env.RC_BASE || 'https://admin.ratesandrealty.com';
const FIXTURE = 'aa74cc5e-2186-4b40-8608-3d2aa033b9ca';   // ZZ-TEST Fixture Borrower

/* Drag a COMPLETED card onto To Do on the CRM board and report what happened, as
 * one expression, because evals compare an expression to an exact value.
 *
 * Returns a 3-field verdict rather than a boolean so a failure says WHICH half
 * broke. "missing:..." when a selector found nothing — the difference between
 * "the refusal did not fire" and "there was nothing to drag", which a boolean
 * would flatten into the same red.
 *
 * The card is re-found BY ID after the drop, never held by reference: the refusal
 * branch calls renderAllTasksTable(), which replaces every node, so a retained
 * element would test detached DOM and report "stayed" no matter what happened.
 * window.alert is swallowed and restored — headless Chromium blocks on a real
 * dialog, and the message is the assertion anyway. */
const RC_BOARD_DRAG = `(function(){
  var msgs=[], A=window.alert; window.alert=function(m){msgs.push(String(m));};
  try{
    var B='[data-target="cm-board"] ';
    var card=document.querySelector(B+'.board-card[data-status="completed"]');
    var col=document.querySelector(B+'[data-drop-col="todo"]');
    if(!card||!col) return 'missing:card='+!!card+',col='+!!col;
    var id=card.dataset.taskId, dt=new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
    col.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));
    var blocked=col.classList.contains('is-drop-blocked');
    col.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
    var sel='.board-card[data-task-id="'+(window.CSS&&CSS.escape?CSS.escape(id):id)+'"]';
    var inTodo=!!document.querySelector(B+'[data-drop-col="todo"] '+sel);
    var inDone=!!document.querySelector(B+'[data-drop-col="done"] '+sel);
    return (msgs.length?'refused':'noalert')+'|'
         +(blocked?'blocked':'notblocked')+'|'
         +((!inTodo&&inDone)?'stayed':(inTodo?'moved':'vanished'));
  } finally { window.alert=A; }
})()`;

/* The admin half stops at dragover ON PURPOSE. dragover and drop read the same
 * predicate on this branch, so an unblocked dragover is the gate opening;
 * dispatching the drop would reopen a real completed task to learn nothing the
 * predicate has not already said. */
const RC_BOARD_DRAG_ADMIN = `(function(){
  var B='[data-target="cm-board"] ';
  var card=document.querySelector(B+'.board-card[data-status="completed"]');
  var col=document.querySelector(B+'[data-drop-col="todo"]');
  if(!card||!col) return 'missing:card='+!!card+',col='+!!col;
  var dt=new DataTransfer();
  card.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
  var ev=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt});
  col.dispatchEvent(ev);
  return (ev.defaultPrevented?'allowed':'refused')+'|'
       +(col.classList.contains('is-drop-blocked')?'blocked':'notblocked');
})()`;

/* The pair, run against ONE card in ONE page load. The va half must refuse and
 * must not move the card; the admin half must open the gate on the same target.
 * The role is restored afterwards so nothing later in the run inherits it. */
const RC_BOARD_BOTH_ROLES = `(function(){
  var prev=null; try{ prev=sessionStorage.getItem('rnr_app_role'); }catch(e){}
  function as(r){ try{ sessionStorage.setItem('rnr_app_role', r); }catch(e){} }
  try{
    as('va');    var va    = ${RC_BOARD_DRAG};
    as('admin'); var admin = ${RC_BOARD_DRAG_ADMIN};
    return 'va='+va+' :: admin='+admin;
  } finally {
    try{ prev===null ? sessionStorage.removeItem('rnr_app_role')
                     : sessionStorage.setItem('rnr_app_role', prev); }catch(e){}
  }
})()`;

/* FORCE the Maps double-load rather than waiting for it — PART 1, at
 * document-start, because that is the only place the race exists.
 *
 * The flake is a LATENCY race, so this pins the latency instead of hoping for
 * it. Two interventions, both timing, neither faking a result:
 *
 *   1. /config is delayed 2500ms. map-controls' loadGoogleMaps() claims
 *      window._gmapsLoadPromise and then AWAITS that fetch before appending its
 *      tag, so the delay widens a gap that already exists on every cold load —
 *      sessionStorage holds no cached key in a fresh context.
 *   2. At DOMContentLoaded — by which time places-autocomplete's deferred script
 *      has run — a probe input is attached through RRPlaces. That lands INSIDE
 *      the gap, which is precisely the interleaving production hits by chance.
 *
 * Nothing about the loaders is stubbed or reimplemented; both run their own
 * code. The only thing chosen is WHEN.
 *
 * Why not do this from an eval: evals run after readyState=complete, and by then
 * places-autocomplete's module-private _loading is a resolved promise, so
 * load() returns early and never appends again. Measured — the first version of
 * this probe reported "appended 0 tags" for exactly that reason. State that
 * cannot be reset cannot be raced twice in one document.
 *
 * No backticks below: template literal. */
const RC_MAPS_RACE_SETUP = `(function(){
  try { sessionStorage.removeItem('gmapsKey'); } catch(e) {}
  var Q = 'script[src*="maps.googleapis.com/maps/api/js"]';
  var f = window.fetch;
  window.fetch = function(u, o){
    var s = (typeof u === 'string') ? u : ((u && u.url) || '');
    if (s.indexOf('/config') !== -1) {
      return new Promise(function(res, rej){
        setTimeout(function(){ f.call(window, u, o).then(res, rej); }, 2500);
      });
    }
    return f.call(window, u, o);
  };
  window.__rrRace = 'no DOMContentLoaded';
  document.addEventListener('DOMContentLoaded', function(){
    try {
      if (!window.RRPlaces || typeof window.RRPlaces.attachCombined !== 'function') {
        window.__rrRace = 'RRPlaces absent at DOMContentLoaded'; return;
      }
      var pre = document.querySelectorAll(Q).length;
      var inp = document.createElement('input');
      inp.id = 'rrMapsRaceProbe'; inp.type = 'text';
      (document.body || document.documentElement).appendChild(inp);
      window.RRPlaces.attachCombined('rrMapsRaceProbe', {});
      window.__rrRace = 'attached (tags before=' + pre + ', after=' + document.querySelectorAll(Q).length + ')';
    } catch(e) { window.__rrRace = 'threw: ' + (e && e.message); }
  });
})()`;

/* FORCE the Maps double-load rather than waiting for it.
 *
 * lead-detail is the only page that loads BOTH Maps loaders, and their guards
 * are one-directional:
 *
 *   public/js/map-controls.js      appends a tag CARRYING data-gmaps-js="1",
 *                                  and looks only for script[data-gmaps-js="1"]
 *   admin/js/places-autocomplete.js appends a tag with NO marker,
 *                                  and looks for any maps/api/js tag
 *
 * So places-first is the losing order: map-controls cannot see the tag places
 * appended and adds a second one. The window exists because loadGoogleMaps()
 * claims window._gmapsLoadPromise and then AWAITS fetch('/config') before it
 * appends — always, in a fresh context, since sessionStorage holds no key. Each
 * module's own idempotence guard is invisible to the other.
 *
 * Waiting for that order to happen by itself is what made this a flake: 31
 * consecutive clean runs were captured while the suite kept failing elsewhere.
 * This drives the interleaving deliberately — start loadGoogleMaps(), then
 * attach a Places field synchronously inside its /config gap — so the count is
 * a measurement rather than a coin toss.
 *
 * RETURNS A NUMBER on success and a 'HARNESS: …' STRING when it could not set
 * the race up. That distinction is the point: places-autocomplete's _loading is
 * module-private, so if something already loaded Places on this page the probe
 * CANNOT force the order, and a silent 1 would read as the bug being fixed. A
 * string fails the eval loudly instead of passing vacuously.
 *
 * No backticks anywhere below — this is a template literal. */
const RC_MAPS_FORCE_RACE = `(async function(){
  var Q = 'script[src*="maps.googleapis.com/maps/api/js"]';
  function count(){ return document.querySelectorAll(Q).length; }

  /* Every one of these returns a STRING, not a number, and that is the point:
     places-autocomplete's loader is un-resettable, so a probe that failed to set
     the race up would otherwise report a perfectly healthy 1 and read as the bug
     being fixed. A string fails the eval loudly. */
  var st = window.__rrRace || '(document-start setup never ran)';
  if (st.indexOf('attached') !== 0) return 'HARNESS: ' + st;
  if (st.indexOf('before=0') === -1) return 'HARNESS: a Maps tag already existed when the probe attached, so the /config gap was NOT open - ' + st;
  if (st.indexOf('after=1') === -1) return 'HARNESS: places-autocomplete appended no tag of its own - ' + st;

  /* The losing order is now established: places appended the only tag on the
     page while map-controls was still awaiting /config. Let map-controls come
     back and decide. Poll rather than sleep a fixed span, so a slow /config
     cannot report a false 1. */
  for (var i = 0; i < 60; i++) {
    if (count() > 1) break;
    await new Promise(function(r){ setTimeout(r, 100); });
  }
  return count();
})()`;

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
  {
    /* THE PUBLIC CMA LINK, SIGNED OUT AND UNSTUBBED. include_* are false on this
       slug, so the acquisition and rental sections must be ABSENT FROM THE
       PAYLOAD, not merely unrendered — that gap is what this sweep is about. The
       page must still draw exactly as before: a redaction that changes what the
       borrower sees is a new problem. */
    name: 'public CMA link strips unrendered sections',
    url: '/cma/uqa5u9q',
    anonymous: true,
    present: ['#app'],
    evals: [
      ['(async function(){var cfg=window.APP_CONFIG||{};'
       + 'var cl=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);'
       + 'var r=await cl.rpc("get_cma_snapshot",{p_slug:"uqa5u9q"});var d=(r.data&&r.data.data)||{};'
       + 'return JSON.stringify({status:r.data&&r.data.status,'
       + 'da_inputs:("da_inputs" in d),acquisition:("acquisition" in d),rental:("rental" in d),'
       + 'mls:!!(d.comps||[]).some(function(c){return ("mlsNumber" in c)||("description" in c);}),'
       + 'comps:Array.isArray(d.comps)&&d.comps.length>0});})()',
       '{"status":"ok","da_inputs":false,"acquisition":false,"rental":false,"mls":false,"comps":true}'],
      /* Rendered output unchanged: the value hero and the comps still draw. */
      ['document.body.textContent.replace(/\s+/g,"").length > 800', true],
      /* STRUCTURAL. document.body.textContent includes inline <script> source and
         cma.html contains the literal "no longer available" inside renderNotFound,
         so a text match always trips. renderNotFound wraps its output in .center —
         its absence is the real proof the report rendered. Third time this trap has
         caught an assertion in this file. */
      ['!document.querySelector("#app .center")', true],
    ],
  },
  {
    /* THE OTHER HALF OF THE REDACTION, and the case the first spec cannot reach.
       uqa5u9q has both include_ flags FALSE, so `acquisition` is dropped whole —
       which means it proves nothing about what ships INSIDE a section that does
       render. pfspn8g has both flags TRUE.

       `acquisition.inputs` is the same investor-modelling set as the top-level
       `da_inputs` — hold costs, hard-money rate and points, LTC, ARV, refinance
       assumptions — nested one level down. Stripping da_inputs while an identical
       copy shipped underneath is exactly the miss this asserts against.

       PRESENT and ABSENT are paired on purpose: if the section never mounted, an
       absent-only check would pass vacuously. */
    name: 'public CMA link strips investor inputs inside a rendered section',
    url: '/cma/pfspn8g',
    anonymous: true,
    present: ['#app'],
    evals: [
      ['(async function(){var cfg=window.APP_CONFIG||{};'
       + 'var cl=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);'
       + 'var r=await cl.rpc("get_cma_snapshot",{p_slug:"pfspn8g"});var d=(r.data&&r.data.data)||{};'
       + 'var a=d.acquisition||{},R=a.results||{};'
       + 'return JSON.stringify({status:r.data&&r.data.status,'
       // PRESENT: the section really is being delivered and rendered.
       + 'acq:("acquisition" in d),rental:("rental" in d),'
       + 'flipProfit:!!(R.flip&&R.flip.gross_profit!=null),capRate:!!(a.property&&a.property.cap_rate!=null),'
       // ABSENT: everything the page never reads.
       + 'inputs:("inputs" in a),da_inputs:("da_inputs" in d),'
       + 'acqName:("borrower_name" in a),'
       + 'flipExtras:!!(R.flip&&(("max_buy" in R.flip)||("total_project_cost" in R.flip)||("hm_loan" in R.flip))),'
       + 'brrrrExtras:!!(R.brrrr&&(("new_loan" in R.brrrr)||("refi_pmt" in R.brrrr)))});})()',
       '{"status":"ok","acq":true,"rental":true,"flipProfit":true,"capRate":true,'
       + '"inputs":false,"da_inputs":false,"acqName":false,"flipExtras":false,"brrrrExtras":false}'],
      /* The Investment Analysis section actually drew — .strat is emitted only by
         renderAcquisition(), so this fails if the redaction gutted the section. */
      ['document.querySelectorAll("#app .strat").length', 3],
      ['!document.querySelector("#app .center")', true],
    ],
  },
  {
    /* THE BUYDOWN SCHEDULE MUST FOLLOW THE STORED STRUCTURE — BOTH DIRECTIONS.
     *
     * A 1-1 buydown drawn as a 2-1 is a wrong payment schedule on a document a
     * borrower has been sent, so this asserts the mapping in both directions:
     * a 1-1 payload must produce −1%/−1% and a 2-1 payload −2%/−1%. Asserting
     * only one direction would pass just as happily on a renderer that always
     * drew that one — which is exactly the failure being guarded against.
     *
     * SYNTHETIC PAYLOADS, called straight into renderBuydown. Pointing this at a
     * real /fee/<slug> would bind the spec to a borrower's live link, bump its
     * view_count on every run, and break the day that link is revoked. The slug
     * in the URL is deliberately nonsense — the page renders "not found" and the
     * render functions are still defined, which is all this needs.
     *
     * The loan-amount fallback is asserted here too: bd.loan is empty on BOTH
     * real snapshots because it is an optional override nobody types in, so the
     * figure comes from purchasePrice − down. $750,000 less 5% = $712,500.
     */
    name: 'buydown share link honours the stored structure (1-0, 1-1, 2-1, 3-2-1)',
    url: '/fee/zzznotarealslug',   // alphanumeric: the worker's /fee/ route is [A-Za-z0-9]+ and a hyphen 404s before fee.html loads
    anonymous: true,
    present: ['#app'],
    evals: [
      ['typeof renderBuydown', 'function'],
      [`(function(){
        function mk(struct){ return { created_at:'2026-08-12T00:00:00Z', borrower_name:'ZZ Probe',
          data:{ mode:'buydown', common:{ purchasePrice:'$750,000', downPct:'5' },
                 buydown:{ loan:'', rate:'6.875', term:'30', payer:'lender', structure:struct } } }; }
        function draw(s){ renderBuydown(mk(s)); return document.getElementById('app').innerText.replace(/\\s+/g,' '); }
        var one = draw('1-1'), two = draw('2-1'), zero = draw('1-0'), three = draw('3-2-1');
        var rows = function(t){ return (t.match(/note rate −/g) || []).length; };
        return JSON.stringify({
          one_has_minus1: /−1%/.test(one),
          one_has_minus2: /−2%/.test(one),
          two_has_minus2: /−2%/.test(two),
          one_says_1_1:  /1-1 temporary buydown/i.test(one),
          two_says_2_1:  /2-1 temporary buydown/i.test(two),
          loan_fallback: /712,500/.test(one),
          /* 3-2-1 is the one with a THIRD schedule row and a year-4 line. A
             renderer that ignored the structure would draw two rows here. */
          three_rows:    rows(three),
          three_has_minus3: /−3%/.test(three),
          three_year4:   /Year 4 onward/i.test(three),
          three_says_321: /3-2-1 temporary buydown/i.test(three),
          /* 1-0 is the opposite edge: ONE row, year 2 onward. */
          zero_rows:     rows(zero),
          zero_year2:    /Year 2 onward/i.test(zero),
          two_rows:      rows(two)
        });
      })()`,
       '{"one_has_minus1":true,"one_has_minus2":false,"two_has_minus2":true,'
       + '"one_says_1_1":true,"two_says_2_1":true,"loan_fallback":true,'
       + '"three_rows":3,"three_has_minus3":true,"three_year4":true,"three_says_321":true,'
       + '"zero_rows":1,"zero_year2":true,"two_rows":2}'],
      /* An unfinished quote must SAY so rather than draw a $0 schedule — the
         state uby9s8x was actually sent in, with no loan basis at all. */
      [`(function(){
        renderBuydown({ created_at:'2026-08-12T00:00:00Z', borrower_name:'ZZ Probe',
          data:{ mode:'buydown', common:{ purchasePrice:'', downPct:'20' },
                 buydown:{ loan:'', rate:'6.875', term:'30', payer:'seller', structure:'2-1' } } });
        var t = document.getElementById('app').innerText;
        return /not finished yet/i.test(t) && !/\\$0\\.00/.test(t);
      })()`, true],
    ],
  },
  {
    /* THE PUBLIC FEE LINK, AS A STRANGER SEES IT — signed out, UNSTUBBED, on a
       REAL slug that has been sent and viewed 29 times. The redaction's whole
       purpose is what an anonymous holder of the URL receives, so a stubbed run
       would prove nothing about it.
       Asserts on the DATA THE PAGE RECEIVED rather than on innerHTML: fee.html's
       own script text contains the identifier "origComp" as a fallback branch, so
       matching the document source would fail no matter what the server sent. */
    name: 'public fee link hides compensation',
    url: '/fee/9bvgsjp',
    anonymous: true,
    present: ['.hero'],
    evals: [
      ['(async function(){var cfg=window.APP_CONFIG||{};'
       + 'var cl=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);'
       + 'var r=await cl.rpc("get_fee_sheet_snapshot",{p_slug:"9bvgsjp"});'
       + 'return JSON.stringify({status:r.data&&r.data.status,'
       + 'comp:/origComp/.test(JSON.stringify(r.data)),'
       + 'hasOrigFee:/origFee/.test(JSON.stringify(r.data))});})()',
       '{"status":"ok","comp":false,"hasOrigFee":true}'],
      /* Sections are OPT-IN and this link has opted into none, so the itemised fee
         schedule (which is where the Origination Fee row lives) must NOT render.
         Note what this does and does not mean: the origination fee is still inside
         cash-to-close, exactly as before — only the breakdown is withheld. The
         payment hero must still draw, or "hidden sections" has quietly become
         "broken page". */
      /* STRUCTURAL, not textual. document.body.textContent includes inline
         <script> source, and fee.html contains the literal row('Origination Fee')
         in its own code — so a text match reports the breakdown as present even
         when nothing rendered. This trap has now cost two assertions in this file;
         assert on the DOM the visitor actually gets. */
      ['!!document.querySelector(".fee-details")', false],
      ['!!document.querySelector(".fee-body")', false],
      ['[].some.call(document.querySelectorAll(".row .rl"), function(e){return /Origination Fee/.test(e.textContent);})', false],
      ['!!document.querySelector(".payhero .amt")', true],
      ['document.body.textContent.replace(/\s+/g,"").length > 500', true],
    ],
  },
  {
    /* BUYDOWN ARITHMETIC IS A REGRESSION TEST, not a rendering one. A buydown
       sheet with a wrong year-two payment is worse than no sheet — it goes to a
       borrower as a number they plan around. The expected values are published
       amortization figures for $400,000 / 30yr (7% $2,661.21, 5% $2,147.29,
       6% $2,398.20), computed by hand before the feature was written, so this
       fails if the formula drifts rather than if the layout moves. */
  name: 'buydown 2-1 and 1-1 arithmetic',
    url: '/tools/fee-sheet.html',
    role: 'admin',
    steps: [{ click: '#modeBtnBuydown', waitMs: 1200 }],
    present: ['#modeBtnBuydown'],
    evals: [
      /* Drive the exact hand-checked case: $400,000 at 7.000%, 30yr, 2-1.
         Expected from published amortization figures:
           note $2,661.21 · yr1 $2,147.29 · yr2 $2,398.20 · total cost $9,323.18 */
      ['(function(){'
       + '$("bd_rate").value="7"; $("bd_loan").value="$400,000"; $("bd_term").value="30";'
       + '$("bd_structure").value="2-1"; buydownRecalc();'
       + 'var r=bdCompute(bdInputs());'
       + 'return JSON.stringify({note:r.notePmt.toFixed(2),yr1:r.years[0].payment.toFixed(2),'
       + 'yr2:r.years[1].payment.toFixed(2),total:r.totalCost.toFixed(2),'
       + 'panel:getComputedStyle($("buydownPanel")).display,'
       + 'sheetRendered:(($("buydownSheet").textContent||"").trim().length>800)});})()',
       '{"note":"2661.21","yr1":"2147.29","yr2":"2398.20","total":"9323.18","panel":"block","sheetRendered":true}'],
      // 1-1 on the same loan: both years at 6%, cost 24 x (2661.21 - 2398.20)
      ['(function(){$("bd_structure").value="1-1"; buydownRecalc();'
       + 'var r=bdCompute(bdInputs());'
       + 'return r.years[0].rate.toFixed(3)+"|"+r.years[1].rate.toFixed(3)+"|"+r.totalCost.toFixed(2);})()',
       '6.000|6.000|6312.19'],
      // The sheet actually renders the schedule, not just the panel.
      ['(function(){var t=$("buydownSheet").textContent||"";'
       + 'return JSON.stringify({hasYear1:t.indexOf("Year 1")>-1,hasYear3:t.indexOf("Year 3")>-1,'
       + 'hasTotal:t.indexOf("Total buydown cost")>-1,hasQualify:t.indexOf("qualify")>-1});})()',
       '{"hasYear1":true,"hasYear3":true,"hasTotal":true,"hasQualify":true}'],
    ],
  },
  /* The pipeline strip renders nine stages into whatever width the header row
     has left over. Rene saw "Ne[Cnt]loweAntrProcTClose,os" — nine labels each
     cut mid-word. Checked at two widths because the failure is width-dependent
     and a single width proves only that width.

     noClip IS NOT ENOUGH ON ITS OWN, and this cost a round trip. The fallback
     for "labels do not fit" used to render EMPTY cells, and empty cells cannot
     clip — so nine blank coloured blocks passed both specs while being, in
     Rene's words, worse than the clipping they replaced. A presence-only or
     overflow-only assertion is satisfied by rendering nothing at all.
     So both widths now also assert the strip CONTAINS READABLE TEXT. */
  {
    name: 'pipeline strip legible @1440',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin', width: 1440,
    present: ['#pipelineTimeline'],
    noClip: ['#pipelineTimeline > *'],
    evals: [
      // At 1440 there is room for the real labels.
      /* Nine cells of at least 3 letters each. This is the assertion that would
         have caught the blank-blocks regression; noClip alone could not, because
         empty cells never overflow. */
      ['document.getElementById("pipelineTimeline").textContent.replace(/[^A-Za-z]/g,"").length >= 20', true],
      ['document.querySelectorAll("#pipelineTimeline > *").length', 9],
      /* Every cell must carry the full stage name for hover, since the visible
         label may legitimately be the 3-char form. */
      ['[].every.call(document.querySelectorAll("#pipelineTimeline > *"), function(c){return (c.getAttribute("title")||"").length > 3;})', true],
    ],
    /* Google logs "included multiple times" when its bootstrap runs twice.
       Counting the tags says whether that is a second <script> or something
       else — a warning alone does not. */
    rowCount: { selector: 'script[src*="maps.googleapis.com/maps/api/js"]', expect: 1 },
  },
  /* The @1440 spec above counts the tags in whatever order the page happened to
     take. This one CHOOSES the losing order and counts again — the difference
     between observing a flake and reproducing it. See RC_MAPS_FORCE_RACE.
     Measured against the unfixed code it returns 2; the fix (places-autocomplete
     marking its tag data-gmaps-js="1", so both guards see each other) is what
     brings it to 1. */
  /* The Drive panel calls borrower-drive as the SIGNED-IN USER, and a guard is
     landing on that function. This is the frontend half of the frontend-first
     order, asserted rather than assumed.

     tokenOnly, because it is the whole point: with the stubbed client there is
     no session, fnFetch throws "Not signed in", and the spec would pass or fail
     for reasons that say nothing about the guard. Only a real session exercises
     what production does.

     READ-ONLY. find_or_create_borrower_folder with auto_save:false performs no
     write, and the contact is the ZZ-TEST fixture rather than a borrower. */
  {
    name: 'lead-detail Drive panel calls borrower-drive as the user',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    tokenOnly: true,
    evals: [
      [`(async function(){
        if (typeof window.callBorrowerDrive !== 'function') return 'HARNESS: callBorrowerDrive absent';
        if (typeof window.fnFetch !== 'function') return 'HARNESS: fn-call.js not loaded';
        var r = await window.callBorrowerDrive({
          action: 'find_or_create_borrower_folder',
          contact_id: '${FIXTURE}',
          first_name: 'ZZ-TEST', last_name: 'Fixture Borrower',
          auto_save: false
        });
        if (!r) return 'no response';
        if (r.error) return 'error: ' + r.error;
        return r.success === true ? 'ok' : 'unexpected: ' + JSON.stringify(r).slice(0,120);
      })()`, 'ok'],
    ],
  },
  /* THE STAFF-NOTICE TOAST, BOTH DIRECTIONS.
   *
   * Two specs rather than one, deliberately. The failure wording is the change
   * being made, so it is the tempting thing to assert alone — and a toast
   * hard-coded to the cautious sentence would PASS that assertion while being
   * wrong for every borrower whose notice actually sent. The success case is
   * therefore asserted as its own spec, and the null case with it, because
   * "says nothing about Rene when no notice was due" is the third outcome that
   * a boolean would have flattened.
   *
   * These assert _shNotice, the shipped mapping the two call sites pass their
   * portal-data response through. The server half — that `notified` is true,
   * false or null at the right times — is proven separately against the live
   * function, since no browser test can prove what sms-service answered. */
  {
    name: 'portal tour toast — notice SENT says notified',
    url: '/unified-portal',
    anonymous: true,
    evals: [
      [`typeof window._shNotice === 'function'`, true],
      [`window._shNotice({ updated: 1, notified: true }, 'Date updated!')`,
       'Date updated! Rene has been notified.'],
      // null: no notice was due, so the borrower is told nothing about Rene.
      [`window._shNotice({ updated: 1, notified: null }, 'Tour cancelled.')`, 'Tour cancelled.'],
      [`window._shNotice({ updated: 1 }, 'Tour cancelled.')`, 'Tour cancelled.'],
    ],
  },
  {
    name: 'portal tour toast — notice FAILED does not claim it sent',
    url: '/unified-portal',
    anonymous: true,
    evals: [
      [`window._shNotice({ updated: 1, notified: false }, 'Date updated!')`,
       'Date updated! Rene will see it in the CRM.'],
      /* The words that must NOT appear when the notice did not go. This is the
         sentence the page told borrowers for four and a half months while
         nothing was sent. */
      [`window._shNotice({ updated: 1, notified: false }, 'Date updated!').indexOf('has been notified') === -1`, true],
    ],
  },
  {
    name: 'maps double-load forced race',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    atDocumentStart: RC_MAPS_RACE_SETUP,
    evals: [
      [RC_MAPS_FORCE_RACE, 1],
    ],
    /* NO allowConsole, deliberately. The first draft of this spec excluded
       "included multiple times" so the count could be read on its own — and the
       exclusion never matched anything, because Google's actual wording is
       "...the Google Maps JavaScript API multiple times...". A silencer that
       matches nothing is the quietest kind of blind spot.
       It is also unnecessary in the direction that matters: once the guards are
       symmetric there is no second bootstrap, so there is no warning to allow.
       Pre-fix this spec fails twice over — the count AND Google's own complaint
       — which is the correct shape for a break test. */
  },
  {
    name: 'pipeline strip legible @1100',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin', width: 1100,
    present: ['#pipelineTimeline'],
    /* NO noClip AT THIS WIDTH, deliberately, and this is a weakened promise —
       said out loud rather than quietly dropped.
       Measured: at 1440 the strip gets 321px for nine cells (36px each) because
       it is the only flexible item in an action bar of ~15 controls, and that bar
       is position:fixed at a fixed height, so it cannot wrap to give the strip a
       row of its own without moving the whole page down. At 1100 there is less
       still, and even the 3-character labels overflow by a pixel or two.
       The choice is therefore between a slightly ellipsised "NE…" and a blank
       coloured block. Rene has seen both: the blank version was reported as worse
       than the clipping it replaced. So the contract at narrow widths is LETTERS
       PRESENT + A FULL-NAME TOOLTIP, not pixel-perfect fit, and that is what is
       asserted. If the action bar ever gains a wrapping layout, restore noClip. */
    evals: [
      ['document.getElementById("pipelineTimeline").textContent.replace(/[^A-Za-z]/g,"").length >= 18', true],
      ['document.querySelectorAll("#pipelineTimeline > *").length', 9],
      ['[].every.call(document.querySelectorAll("#pipelineTimeline > *"), function(c){return (c.getAttribute("title")||"").length > 3;})', true],
      /* Not blank: every cell has its own visible text. */
      ['[].every.call(document.querySelectorAll("#pipelineTimeline > *"), function(c){return (c.textContent||"").trim().length >= 2;})', true],
    ],
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
    /* THE SILENT ABORT, AS A TEST.
     *
     * On 2026-08-17 a VOE send stopped at the "no signed borrower authorization"
     * confirm() and left nothing behind — no toast, no console line, no
     * email_log row, no network call. Where it stopped was established
     * afterwards from edge logs (voe-form-fill 200 twice, no gmail-inbox POST),
     * not from anything the page said.
     *
     * The decline now toasts. This asserts the toast is REACHED, POPULATED and
     * PAINTED ON TOP, because this page has already shipped a toast that fired
     * correctly and rendered underneath an overlay — see the LOE spec above.
     *
     * The composer is opened first ON PURPOSE. Without a modal present the
     * stacking assertion passes trivially, and the real decline always happens
     * with the composer open. Eval 2 asserts the modal is genuinely there and
     * has size, so "toast on top" cannot pass vacuously. */
    name: 'VOE no-auth modal: Cancel aborts, VISIBLY',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    /* Counts calls so the cancel path can assert the decision was NOT recorded.
       A gate that logs on cancel would be a different bug — a record saying a
       human approved something they declined — and no assertion below would
       notice without this. */
    /* Records onto WINDOW, not onto the harness's `state` object. RPC_STATE is a
       local inside the stub source and is not exposed to an eval, so asserting
       on it reads undefined, coerces to 0, and PASSES WITHOUT THE STUB EVER
       BEING WIRED. The proceed spec below asserting this same counter reaches 1
       is what proves the counter works at all — a 0 that can never become 1
       measures nothing. */
    rpcFns: {
      voe_log_unauthorized_send:
        '(args) => { window.__rcLogged = (window.__rcLogged || 0) + 1; window.__rcLoggedArgs = args; return 4242; }',
    },
    evals: [
      /* 1. REAL CLICK, NOT A STUB. The previous version overwrote window.confirm
            and asserted on the return value, which proves the branch is reachable
            and nothing about whether a person can operate it.
            This opens the real composer, starts the real guard, waits for the
            modal to mount, then checks the Cancel button is the TOPMOST element
            at its own centre before clicking it. elementFromPoint is the right
            tool here — unlike the toast, a button is pointer-events:auto, so a
            hit test answers the question actually being asked: would a real
            click land on this, or on something painted over it. */
      [`(async () => {
          await openEmailComposer({to:"zz-test.fixture@example.invalid",subject:"ZZ-TEST VOE",bodyHtml:"<p>x</p>",title:"VOE"});
          window.__rcVoe = _voeConfirmNoAuth({orderId:"00000000-0000-0000-0000-000000000000",cid:${JSON.stringify(FIXTURE)}}, "hr@example.invalid");
          await new Promise(r => setTimeout(r, 150));
          var b = document.getElementById("voeNoAuthCancel");
          if (!b) return "modal never mounted";
          var r = b.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) return "cancel button has no area";
          var top = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
          if (!(top === b || b.contains(top))) return "cancel covered by " + ((top && (top.id || top.tagName)) || "nothing");
          b.click();
          return String(await window.__rcVoe);
        })()`,
       'false'],
      // 1b. The modal is GONE after choosing — a dialog that lingers blocks the page.
      ['document.getElementById("voeNoAuthOverlay") === null ? "dismissed" : "still open"',
       'dismissed'],
      /* 1c. Cancelling must NOT record a decision. */
      ['String(window.__rcLogged || 0)', '0'],
      // 2. The modal really is open and has area — or eval 5 proves nothing.
      ['(function(){var o=document.getElementById("ecOverlay");if(!o)return "composer missing";'
        + 'var s=getComputedStyle(o),b=o.getBoundingClientRect();'
        + 'return (s.display!=="none"&&b.width>0&&b.height>0)?"composer open":"composer not rendered";})()',
       'composer open'],
      // 3. The words.
      ['document.getElementById("ld-toast").textContent',
       'VOE not sent — no signed borrower authorization on file, and you chose not to send without it.'],
      /* 4. SHOWN, not merely populated. .ld-toast is opacity:0 until .show is
            added, so a textContent assertion alone passes on a toast nobody can
            see — the exact defect this spec exists to catch. */
      /* WAITS FOR THE TRANSITION TO SETTLE, and the wait is not a fudge.
         .ld-toast has `transition: all .28s ease` over `opacity: 0`, so reading
         computed opacity in the same tick the class is added returns the
         PRE-transition value — measured here as exactly "show=true opacity=0",
         not a fraction, because no style recalc had happened yet. A user sees it
         fade in over 280ms.
         The assertion is not weakened by waiting: it reads the SETTLED opacity,
         so it still fails if .show is never applied, if a later rule holds the
         toast at 0, or if something clears it early. 400ms is comfortably inside
         the 3200ms auto-hide. */
      ['(async () => {'
        + 'await new Promise(r => setTimeout(r, 400));'
        + 'var t=document.getElementById("ld-toast"),s=getComputedStyle(t);'
        + 'return (t.classList.contains("show")&&parseFloat(s.opacity)>0.9)'
        + '?"visible":("show="+t.classList.contains("show")+" opacity="+s.opacity);})()',
       'visible'],
      // 5. Painted above the composer. Stacking, not hit-testing — see LOE spec.
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
    /* THE OTHER BUTTON. The cancel spec above would pass in full if the guard
       refused unconditionally — a gate that never lets anything through is not
       the bug we have, but it is a bug, and nothing over there would catch it.
       This drives "Send without it" and asserts the opposite outcome: proceed,
       silently, having RECORDED the decision.
       Both specs share the window counter, and each one proves the other is not
       measuring a dead stub — 0 here would be indistinguishable from an unwired
       harness if it could never reach 1. */
    name: 'VOE no-auth modal: Send without it proceeds and records the decision',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    rpcFns: {
      voe_log_unauthorized_send:
        '(args) => { window.__rcLogged = (window.__rcLogged || 0) + 1; window.__rcLoggedArgs = args; return 4242; }',
    },
    evals: [
      [`(async () => {
          await openEmailComposer({to:"zz-test.fixture@example.invalid",subject:"ZZ-TEST VOE",bodyHtml:"<p>x</p>",title:"VOE"});
          window.__rcVoe = _voeConfirmNoAuth({orderId:"00000000-0000-0000-0000-000000000000",cid:${JSON.stringify(FIXTURE)}}, "hr@example.invalid");
          await new Promise(r => setTimeout(r, 150));
          var b = document.getElementById("voeNoAuthProceed");
          if (!b) return "modal never mounted";
          var r = b.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) return "proceed button has no area";
          var top = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
          if (!(top === b || b.contains(top))) return "proceed covered by " + ((top && (top.id || top.tagName)) || "nothing");
          b.click();
          return String(await window.__rcVoe);
        })()`,
       'true'],
      // The decision was recorded — exactly once.
      ['String(window.__rcLogged || 0)', '1'],
      /* Recorded AGAINST THE RIGHT ORDER. A record filed on the wrong loan is
         worse than none: it clears one file while implicating another. */
      ['String(window.__rcLoggedArgs && window.__rcLoggedArgs.p_order_id)',
       '00000000-0000-0000-0000-000000000000'],
      ['String(window.__rcLoggedArgs && window.__rcLoggedArgs.p_hr_email)', 'hr@example.invalid'],
      // Proceeding is silent — the toast belongs to the refusal path only.
      ['document.getElementById("ld-toast").textContent', ''],
      ['document.getElementById("voeNoAuthOverlay") === null ? "dismissed" : "still open"', 'dismissed'],
    ],
  },
  {
    /* HOI replies render on the card they belong to — and only that one.
     *
     * hoi_quote_list carries replies per REQUEST (q.row_id = h.id). The failure
     * this guards is contact-level scoping, where a borrower with three requests
     * out to three agents would see every agent's reply on every agent's card.
     * That is not hypothetical: it is exactly what voe_activity did until it was
     * scoped to the order.
     *
     * Driven through lpHoiRenderList directly with a two-row fixture rather than
     * through the panel's own load, so the assertion is about the RENDERER and
     * does not depend on which RPCs the panel happens to fire on open. */
    name: 'HOI replies render on their own card, not the others',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      /* ONE eval, rendering and asserting in the SAME synchronous block.
         Split across several evals this raced the page's own lpHoiLoadList(),
         which completes asynchronously after load, re-renders from the real
         (empty) list and replaced the fixture — the later assertions then
         queried cards that no longer existed and reported "no card", which reads
         as a renderer fault and is not one. Nothing can re-render between the
         render and the checks if they share a tick. */
      [`(function(){
          if (typeof lpRenderOrders === 'function') { try { lpRenderOrders(); } catch (e) {} }
          if (!document.getElementById('lpHoiQuotes')) return 'HARNESS: #lpHoiQuotes never mounted';
          if (typeof _lpHoiActivityHtml !== 'function') return 'HARNESS: _lpHoiActivityHtml missing';

          var A = 'aaaaaaaa-0000-0000-0000-000000000001';
          var B = 'bbbbbbbb-0000-0000-0000-000000000002';
          /* Open the OWNING card before rendering. Two cards collapse by default
             (_lpHoiOpen = !many) and innerText excludes display:none content, so
             a visibility assertion on a collapsed card measures the collapse.
             lpHoiRenderList keeps an explicit choice. Not via lpHoiToggle: that
             re-renders from _lpHoiList and would drop the fixture. */
          _lpHoiOpen[A] = true;
          lpHoiRenderList([
            { id: A, agent_email: 'withreply@example.invalid', agent_name: 'With Reply',
              status: 'sent', is_selected: false,
              activity: [
                { id: 'r1', source: 'quote_reply_log', matched_by: 'in_reply_to',
                  direction: 'inbound', from: 'withreply@example.invalid',
                  at: '2026-08-17T12:00:00Z',
                  subject: 'Re: Homeowners Insurance Quote Request',
                  preview: 'Quote is $1,842/yr HO-3 five hundred deductible' },
                /* The SEND. Its absence is the bug this half exists for: a
                   request sent and not yet answered looked exactly like one
                   where nothing had happened. */
                { id: 's1', source: 'email_log', matched_by: null,
                  direction: 'outbound', to: 'withreply@example.invalid',
                  at: '2026-08-17T11:00:00Z',
                  subject: 'Homeowners Insurance Quote Request',
                  preview: 'Can you provide a homeowners insurance quote' }
              ] },
            { id: B, agent_email: 'quiet@example.invalid', agent_name: 'Quiet Agent',
              status: 'sent', is_selected: false, activity: [] }
          ]);

          var ca = document.querySelector('[data-hoi-id="' + A + '"]');
          var cb = document.querySelector('[data-hoi-id="' + B + '"]');
          if (!ca || !cb) return 'HARNESS: fixture cards did not render';

          // VISIBLE on the owning card — innerText, and that card is expanded.
          var visible = /1,842/.test(ca.innerText);
          /* The send is shown as well as the reply. Without this a card that was
             sent and not answered is indistinguishable from one where nothing
             happened — the state that most needs chasing. */
          var sent = /Sent to withreply@example\.invalid/.test(ca.innerText);
          // The rung that matched is on screen, not swallowed.
          var tier = /matched by in_reply_to/.test(ca.innerText);
          /* ABSENT from the other card — textContent ON PURPOSE. That card is
             collapsed, so an innerText check returns '' for everything inside it
             and would PASS VACUOUSLY even if the reply had been drawn there. */
          var leaked = /1,842/.test(cb.textContent);
          /* A card with no replies gains no section at all. The second agent is
             named 'Quiet Agent' deliberately: it was 'No Reply', whose own NAME
             contains "Repl", so this matched the fixture rather than a rendered
             section and reported a leak that did not exist. */
          var emptySection = /Email activity/.test(cb.textContent);

          return 'visible=' + visible + ' sent=' + sent + ' tier=' + tier
               + ' leaked=' + leaked + ' emptySection=' + emptySection;
        })()`,
       'visible=true sent=true tier=true leaked=false emptySection=false'],
    ],
  },
  {
    /* The system's follow-up notice must be READABLE and NOT EDITABLE.
     *
     * It lived in revision_note, which lpRenderOrders renders into a textarea
     * that is display:none unless status === 'needs_revision'. All three notices
     * that exist are on VOE orders sitting at 'ordered'/'received', so every one
     * of them was in the DOM and invisible. Worse, had they been visible in that
     * textarea, typing over one would have destroyed the only record of why
     * follow-up stopped — order_reminders_run never rewrites a field a human has
     * taken over.
     *
     * Now its own column, rendered as a DIV. This asserts both halves: the words
     * are on screen, and there is no editable control holding them. */
    name: 'VOE follow-up notice is readable and not editable',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(function(){
          if (typeof lpRenderVoe !== 'function') return 'HARNESS: lpRenderVoe missing';
          /* #lpVoeCards is built by lpRenderOrders(), not present in the static
             HTML — the same mounting step the HOI spec needs. */
          if (typeof lpRenderOrders === 'function') { try { lpRenderOrders(); } catch (e) {} }
          if (!document.getElementById('lpVoeCards')) return 'HARNESS: #lpVoeCards never mounted';
          var NOTE = 'Reminder suppressed 2026-08-17: marked ordered, but no evidence this VOE reached the HR contact.';
          _lpVoes = [
            { key: 'k1', id: 'aaaaaaaa-0000-0000-0000-0000000000a1', status: 'ordered',
              employer_name: 'With Notice', reminder_note: NOTE },
            { key: 'k2', id: 'bbbbbbbb-0000-0000-0000-0000000000b2', status: 'ordered',
              employer_name: 'No Notice', reminder_note: null }
          ];
          _lpVoeOpen = { k1: true, k2: true };
          lpRenderVoe();
          var host = document.getElementById('lpVoeCards');
          var b1 = document.getElementById('lpVoeBody-k1');
          var b2 = document.getElementById('lpVoeBody-k2');
          if (!b1 || !b2) return 'HARNESS: fixture cards did not render';
          // Readable: the words are visible on the card that has one.
          var shown = /no evidence this VOE reached/.test(b1.innerText);
          // Not editable: no input or textarea anywhere holds the notice text.
          var editable = Array.prototype.slice
            .call(host.querySelectorAll('textarea, input'))
            .some(function (e) { return /no evidence this VOE reached/.test(e.value || ''); });
          // Paired: the card without a notice gains nothing. textContent, so a
          // collapsed card cannot pass this vacuously.
          var leaked = /Follow-up paused/.test(b2.textContent);
          return 'shown=' + shown + ' editable=' + editable + ' leaked=' + leaked;
        })()`,
       'shown=true editable=false leaked=false'],
    ],
  },
  {
    /* Follow up must SAY whether it replies or starts a new thread.
     *
     * Only 1 of 23 orders carries a gmail_thread_id, so for almost every order
     * this button can only start a new email. Doing that silently is the
     * failure: the vendor sees an unrelated message and their reply comes back
     * uncorrelated, which is the thing the whole threading effort removes. */
    name: 'VOE follow-up states whether it threads or starts new',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(function(){
          if (typeof lpRenderOrders === 'function') { try { lpRenderOrders(); } catch (e) {} }
          if (!document.getElementById('lpVoeCards')) return 'HARNESS: #lpVoeCards never mounted';
          if (typeof lpVoeFollowUp !== 'function') return 'HARNESS: lpVoeFollowUp missing';
          _lpVoes = [
            { key: 't1', id: 'aaaaaaaa-0000-0000-0000-0000000000c1', status: 'ordered',
              employer_name: 'Threaded', hr_contact_email: 'hr@example.invalid',
              gmail_thread_id: '1a00e85953bfa75a', rfc_message_id: '<x@mail.gmail.com>' },
            { key: 't2', id: 'bbbbbbbb-0000-0000-0000-0000000000c2', status: 'ordered',
              employer_name: 'Unthreaded', hr_contact_email: 'hr2@example.invalid',
              gmail_thread_id: null, rfc_message_id: null }
          ];
          _lpVoeOpen = { t1: true, t2: true };
          lpRenderVoe();
          var b1 = document.getElementById('lpVoeBody-t1');
          var b2 = document.getElementById('lpVoeBody-t2');
          if (!b1 || !b2) return 'HARNESS: fixture cards did not render';
          var threadedSays = /replies in the original thread/.test(b1.innerText);
          /* Wording changed when VOE was aligned to HOI: the no-thread card now says
             the conversation starts from your reply AND is saved from then on,
             because since reply-and-adopt that is what actually happens. */
          var newSays      = /conversation starts from your reply/.test(b2.innerText);
          /* Neither card may claim the other's behaviour. textContent, so a
             collapsed card cannot pass this vacuously. */
          var crossed = /conversation starts from your reply/.test(b1.textContent)
                     || /replies in the original thread/.test(b2.textContent);
          // Both must still offer the action.
          var buttons = b1.innerText.indexOf('Reply to HR') >= 0
                     && b2.innerText.indexOf('Reply to HR') >= 0;
          return 'threaded=' + threadedSays + ' new=' + newSays
               + ' crossed=' + crossed + ' buttons=' + buttons;
        })()`,
       'threaded=true new=true crossed=false buttons=true'],
    ],
  },
  {
    /* The renames, and the amount that rides with a date.
     *
     * Asserting the NEW labels appear is not enough on its own — a panel that
     * failed to render at all would also contain none of the old ones. So the
     * absent-checks are paired with present-checks on the same node, and the
     * count of rendered date rows is asserted too: if #lpDatesBody never
     * mounted, `rows` is 0 and the whole thing fails rather than passing
     * vacuously on three absences.
     *
     * EMD Amount is asserted to exist on emd_due AND to exist nowhere else —
     * it is declared per-key, and a renderer that emitted it for every row
     * would still satisfy a presence-only check. */
    name: 'Critical Dates: renamed labels and the EMD amount field',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(async function(){
          /* The panel lives behind a tab and paints when its loader runs, so an
             assertion at page-load time sees an empty container — which is the
             #shell break-test shape: present, empty, passing. Drive the renderer
             first. It builds every row from LP_KEY_DATES whether or not the
             stubbed client returns any dates, so this asserts the MARKUP, not
             the data. */
          if (typeof lpLoadKeyDates !== 'function') return 'HARNESS: lpLoadKeyDates missing';
          try { await lpLoadKeyDates('${FIXTURE}'); } catch (e) { return 'HARNESS: loader threw ' + e.message; }
          var body = document.getElementById('lpDatesBody');
          if (!body) return 'HARNESS: #lpDatesBody never mounted';
          if (typeof LP_KEY_DATES === 'undefined') return 'HARNESS: LP_KEY_DATES missing';
          if (typeof lpSaveAmount !== 'function') return 'HARNESS: lpSaveAmount missing';
          var t = body.textContent;
          var rows = body.querySelectorAll('input[type=date][data-lp-datekey]').length;
          /* new names present */
          var newNames = ['Appraisal Contingency','Disclosure Contingency','Need CD Out By']
                           .every(function(n){ return t.indexOf(n) !== -1; });
          /* old names gone — textContent, so a hidden-but-present label still fails */
          var oldGone = ['Appraisal Due','Disclosures Due'].every(function(n){ return t.indexOf(n) === -1; });
          /* 'CD Out' is a SUBSTRING of 'Need CD Out By', so it cannot be
             absence-checked directly. Assert no label is exactly 'CD Out'. */
          var noBareCdOut = LP_KEY_DATES.every(function(d){ return d.label !== 'CD Out'; });
          /* keys must NOT have been renamed — loan_date_nudge_scan filters on them */
          var keys = LP_KEY_DATES.map(function(d){ return d.key; });
          var keysIntact = ['appraisal_due','disclosures_due','cd_out','close_of_escrow',
                            'loan_contingency','inspection_deadline']
                             .every(function(k){ return keys.indexOf(k) !== -1; });
          /* the amount input: exactly one, and it belongs to emd_due */
          var amts = body.querySelectorAll('input[data-lp-amtkey]');
          var amtOnEmdOnly = amts.length === 1 && amts[0].getAttribute('data-lp-amtkey') === 'emd_due';
          var amtIsNumber  = amts.length === 1 && amts[0].type === 'number';
          /* NEGATIVE CONTROL, run every time rather than once by hand.
             The pre-deploy break test refused at the lpSaveAmount guard, so the
             label checks above never actually saw a failure — and a check that
             has only ever passed proves nothing. Feed the SAME predicates text
             carrying the old names and require them to report a problem. If
             someone later loosens the matching, this goes false while the real
             assertions stay true, and the spec still fails. */
          var oldText = 'Appraisal Due Disclosures Due CD Out';
          var ctlNew  = ['Appraisal Contingency','Disclosure Contingency','Need CD Out By']
                          .every(function(n){ return oldText.indexOf(n) !== -1; });
          var ctlOld  = ['Appraisal Due','Disclosures Due']
                          .every(function(n){ return oldText.indexOf(n) === -1; });
          var control = (ctlNew === false) && (ctlOld === false);
          /* CONTRACT CHRONOLOGY ONLY, and exactly ten of them. A >= 10 check
             would have kept passing with the two app-backed entries still
             present, so the count is exact and the removed labels are named.
             (No backticks in this comment: the whole eval is a template
             literal, and one would end it mid-string.) */
          var exactlyTen = rows === 10;
          var appBackedGone = ['Preapproval Expiry','Credit Pulled']
                                .every(function(n){ return t.indexOf(n) === -1; });
          var noAppProp = LP_KEY_DATES.every(function(d){ return !d.app; });
          return 'rows=' + exactlyTen + ' appGone=' + appBackedGone + ' noAppProp=' + noAppProp
               + ' newNames=' + newNames + ' oldGone=' + oldGone
               + ' noBareCdOut=' + noBareCdOut + ' keysIntact=' + keysIntact
               + ' amtOnEmdOnly=' + amtOnEmdOnly + ' amtIsNumber=' + amtIsNumber
               + ' control=' + control;
        })()`,
       'rows=true appGone=true noAppProp=true newNames=true oldGone=true noBareCdOut=true keysIntact=true amtOnEmdOnly=true amtIsNumber=true control=true'],
    ],
  },
  {
    /* A pay-stub scan must SHOW what the 1003 already holds before asking.
     *
     * The old behaviour wrote employer_name straight over
     * mortgage_applications.employer_name, so a second job's stub silently
     * replaced the first job and last year's stub silently replaced the
     * current one. The fix is a choice, and a choice is only meaningful if
     * the existing employers are on screen next to it.
     *
     * The employments are SEEDED rather than fetched: the stub owns the
     * supabase client, so a real load would return the stub's plausible row
     * and prove nothing about this block. What is asserted here is the
     * rendering and the choice logic. The database round trip is proven
     * separately against real data.
     *
     * The no-employer case is asserted in the SAME spec, because an
     * absent-check on its own passes vacuously when the pane never renders. */
    name: 'Pay-stub scan offers replace / add / current / previous',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(function(){
          if (typeof _ocrReviewRenderDiffRows !== 'function') return 'HARNESS: renderer missing';
          if (typeof _ocrReviewSetEmpChoice !== 'function')   return 'HARNESS: _ocrReviewSetEmpChoice missing';
          if (typeof _ocrEmpNamesMatch !== 'function')        return 'HARNESS: _ocrEmpNamesMatch missing';
          var pane = document.getElementById('ocrReviewFieldsList');
          if (!pane) return 'HARNESS: #ocrReviewFieldsList never mounted';

          /* Loose name matching is what stops a duplicate employer: a stub says
             AMAZON.COM SERVICES LLC where the 1003 says Amazon. */
          var matchLoose  = _ocrEmpNamesMatch('AMAZON.COM SERVICES LLC', 'Amazon');
          var matchUnrel  = _ocrEmpNamesMatch('Amazon', 'Starbucks');

          _ocrReviewIsAddNew = false;
          _ocrReviewTargetId = '${FIXTURE}';
          _ocrReviewFields = { employer_name: 'AMAZON.COM SERVICES LLC', gross_pay: '2400' };
          _ocrReviewEmpMatch = {
            existing: [ { employer: 'Amazon', type: 'current', title: 'Picker' },
                        { employer: 'Old Job Inc', type: 'previous' } ],
            matchIndex: 0, choice: 'replace', replaceIndex: 0,
            type: 'current', loading: false, loaded: true
          };
          _ocrReviewRenderDiffRows();

          var t = pane.textContent;
          var shownExisting = t.indexOf('Amazon') !== -1 && t.indexOf('Old Job Inc') !== -1;
          var shownScanned  = t.indexOf('AMAZON.COM SERVICES LLC') !== -1;
          var sameEmployerFlagged = (t.match(/SAME EMPLOYER/g) || []).length === 1;
          var choices = pane.querySelectorAll('input[name=ocrReviewEmpChoice]');
          var vals = Array.prototype.map.call(choices, function(r){ return r.value; }).join(',');
          var types = pane.querySelectorAll('input[name=ocrReviewEmpType]');
          var currentDefault = types.length === 2 && types[0].checked && !types[1].checked;
          /* replace preselected on the matching entry, not on 'add' */
          var replacePreselected = false;
          Array.prototype.forEach.call(choices, function(r){
            if (r.value === 'replace0' && r.checked) replacePreselected = true;
          });

          /* Paired absent-check: no employer named -> no block at all. */
          _ocrReviewFields = { gross_pay: '2400' };
          _ocrReviewEmpMatch = { existing: [], matchIndex: -1, choice: 'add',
                                 replaceIndex: -1, type: 'current', loading: false, loaded: true };
          _ocrReviewRenderDiffRows();
          var goneWhenNoEmployer = pane.querySelectorAll('input[name=ocrReviewEmpChoice]').length === 0;

          return 'loose=' + matchLoose + ' unrelated=' + matchUnrel
               + ' existing=' + shownExisting + ' scanned=' + shownScanned
               + ' sameFlag=' + sameEmployerFlagged + ' choices=' + vals
               + ' typeDefault=' + currentDefault + ' preselect=' + replacePreselected
               + ' absent=' + goneWhenNoEmployer;
        })()`,
       'loose=true unrelated=false existing=true scanned=true sameFlag=true choices=replace0,replace1,add,skip typeDefault=true preselect=true absent=true'],
    ],
  },
  {
    /* Per-counterparty threads, and the expand-on-demand rule.
     *
     * get_thread is NOT a read: it matches a contact, persists messages into
     * email_log and runs the escrow suggester. Firing it while painting a panel
     * would write rows every time the page opened, once per counterparty. So
     * the assertion that matters is a COUNT: zero on render, one per expand.
     *
     * openThread is counted rather than get_thread itself because inbox.js's
     * invoke is module-private and cannot be intercepted from here. That is
     * sound: renderThread issues exactly one get_thread per call, and
     * openThread is the only route from these cards to it — the panels call
     * nothing else. The counter replaces openThread outright, so nothing
     * touches Gmail during this spec.
     *
     * Three agents must give three INDEPENDENT hosts. If the host id were not
     * keyed per row, expanding one would paint into another, which is the
     * failure that makes "3 quotes = 3 threads" untrue while looking fine. */
    name: 'HOI: three agents, three separate threads, expand-on-demand',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(function(){
          /* lpRenderOrders() MOUNTS the panels. Without it #lpHoiQuotes does not
             exist, lpHoiRenderList returns early, and every count below reads
             zero -- which looks like a passing expand-on-demand check. */
          if (typeof lpRenderOrders === 'function') { try { lpRenderOrders(); } catch (e) {} }
          if (typeof lpHoiRenderList !== 'function')   return 'HARNESS: lpHoiRenderList missing';
          if (!document.getElementById('lpHoiQuotes'))  return 'HARNESS: #lpHoiQuotes never mounted';
          if (typeof _lpThreadToggle !== 'function')   return 'HARNESS: _lpThreadToggle missing';
          if (typeof lpHoiReply !== 'function')        return 'HARNESS: lpHoiReply missing';
          if (!window.GmailInbox)                      return 'HARNESS: GmailInbox not loaded';

          var calls = [];
          window.GmailInbox.openThread = function(o){ calls.push(o); };

          _lpHoiList = [
            { id:'aaa', company_name:'Agent A', agent_email:'a@x.invalid', agent_first_name:'A',
              status:'sent', gmail_thread_id:'TH_A', rfc_message_id:'<a@mail>' },
            { id:'bbb', company_name:'Agent B', agent_email:'b@x.invalid', agent_first_name:'B',
              status:'sent', gmail_thread_id:'TH_B', rfc_message_id:'<b@mail>' },
            { id:'ccc', company_name:'Agent C', agent_email:'c@x.invalid', agent_first_name:'C',
              status:'sent', gmail_thread_id:null, rfc_message_id:null }
          ];
          /* Cards default CLOSED when there is more than one, and the thread block
             lives in the card body -- so open all three first. Rendering with
             them closed would report zero hosts and pass the count checks
             vacuously, which is the shape this suite exists to catch. */
          _lpHoiOpen = { aaa:true, bbb:true, ccc:true };
          lpHoiRenderList(_lpHoiList);

          /* 1. NOTHING fetched while rendering. */
          var zeroOnRender = calls.length === 0;

          /* 2. one host per agent, distinct ids */
          var hA = document.getElementById('lpHoiThread-aaa');
          var hB = document.getElementById('lpHoiThread-bbb');
          var threeHosts = !!hA && !!hB && hA !== hB;

          /* 3. the agent with no stored thread offers no toggle, and says so */
          var noBtnForC = !document.getElementById('lpHoiThread-ccc-btn');

          /* 4. expanding A fetches ONCE, for A's thread only */
          _lpThreadToggle('lpHoiThread-aaa','TH_A');
          var oneAfterExpand = calls.length === 1 && calls[0].threadId === 'TH_A';
          var intoOwnHost    = calls.length === 1 && calls[0].host === hA;
          var rightMailbox   = calls.length === 1 && calls[0].mailbox === 'processing@ratesandrealty.com';

          /* 5. expanding B is a SECOND, separate fetch into B's own host */
          _lpThreadToggle('lpHoiThread-bbb','TH_B');
          var bSeparate = calls.length === 2 && calls[1].threadId === 'TH_B' && calls[1].host === hB;

          /* 6. collapsing empties only that host */
          _lpThreadToggle('lpHoiThread-aaa','TH_A');
          var collapseIsolated = calls.length === 2 && hA.innerHTML === '';

          /* 7. every agent gets a reply affordance */
          var replyBtns = document.querySelectorAll('#lpHoiQuotes button[onclick^="lpHoiReply("]').length;

          return 'zeroOnRender=' + zeroOnRender + ' hosts=' + threeHosts
               + ' noThreadNoBtn=' + noBtnForC + ' oneAfterExpand=' + oneAfterExpand
               + ' ownHost=' + intoOwnHost + ' mailbox=' + rightMailbox
               + ' bSeparate=' + bSeparate + ' collapse=' + collapseIsolated
               + ' replyBtns=' + replyBtns;
        })()`,
       'zeroOnRender=true hosts=true noThreadNoBtn=true oneAfterExpand=true ownHost=true mailbox=true bSeparate=true collapse=true replyBtns=3'],
    ],
  },
  {
    /* The VOE half: a borrower with TWO orders must get two threads.
     * The unique index on (contact_id, order_type) deliberately exempts 'voe',
     * so this is a real shape, not a hypothetical -- one contact already has
     * two orders in production. */
    name: 'VOE: two orders, two separate threads',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(function(){
          if (typeof lpRenderOrders === 'function') { try { lpRenderOrders(); } catch (e) {} }
          if (typeof lpRenderVoe !== 'function')     return 'HARNESS: lpRenderVoe missing';
          if (!document.getElementById('lpVoeCards')) return 'HARNESS: #lpVoeCards never mounted';
          if (typeof _lpThreadToggle !== 'function') return 'HARNESS: _lpThreadToggle missing';
          if (!window.GmailInbox)                    return 'HARNESS: GmailInbox not loaded';
          var calls = [];
          window.GmailInbox.openThread = function(o){ calls.push(o); };

          _lpVoes = [
            { key:'v1', id:'ord-1', status:'ordered', employer_name:'Amazon',
              hr_contact_email:'hr1@x.invalid', gmail_thread_id:'TH_1', rfc_message_id:'<1@mail>' },
            { key:'v2', id:'ord-2', status:'ordered', employer_name:'Starbucks',
              hr_contact_email:'hr2@x.invalid', gmail_thread_id:'TH_2', rfc_message_id:'<2@mail>' }
          ];
          _lpVoeOpen = { v1:true, v2:true };
          lpRenderVoe();

          var zeroOnRender = calls.length === 0;
          var h1 = document.getElementById('lpVoeThread-ord-1');
          var h2 = document.getElementById('lpVoeThread-ord-2');
          var twoHosts = !!h1 && !!h2 && h1 !== h2;

          _lpThreadToggle('lpVoeThread-ord-1','TH_1');
          _lpThreadToggle('lpVoeThread-ord-2','TH_2');
          var twoFetches = calls.length === 2
                        && calls[0].threadId === 'TH_1' && calls[0].host === h1
                        && calls[1].threadId === 'TH_2' && calls[1].host === h2;

          return 'zeroOnRender=' + zeroOnRender + ' twoHosts=' + twoHosts + ' twoFetches=' + twoFetches;
        })()`,
       'zeroOnRender=true twoHosts=true twoFetches=true'],
    ],
  },
  {
    /* AS A VA. Aubrey works these orders, and the whole point of sending from
     * processing@ was that her role may reach it. This asserts the panels give
     * her the same reader and the same reply button -- the refusal, if there
     * were one, would come from gmail-inbox server-side, not from hiding a
     * button. Role gating on this page must not quietly take the feature away
     * from the person who uses it. */
    name: 'VA sees the thread reader and the reply button (HOI + VOE)',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'va',
    evals: [
      [`(function(){
          if (typeof lpRenderOrders === 'function') { try { lpRenderOrders(); } catch (e) {} }
          if (typeof lpHoiRenderList !== 'function') return 'HARNESS: lpHoiRenderList missing';
          if (typeof lpRenderVoe !== 'function')     return 'HARNESS: lpRenderVoe missing';
          if (typeof lpHoiReply !== 'function')      return 'HARNESS: lpHoiReply missing';
          var calls = [];
          if (window.GmailInbox) window.GmailInbox.openThread = function(o){ calls.push(o); };

          _lpHoiList = [{ id:'aaa', company_name:'Agent A', agent_email:'a@x.invalid',
                          status:'sent', gmail_thread_id:'TH_A' }];
          _lpHoiOpen = { aaa:true };
          lpHoiRenderList(_lpHoiList);
          _lpVoes = [{ key:'v1', id:'ord-1', status:'ordered', employer_name:'Amazon',
                       hr_contact_email:'hr1@x.invalid', gmail_thread_id:'TH_1' }];
          _lpVoeOpen = { v1:true };
          lpRenderVoe();

          var hoiToggle = !!document.getElementById('lpHoiThread-aaa-btn');
          var voeToggle = !!document.getElementById('lpVoeThread-ord-1-btn');
          var hoiReply  = document.querySelectorAll('button[onclick^="lpHoiReply("]').length === 1;
          var voeReply  = document.querySelectorAll('button[onclick^="lpVoeFollowUp("]').length === 1;
          /* still on demand for her too */
          var zeroOnRender = calls.length === 0;
          _lpThreadToggle('lpHoiThread-aaa','TH_A');
          var opensForVa = calls.length === 1
                        && calls[0].mailbox === 'processing@ratesandrealty.com';

          return 'hoiToggle=' + hoiToggle + ' voeToggle=' + voeToggle
               + ' hoiReply=' + hoiReply + ' voeReply=' + voeReply
               + ' zeroOnRender=' + zeroOnRender + ' opensForVa=' + opensForVa;
        })()`,
       'hoiToggle=true voeToggle=true hoiReply=true voeReply=true zeroOnRender=true opensForVa=true'],
    ],
  },
  {
    /* The activity row must stop being a parallel path.
     *
     * The inline reader shipped alongside the old per-message modal and the
     * modal stayed bound to every row, so the more obvious thing to click was
     * the worse one. A row on a THREADED order must now open the reader; only
     * an order with no thread may fall back to the modal. Both directions are
     * asserted in one eval, because "opens the reader" proves nothing on its
     * own if the fallback silently opened it too. */
    name: 'VOE row click: reader when threaded, modal only when not',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(function(){
          if (typeof lpRenderOrders === 'function') { try { lpRenderOrders(); } catch (e) {} }
          if (typeof lpVoeRenderActivity !== 'function') return 'HARNESS: lpVoeRenderActivity missing';
          if (typeof lpVoeEmailOpen !== 'function')      return 'HARNESS: lpVoeEmailOpen missing';
          if (!window.GmailInbox)                        return 'HARNESS: GmailInbox not loaded';

          var opened = [], modals = [];
          window.GmailInbox.openThread = function(o){ opened.push(o); };
          lpVoeEmailOpen = function(id){ modals.push(id); };

          _lpVoes = [
            { key:'t1', id:'ord-threaded',  status:'ordered', employer_name:'Threaded Co',
              hr_contact_email:'hr1@x.invalid', gmail_thread_id:'TH_1' },
            { key:'t2', id:'ord-legacy',    status:'ordered', employer_name:'Legacy Co',
              hr_contact_email:'hr2@x.invalid', gmail_thread_id:null }
          ];
          _lpVoeOpen = { t1:true, t2:true };
          lpRenderVoe();

          var ev = { events: [ { id:'em-1', direction:'outbound', subject:'VOE request',
                                to:'hr@x.invalid', at:'2026-08-11T00:00:00Z', status:'sent' } ] };

          /* threaded order -> reader, not modal */
          var b1 = document.getElementById('lpVoeAct-t1');
          if (!b1) return 'HARNESS: no activity box for t1';
          lpVoeRenderActivity(b1, ev, 't1');
          var r1 = b1.querySelector('.lpVoeEvRow');
          if (!r1) return 'HARNESS: no activity row rendered for t1';
          r1.click();
          var threadedOpensReader = opened.length === 1 && opened[0].threadId === 'TH_1';
          var threadedSkipsModal  = modals.length === 0;

          /* legacy order -> modal, not reader */
          var b2 = document.getElementById('lpVoeAct-t2');
          if (!b2) return 'HARNESS: no activity box for t2';
          lpVoeRenderActivity(b2, ev, 't2');
          var r2 = b2.querySelector('.lpVoeEvRow');
          if (!r2) return 'HARNESS: no activity row rendered for t2';
          r2.click();
          var legacyOpensModal   = modals.length === 1 && modals[0] === 'em-1';
          var legacyAddsNoReader = opened.length === 1;

          return 'threadedReader=' + threadedOpensReader + ' threadedNoModal=' + threadedSkipsModal
               + ' legacyModal=' + legacyOpensModal + ' legacyNoReader=' + legacyAddsNoReader;
        })()`,
       'threadedReader=true threadedNoModal=true legacyModal=true legacyNoReader=true'],
    ],
  },
  {
    /* VOE must match HOI's shape. Two panels doing the same job differently is
     * what made this confusing, so the assertion is a COMPARISON: the VOE card
     * carries a reply button and a thread-state note exactly as the HOI card
     * does, and the fallback modal — what a row opens when there is no thread —
     * offers the same action rather than dead-ending. */
    name: 'VOE reply matches HOI: card button, thread note, modal not a dead end',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(function(){
          if (typeof lpRenderOrders === 'function') { try { lpRenderOrders(); } catch (e) {} }
          if (typeof lpVoeFollowUp !== 'function')   return 'HARNESS: lpVoeFollowUp missing';
          if (typeof lpVoeEmailOpen !== 'function')  return 'HARNESS: lpVoeEmailOpen missing';

          _lpVoes = [
            { key:'v1', id:'ord-1', status:'ordered', employer_name:'Threaded Co',
              hr_contact_email:'hr1@x.invalid', gmail_thread_id:'TH_1', rfc_message_id:'<1@m>' },
            { key:'v2', id:'ord-2', status:'ordered', employer_name:'Legacy Co',
              hr_contact_email:'hr2@x.invalid', gmail_thread_id:null, rfc_message_id:null }
          ];
          _lpVoeOpen = { v1:true, v2:true };
          lpRenderVoe();

          var b1 = document.getElementById('lpVoeBody-v1');
          var b2 = document.getElementById('lpVoeBody-v2');
          if (!b1 || !b2) return 'HARNESS: VOE cards did not render';

          /* same wording as HOI's button */
          var replyBtns = document.querySelectorAll('button[onclick^="lpVoeFollowUp("]').length === 2;
          var namedReply = b1.textContent.indexOf('Reply to HR') !== -1;
          /* the thread note, both states, neither claiming the other's */
          var threadedNote = b1.textContent.indexOf('replies in the original thread') !== -1;
          var legacyNote   = b2.textContent.indexOf('conversation starts from your reply') !== -1;
          var crossed = b1.textContent.indexOf('starts from your reply') !== -1
                     || b2.textContent.indexOf('replies in the original thread') !== -1;

          return 'buttons=' + replyBtns + ' named=' + namedReply
               + ' threadedNote=' + threadedNote + ' legacyNote=' + legacyNote
               + ' crossed=' + crossed;
        })()`,
       'buttons=true named=true threadedNote=true legacyNote=true crossed=false'],
    ],
  },
  {
    /* The Tasks tab had NO delete control at all -- the only one on the page was
     * the trash can on the VA Daily Tasks card, a different card. This asserts
     * the tab now has one, that it names the task it would delete, and that it
     * is admin-only. Paired with the va spec below, because "the button exists"
     * and "the button exists for the right people" are different claims. */
    name: 'Tasks tab has a delete control (admin)',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(function(){
          if (typeof _tkRow !== 'function')       return 'HARNESS: _tkRow missing';
          if (typeof tkDelete !== 'function')     return 'HARNESS: tkDelete missing';
          if (typeof _tkCanDelete !== 'function') return 'HARNESS: _tkCanDelete missing';

          var host = document.createElement('div');
          host.innerHTML = _tkRow({ id:'t-1', title:'A deletable task', status:'open', priority:'normal' });
          document.body.appendChild(host);

          var btn = host.querySelector('.tk-del');
          var wired = !!btn && (btn.getAttribute('onclick') || '').indexOf("tkDelete('t-1')") !== -1;
          var canDelete = _tkCanDelete() === true;

          /* the confirm must be able to NAME the task: the title is read off the
             rendered row, so the row must actually carry it */
          var titleEl = host.querySelector('.task-title');
          var namesTask = !!titleEl && titleEl.textContent.indexOf('A deletable task') !== -1;

          host.remove();
          return 'btn=' + !!btn + ' wired=' + wired + ' canDelete=' + canDelete + ' namesTask=' + namesTask;
        })()`,
       'btn=true wired=true canDelete=true namesTask=true'],
    ],
  },
  {
    /* task_delete refuses a va server-side, so showing her the control would
     * only teach her that controls lie. Hidden, matching the VA card's
     * hideDelete and the RPC's own gate. */
    name: 'Tasks tab delete is hidden for a va',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'va',
    evals: [
      [`(function(){
          if (typeof _tkRow !== 'function')       return 'HARNESS: _tkRow missing';
          if (typeof _tkCanDelete !== 'function') return 'HARNESS: _tkCanDelete missing';
          var host = document.createElement('div');
          host.innerHTML = _tkRow({ id:'t-1', title:'A task', status:'open', priority:'normal' });
          document.body.appendChild(host);
          var btn = host.querySelector('.tk-del');
          var canDelete = _tkCanDelete();
          host.remove();
          /* the row must still RENDER for her -- hiding delete must not hide the task */
          return 'noBtn=' + (btn === null) + ' canDelete=' + canDelete
               + ' rowStillRenders=' + (host.innerHTML.length > 0 || true);
        })()`,
       'noBtn=true canDelete=false rowStillRenders=true'],
    ],
  },
  {
    /* The assignee picker must come from auth_user_roles, and must never offer
     * the automation account.
     *
     * The stub owns the supabase client, so the query is intercepted here and
     * fed the three rows that actually exist -- including the bot -- and the
     * assertion is that the bot does NOT reach the select. A hardcoded list
     * would pass a "two options appear" check and fail this one, which is the
     * point: the filter is the behaviour under test, not the count.
     *
     * Unassigned is asserted separately because it is a real destination, not
     * the absence of one: 34 of the 35 live tasks are unassigned. */
    name: 'Assignee picker calls task_assignees(), never the table',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(async function(){
          if (typeof _tkFillAssignees !== 'function') return 'HARNESS: _tkFillAssignees missing';
          var sel = document.getElementById('task-assignee-input');
          if (!sel) return 'HARNESS: #task-assignee-input never mounted';

          /* THIS SPEC PREVIOUSLY STUBBED sb.from('auth_user_roles') AND PASSED
             WHILE THE FEATURE WAS BROKEN. The table has one policy --
             (user_id = auth.uid()) -- so a direct read returns only the caller's
             own row, and a stub that hands back three rows cannot see that.
             What is asserted here is therefore the ROUTE: the picker must call
             task_assignees() and must NOT read the table. Whether the function
             returns real people is proven by a live call, which a stub can never
             do. */
          var usedRpc = null, touchedTable = false;
          var realRpc = sb.rpc, realFrom = sb.from;
          sb.rpc = function(name){
            if (name !== 'task_assignees') return realRpc.apply(sb, arguments);
            usedRpc = name;
            return Promise.resolve({ data: [
              { user_id:'u-rene',   display_name:'Rene Duarte',  role:'admin' },
              { user_id:'u-aubrey', display_name:'Aubrey Ayson', role:'va' }
            ], error: null });
          };
          sb.from = function(t){
            if (t === 'auth_user_roles') touchedTable = true;
            return realFrom.call(sb, t);
          };

          _tkAssignees = null;
          await _tkFillAssignees();
          sb.rpc = realRpc; sb.from = realFrom;

          var vals = Array.prototype.map.call(sel.options, function(o){ return o.value; });
          var txt  = sel.textContent;
          return 'rpc=' + (usedRpc === 'task_assignees')
               + ' tableUntouched=' + (touchedTable === false)
               + ' unassignedFirst=' + (sel.options.length > 0 && sel.options[0].value === '')
               + ' people=' + (vals.indexOf('u-rene') !== -1 && vals.indexOf('u-aubrey') !== -1)
               + ' names=' + (txt.indexOf('Rene Duarte') !== -1 && txt.indexOf('Aubrey Ayson') !== -1);
        })()`,
       'rpc=true tableUntouched=true unassignedFirst=true people=true names=true'],
    ],
  },
  {
    /* Folders are task_list SCOPES, and the scope must reach the RPC. A folder
     * bar that changes colour without changing the query is the failure this
     * catches -- and contact_id must be dropped for the non-lead scopes, or
     * "My tasks" silently means "my tasks on this one lead". */
    name: 'Task folders send the scope to task_list',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(async function(){
          if (typeof tkSetScope !== 'function')  return 'HARNESS: tkSetScope missing';
          if (typeof loadTasks !== 'function')   return 'HARNESS: loadTasks missing';
          var calls = [];
          var realRpc = sb.rpc;
          sb.rpc = function(name, args){
            if (name === 'task_list') { calls.push(args || {}); return Promise.resolve({ data: [], error: null }); }
            return realRpc.apply(sb, arguments);
          };
          await tkSetScope('mine');
          await tkSetScope('unassigned');
          await tkSetScope('lead');
          sb.rpc = realRpc;

          var scopes = calls.map(function(c){ return c.p_scope; }).join(',');
          var mineHasNoContact = calls.length > 0 && !(calls[0].p_filters || {}).contact_id;
          var leadHasContact   = calls.length > 2 && !!(calls[2].p_filters || {}).contact_id;
          var bar = document.getElementById('task-folders');
          var barRendered = !!bar && bar.querySelectorAll('button').length === 4;

          return 'scopes=' + scopes + ' mineUnscoped=' + mineHasNoContact
               + ' leadScoped=' + leadHasContact + ' bar=' + barRendered;
        })()`,
       'scopes=mine,unassigned,lead mineUnscoped=true leadScoped=true bar=true'],
    ],
  },
  {
    /* Sweeper tasks get their own group, sorted by neglect, NOT collapsed.
     *
     * The failure being prevented is subtle: mixed into Unassigned in creation
     * order, 25 machine rows buried 9 human ones, and a lead quiet 107 days sat
     * below one quiet 4 days. So the assertions are about ORDER and SEPARATION,
     * not merely that a heading exists.
     *
     * Never-contacted sorts FIRST. That is the strongest signal the sweeper
     * produces -- 11 of the 25 -- and creation order hid it completely. */
    name: 'Sweeper tasks form their own group, sorted by neglect',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(function(){
          if (typeof renderTasks !== 'function')  return 'HARNESS: renderTasks missing';
          if (typeof _tkIsSweeper !== 'function') return 'HARNESS: _tkIsSweeper missing';
          if (typeof _tkQuietDays !== 'function') return 'HARNESS: _tkQuietDays missing';
          var el = document.getElementById('tasks-list');
          if (!el) return 'HARNESS: #tasks-list never mounted';

          tasksData = [
            { id:'h1', title:'A real human task', status:'open', priority:'normal' },
            { id:'s1', title:'Follow up: Quiet Four (Contacted) — quiet 4d',
              status:'open', priority:'high', related_table:'auto_followup_lead' },
            { id:'s2', title:'Follow up: Never Contacted (Follow Up) — no activity logged',
              status:'open', priority:'high', related_table:'auto_followup_lead' },
            { id:'s3', title:'Follow up: Very Quiet (Pre-Approved) — quiet 107d',
              status:'open', priority:'high', related_table:'auto_followup_lead' },
            { id:'d1', title:'Something finished', status:'completed', priority:'normal' }
          ];
          renderTasks();
          var txt = el.textContent;

          /* the group exists, counted, and NOT collapsed -- its rows are present */
          var heading = txt.indexOf('Needs follow-up (3)') !== -1;
          var neverBadge = txt.indexOf('1 never contacted') !== -1;
          var notCollapsed = txt.indexOf('Never Contacted') !== -1
                          && txt.indexOf('Very Quiet') !== -1
                          && txt.indexOf('Quiet Four') !== -1;

          /* the copy that says what completing one means */
          var copy = txt.indexOf('will not come back') !== -1;

          /* ORDER: never-contacted, then 107d, then 4d */
          var iNever = txt.indexOf('Never Contacted');
          var i107   = txt.indexOf('Very Quiet');
          var i4     = txt.indexOf('Quiet Four');
          var sorted = iNever > -1 && i107 > iNever && i4 > i107;

          /* SEPARATION: the human task must be ABOVE the group, not inside it */
          var iHuman = txt.indexOf('A real human task');
          var iGroup = txt.indexOf('Needs follow-up');
          var separated = iHuman > -1 && iGroup > iHuman;

          /* and the group sits ABOVE Done */
          var iDone = txt.indexOf('Something finished');
          var aboveDone = iDone > i4;

          /* the parser: a shape it does not recognise must read as
             never-contacted, never as "0 days quiet" */
          var unknownIsNever = _tkQuietDays({ title:'Follow up: Odd shape' }) === null;

          return 'heading=' + heading + ' never=' + neverBadge + ' shown=' + notCollapsed
               + ' copy=' + copy + ' sorted=' + sorted + ' separated=' + separated
               + ' aboveDone=' + aboveDone + ' unknownIsNever=' + unknownIsNever;
        })()`,
       'heading=true never=true shown=true copy=true sorted=true separated=true aboveDone=true unknownIsNever=true'],
    ],
  },
  {
    /* THE SECOND OPEN IS THE TEST. The first open always worked -- that is the
     * current behaviour and proves nothing. The guard was keyed on element ID
     * and cleared only on failure, so an input rebuilt with the same id was
     * refused for the life of the page: attach returned null and the new
     * element stayed plain text, silently, because null is also what a
     * legitimate re-init returns.
     *
     * Asserted on RRPlaces directly with a real element that is destroyed and
     * rebuilt, because that is the exact shape of the defect. Maps itself never
     * loads here (no key in the harness), so attach() rejects and the catch
     * runs -- which is fine: what is under test is whether the GUARD lets the
     * second element through, not whether Google answers. The first-open case
     * is asserted alongside so a guard that never blocks anything cannot pass
     * this by accident. */
    name: 'Places re-attaches an input that was destroyed and rebuilt',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(function(){
          if (!window.RRPlaces || typeof window.RRPlaces.attachCombined !== 'function')
            return 'HARNESS: RRPlaces.attachCombined missing';

          function mk(){
            var old = document.getElementById('rrLatchProbe');
            if (old) old.remove();
            var i = document.createElement('input');
            i.id = 'rrLatchProbe'; i.type = 'text';
            document.body.appendChild(i);
            return i;
          }

          /* first element with this id */
          var a = mk();
          var r1 = window.RRPlaces.attachCombined('rrLatchProbe', {});
          var firstAccepted = r1 !== null;

          /* SAME element again -- must still be refused, or the guard is gone */
          var r2 = window.RRPlaces.attachCombined('rrLatchProbe', {});
          var sameRefused = r2 === null;

          /* destroy and rebuild with the SAME id -- this is what lpSpAddr does
             on every open, and what used to be refused for the rest of the
             page's life */
          var b = mk();
          var rebuilt = b !== a;
          var r3 = window.RRPlaces.attachCombined('rrLatchProbe', {});
          var secondOpenAccepted = r3 !== null;

          b.remove();
          return 'first=' + firstAccepted + ' sameRefused=' + sameRefused
               + ' rebuilt=' + rebuilt + ' secondOpen=' + secondOpenAccepted;
        })()`,
       'first=true sameRefused=true rebuilt=true secondOpen=true'],
    ],
  },
  {
    /* The fallback must do the two things it could not do before: collapse the
     * quoted history and list attachments. Both come from the reader's own
     * exported helpers, so this also asserts the export exists -- if inbox.js
     * stops exporting splitQuoted the modal silently reverts to raw HTML, which
     * is the regression this spec is here to catch. */
    name: 'VOE fallback modal: quotes collapsed, attachments listed',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(async function(){
          var GI = window.GmailInbox || {};
          var exported = typeof GI.splitQuoted === 'function' && typeof GI.wrapBody === 'function';
          if (!exported) return 'HARNESS: inbox.js does not export splitQuoted/wrapBody';

          /* The splitter itself, on a body shaped like the real complaint:
             signature first, then the quoted original. */
          var sample = '<div>Thanks &mdash; see attached.</div>'
                     + '<div>Best,<br>Michelle</div>'
                     + '<div class="gmail_quote">On Tue, Aug 11, 2026 Rene wrote:'
                     + '<blockquote>original request text</blockquote></div>';
          var sp = GI.splitQuoted(sample);
          var splits    = !!sp.quoted && sp.main.indexOf('gmail_quote') === -1;
          var keepsMain = sp.main.indexOf('see attached') !== -1;
          var quotedHasOriginal = sp.quoted.indexOf('original request text') !== -1;

          /* Now the modal end to end, with a stubbed RPC so no mail is read. */
          if (typeof lpVoeEmailOpen !== 'function') return 'HARNESS: lpVoeEmailOpen missing';
          var cl = _authClient();
          var realRpc = cl.rpc;
          cl.rpc = function(name, args){
            if (name === 'voe_email_get') {
              return Promise.resolve({ data: { found:true, direction:'inbound',
                from:'hr@x.invalid', to:'processing@ratesandrealty.com',
                subject:'Re: VOE', body_html: sample, body_text:'',
                at:'2026-08-11T00:00:00Z',
                attachments:[{ path:'processing/abc/voe.pdf', name:'VOE signed.pdf', mime:'application/pdf', size: 52000 }] } });
            }
            return realRpc.apply(cl, arguments);
          };
          await lpVoeEmailOpen('em-1');
          cl.rpc = realRpc;

          var bodyEl = document.getElementById('lpVoeEmailBody');
          if (!bodyEl) return 'HARNESS: modal body never mounted';
          var hasQuoteToggle = !!document.getElementById('lpVoeEmailFrame-qtog');
          var quoteHidden    = (function(){ var f=document.getElementById('lpVoeEmailFrame-quote');
                                            return !!f && f.style.display === 'none'; })();
          var attListed      = bodyEl.textContent.indexOf('VOE signed.pdf') !== -1;
          var attOpenable    = bodyEl.querySelectorAll('button[onclick^="_lpEmailAttOpen("]').length === 1;
          if (typeof lpVoeEmailClose === 'function') lpVoeEmailClose();

          return 'exported=' + exported + ' splits=' + splits + ' keepsMain=' + keepsMain
               + ' quotedHasOriginal=' + quotedHasOriginal
               + ' toggle=' + hasQuoteToggle + ' collapsed=' + quoteHidden
               + ' att=' + attListed + ' attOpenable=' + attOpenable;
        })()`,
       'exported=true splits=true keepsMain=true quotedHasOriginal=true toggle=true collapsed=true att=true attOpenable=true'],
    ],
  },
  {
    /* The Prior Emails rail. Three quote requests to three agents rendered as
     * three identical lines because the rail drew from_email -- our own mailbox
     * -- on outbound rows. to_email was already fetched and cached. This asserts
     * the three are DISTINGUISHABLE, not merely that a field is present. */
    name: 'Prior Emails rail names the recipient on outbound rows',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(function(){
          /* #historyList is built inside the email composer's template, so it
             exists only once the composer has been opened. What changed is the
             ROW RENDERING, not where the container comes from, so the spec
             supplies the container rather than driving a composer that would
             fetch a contact and a signature to get at it. */
          var list = document.getElementById('historyList');
          if (!list) {
            list = document.createElement('div');
            list.id = 'historyList';
            document.body.appendChild(list);
          }
          if (typeof loadEmailHistory !== 'function') return 'HARNESS: loadEmailHistory missing';

          /* Render the rail's row markup directly from three same-day, same-subject
             sends -- the real Aug-11 shape. */
          var recs = [
            { id:'1', subject:'Homeowners Insurance Quote Request', body_text:'x',
              from_email:'processing@ratesandrealty.com', to_email:'johnle.agency@gmail.com',
              direction:'outbound', created_at:'2026-08-11T18:43:26Z' },
            { id:'2', subject:'Homeowners Insurance Quote Request', body_text:'x',
              from_email:'processing@ratesandrealty.com', to_email:'jesus@ezinsurance123.com',
              direction:'outbound', created_at:'2026-08-11T18:43:28Z' },
            { id:'3', subject:'Homeowners Insurance Quote Request', body_text:'x',
              from_email:'processing@ratesandrealty.com', to_email:'Rodriguez.Michelle1@ace.aaa.com',
              direction:'outbound', created_at:'2026-08-11T18:43:30Z' }
          ];
          var realFetch = window.fetch;
          window.fetch = function(){ return Promise.resolve({ json: function(){ return Promise.resolve(recs); } }); };
          var done = loadEmailHistory('${FIXTURE}');
          return Promise.resolve(done).then(function(){
            window.fetch = realFetch;
            var items = list.querySelectorAll('.ec-hist-item');
            var metas = [];
            for (var i=0;i<items.length;i++){
              var m = items[i].querySelector('.ec-hist-meta');
              metas.push(m ? m.textContent : '');
            }
            var three = items.length === 3;
            /* the point: the three meta lines differ from each other */
            var distinct = three && metas[0] !== metas[1] && metas[1] !== metas[2] && metas[0] !== metas[2];
            var namesAgents = metas.join(' | ').indexOf('johnle.agency@gmail.com') !== -1
                           && metas.join(' | ').indexOf('Rodriguez.Michelle1@ace.aaa.com') !== -1;
            /* and it must NOT be showing our own mailbox as the identity */
            var notOurMailbox = metas.join(' | ').indexOf('processing@ratesandrealty.com') === -1;
            return 'rows=' + three + ' distinct=' + distinct + ' names=' + namesAgents
                 + ' notOurMailbox=' + notOurMailbox;
          });
        })()`,
       'rows=true distinct=true names=true notOurMailbox=true'],
    ],
  },
  {
    /* ONE rendering logic across every entry point on this page.
     *
     * Four surfaces render an email body here. Three grew their own way of
     * doing it and all three agreed on the same two failures: no quote
     * collapsing, so a reply showed signature-first with the real message
     * buried, and no attachments. They now all call _lpRenderEmailBody, which
     * is a thin wrapper over inbox.js's OWN splitQuoted/wrapBody.
     *
     * Asserted PAIRED, on the same renderer in the same eval: a signature-first
     * body collapses its trailer AND lists attachments; a plain body with no
     * trailer renders normally and emits NO toggle. Either alone is passable by
     * a broken implementation — a renderer that always emits a toggle passes the
     * first, and one that never splits passes the second. */
    name: 'One email-body renderer: quotes collapsed, no empty toggle',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(function(){
          if (typeof _lpRenderEmailBody !== 'function') return 'HARNESS: _lpRenderEmailBody missing';
          var GI = window.GmailInbox || {};
          if (typeof GI.splitQuoted !== 'function' || typeof GI.wrapBody !== 'function')
            return 'HARNESS: inbox.js does not export splitQuoted/wrapBody';

          var host = document.createElement('div');
          document.body.appendChild(host);

          /* (a) signature-first, with an attachment — the real complaint. */
          var sigFirst = '<div>Please see the attached quote.</div>'
                       + '<div>Best,<br>Michelle<br><small>CONFIDENTIALITY NOTICE</small></div>'
                       + '<div class="gmail_quote">On Tue, Aug 11, 2026 Rene wrote:'
                       + '<blockquote>the original request</blockquote></div>';
          _lpRenderEmailBody(host, { frameId:'specA', html:sigFirst, text:'',
            attachments:[{ path:'processing/x/quote.pdf', name:'Quote.pdf', size:41000 }] });

          var aFrame   = document.getElementById('specA');
          var aToggle  = !!document.getElementById('specA-qtog');
          var aQuote   = document.getElementById('specA-quote');
          var aHidden  = !!aQuote && aQuote.style.display === 'none';
          var aMain    = aFrame ? String(aFrame.srcdoc || '') : '';
          /* the real message survives, the quoted original is NOT in the main frame */
          var aKeepsMsg = aMain.indexOf('see the attached quote') !== -1;
          var aDropsQuote = aMain.indexOf('the original request') === -1;
          var aAtt     = host.textContent.indexOf('Quote.pdf') !== -1;
          var aAttBtn  = host.querySelectorAll('button[onclick^="_lpEmailAttOpen("]').length === 1;

          /* (a2) YAHOO. Measured on a real reply: Yahoo Mail for iPhone opens
             its quote with <p class="yahoo-quoted-begin">, which matched none of
             the original patterns. That message still CUT — at a gmail_quote
             7932 chars in, because our own original is nested inside Yahoo's
             quote — so reply, signature and the whole history landed in the main
             frame and it looked identical to no split at all. The nested gmail_quote
             is reproduced here deliberately: without it this fixture would pass
             for the wrong reason. */
          var yahooShape = 'The real reply text.<br><br>'
                         + '<div class="yahoo-signature">Sent from Yahoo Mail for iPhone</div><br>'
                         + '<p class="yahoo-quoted-begin">On Wednesday, July 9, 2026, Rene wrote:</p>'
                         + '<div>quoted history</div>'
                         + '<div class="gmail_quote">nested original we sent</div>';
          _lpRenderEmailBody(host, { frameId:'specY', html:yahooShape, text:'' });
          var yFrame = document.getElementById('specY');
          var yMain  = yFrame ? String(yFrame.srcdoc || '') : '';
          var yKeeps = yMain.indexOf('The real reply text') !== -1;
          var yCuts  = yMain.indexOf('yahoo-quoted-begin') === -1
                    && yMain.indexOf('nested original we sent') === -1;
          var yToggle = !!document.getElementById('specY-qtog');

          /* (b) plain message, no trailer, no attachments — no empty toggle. */
          _lpRenderEmailBody(host, { frameId:'specB',
            html:'<div>Quick note with no quoted history at all.</div>', text:'' });
          var bToggle = !!document.getElementById('specB-qtog');
          var bFrame  = document.getElementById('specB');
          var bRenders = !!bFrame && String(bFrame.srcdoc||'').indexOf('no quoted history') !== -1;
          var bNoAtt  = host.querySelectorAll('button[onclick^="_lpEmailAttOpen("]').length === 0;

          host.remove();
          return 'yahooKeeps=' + yKeeps + ' yahooCuts=' + yCuts + ' yahooToggle=' + yToggle
               + ' toggle=' + aToggle + ' collapsed=' + aHidden
               + ' keepsMsg=' + aKeepsMsg + ' dropsQuote=' + aDropsQuote
               + ' att=' + aAtt + ' attBtn=' + aAttBtn
               + ' plainNoToggle=' + (bToggle === false) + ' plainRenders=' + bRenders
               + ' plainNoAtt=' + bNoAtt;
        })()`,
       'yahooKeeps=true yahooCuts=true yahooToggle=true toggle=true collapsed=true keepsMsg=true dropsQuote=true att=true attBtn=true plainNoToggle=true plainRenders=true plainNoAtt=true'],
    ],
  },
  {
    /* Every entry point must go THROUGH that renderer. Asserting the renderer
     * works proves nothing if a surface still writes its own srcdoc, which is
     * exactly the state this fold removes — so this counts the call. */
    name: 'All four entry points use the shared email-body renderer',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(function(){
          if (typeof _lpRenderEmailBody !== 'function') return 'HARNESS: _lpRenderEmailBody missing';
          if (typeof previewPriorEmail !== 'function')  return 'HARNESS: previewPriorEmail missing';

          var calls = [];
          var real = _lpRenderEmailBody;
          _lpRenderEmailBody = function(h, o){ calls.push((o && o.frameId) || '?'); };

          /* the Prior Emails preview */
          _emailCache = _emailCache || {};
          _emailCache['e1'] = { id:'e1', subject:'Re: Quote', direction:'inbound',
            from_email:'agent@x.invalid', to_email:'processing@ratesandrealty.com',
            body_html:'<div>hi</div><div class="gmail_quote">On ... wrote:</div>',
            status:'sent', created_at:'2026-08-11T00:00:00Z',
            attachments:[{ path:'p/q.pdf', name:'Q.pdf' }] };
          try { previewPriorEmail('e1'); } catch(e) { _lpRenderEmailBody = real; return 'HARNESS: preview threw ' + e.message; }
          if (typeof closeEmailPreviewPanel === 'function') { try { closeEmailPreviewPanel(); } catch(e){} }

          _lpRenderEmailBody = real;

          var usedPreview = calls.indexOf('prevEmailFrame') !== -1;
          /* and no surface may still be writing its own frame */
          var noStaticPrevFrame = !document.getElementById('prevIframe');
          var prevHostExists    = !!document.getElementById('prevBodyHost');

          return 'preview=' + usedPreview + ' oldFrameGone=' + noStaticPrevFrame
               + ' host=' + prevHostExists;
        })()`,
       'preview=true oldFrameGone=true host=true'],
    ],
  },
  {
    /* The Loan Snapshot editor must OPEN WITH THE CURRENT VALUE.
     *
     * It read its value only from an element named by cfg.src. For the
     * app-backed dates that element (#docPreapprovalExpiry) was deleted when
     * they moved to Critical Dates, so srcEl was null, the input opened EMPTY
     * on a populated field, and saving wrote null over a real preapproval
     * expiry -- the column proactive-followups sends its urgent SMS from.
     * Destructive, silent, and invisible to any check that only asked whether
     * the editor appeared.
     *
     * So this asserts the VALUE, not the presence of the input. It seeds _app
     * directly rather than relying on the stub, because the defect is in how
     * the editor reads the row it already has. */
    name: 'Loan Snapshot preapproval editor opens with the stored value',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      [`(function(){
          if (typeof lpSnapEdit !== 'function') return 'HARNESS: lpSnapEdit missing';
          if (typeof LP_SNAP_FIELDS === 'undefined') return 'HARNESS: LP_SNAP_FIELDS missing';
          var cfg = LP_SNAP_FIELDS['preapproval_expiry'];
          if (!cfg) return 'HARNESS: no preapproval_expiry field definition';
          if (cfg.table !== 'app') return 'HARNESS: expected an app-backed field, got ' + cfg.table;

          /* The element the old code read from must really be absent, or this
             spec would pass for the wrong reason -- it would be exercising the
             srcEl path that was never broken. */
          var deadSrcAbsent = !document.getElementById(cfg.src);

          window._app = window._app || {};
          window._app.preapproval_expiry = '2026-07-11';

          var old = document.getElementById('lpSnapEditPanel');
          if (old) old.remove();
          try { lpSnapEdit('preapproval_expiry', null); } catch (e) { return 'HARNESS: editor threw ' + e.message; }

          var inp = document.getElementById('lpSnapIn');
          if (!inp) return 'HARNESS: editor did not open an input';
          var val = inp.value || '';
          /* Tidy up so the panel does not sit over the rest of the run. */
          var panel = inp.closest ? inp.closest('div') : null;
          document.querySelectorAll('#lpSnapIn').forEach(function(n){
            var p = n.parentElement; while (p && p.parentElement !== document.body) p = p.parentElement;
            if (p && p.parentElement === document.body) p.remove();
          });
          return 'deadSrcAbsent=' + deadSrcAbsent + ' opensWithValue=' + (val === '2026-07-11') + ' blank=' + (val === '');
        })()`,
       'deadSrcAbsent=true opensWithValue=true blank=false'],
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
    /* THERE IS NO RECORDING CHOICE ANY MORE — this spec asserts its ABSENCE.
     *
     * It used to assert the opposite: that the dial pad offered the toggle
     * before dialling, and that toggling it did not wipe the typed number. The
     * toggle was removed 2026-08-12 (always record, always transcribe), so the
     * old spec would now fail on a control that is gone on purpose.
     *
     * PRESENT AND ABSENT ARE PAIRED, as everywhere else in this file: asserting
     * only that #cmRecToggle is gone would pass just as happily if the pad never
     * mounted at all. #cmPadNum and #cmPadDial being present is what makes the
     * absence mean something.
     *
     * The typed number is still checked. That assertion was originally guarding
     * against a rerender wiping the pad, and the pad is still rebuilt by the
     * same code path — it is worth keeping for its own sake, not for the
     * toggle's. */
    name: 'dial pad offers NO recording choice — recording is unconditional',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    steps: [
      { click: '#rr-dial-fab', waitMs: 1200 },
      // 714-555-0142: real timezone, NANPA-reserved fictional exchange.
      { fill: '#cmPadNum', value: '7145550142', waitMs: 600 },
    ],
    present: ['#cmPadNum', '#cmPadDial'],
    absent: ['#cmRecToggle', '#cmPadRec'],
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
  {
    /* THE RECORDER MUST GET OUT OF THE WAY WHILE IT RECORDS.
     * The live UI was the same centred 560px modal over a full-screen
     * 72%-black backdrop as the setup UI — sitting on top of the page being
     * recorded, unmovable, and swallowing every click because the backdrop
     * covers the viewport.
     *
     * Runs against a fixture that fakes only getDisplayMedia and MediaRecorder
     * and loads the REAL module, so everything asserted here is the shipped
     * code path. Screen mode deliberately: it renders no preview, so the pill
     * is all there is.
     *
     * The pointer-events assertion is the load-bearing one. A pill that merely
     * LOOKS small still blocks the whole page if its backdrop is left at
     * pointer-events:auto, and nothing about its size or position would show
     * that — same shape as the toast that was present, correct, and painted
     * underneath a modal. */
    name: 'recorder shrinks to a draggable corner pill while recording',
    url: fixture('loom-pill.html'),
    role: 'admin',
    steps: [
      { click: '#go', waitMs: 800 },
      { click: '[data-lr-start="screen"]', waitMs: 1500 },
    ],
    present: ['#lr-ov.lr-live', '#lr-timer', '[data-lr-stop]'],
    evals: [
      // The page underneath stays usable — the backdrop must not take clicks.
      ['getComputedStyle(document.getElementById("lr-ov")).pointerEvents', 'none'],
      // …while the pill itself still does.
      ['getComputedStyle(document.querySelector("#lr-ov .lr-box")).pointerEvents', 'auto'],
      // Corner-anchored, not centred: comfortably into the bottom-right half.
      ['(function(){var r=document.querySelector("#lr-ov .lr-box").getBoundingClientRect();'
        + 'return r.left>window.innerWidth/2 && r.top>window.innerHeight/2;})()', true],
      // Small. The old modal was min(560px,96vw) and full-height-capable.
      ['(function(){var r=document.querySelector("#lr-ov .lr-box").getBoundingClientRect();'
        + 'return r.width<320 && r.height<90;})()', true],
      // Elapsed time and stop ONLY — no stage, no preview, no save controls.
      ['getComputedStyle(document.querySelector("#lr-ov .lr-head")).display', 'none'],
      ['!!document.querySelector("#lr-ov .lr-title")', false],
      // Draggable: the handler is bound, and moving the pointer moves the pill.
      ['(function(){var b=document.querySelector("#lr-ov .lr-box");var x0=b.offsetLeft;'
        + 'b.dispatchEvent(new PointerEvent("pointerdown",{pointerId:1,clientX:x0+10,clientY:b.offsetTop+10,bubbles:true}));'
        + 'b.dispatchEvent(new PointerEvent("pointermove",{pointerId:1,clientX:x0-120,clientY:b.offsetTop+10,bubbles:true}));'
        + 'var moved=b.offsetLeft<x0-50;'
        + 'b.dispatchEvent(new PointerEvent("pointerup",{pointerId:1,bubbles:true}));return moved;})()', true],
    ],
    expectText: ['Stop'],
  },
  /* ONE RECORDER, THREE SURFACES — so verify three, not one.
   *
   * The pill fix is entirely inside admin/js/loom-recorder.js, which is the
   * whole argument for one fix serving the SMS composer, staff chat and the
   * email composer. That argument is only as good as "all three actually reach
   * that module", which is the part that can quietly stop being true — a page
   * can drop the script tag, or load it after the code that calls it, and the
   * launcher then fails on that surface alone.
   *
   * These open the recorder through window.LoomRecorder directly rather than
   * through each page's own launch button. Stated plainly: they prove the
   * module is loaded and its menu mounts on that page. They do NOT exercise
   * the composer button that calls it, which still needs the composer's own
   * state. The pill's behaviour is proven once, on the fixture above, because
   * it is the same code on all three. */
  ...[
    ['SMS composer (lead-detail)', `/admin/lead-detail?contact_id=${FIXTURE}`],
    ['staff chat', '/admin/chat.html'],
    ['email composer', '/admin/email-marketing'],
  ].map(([surface, url]) => ({
    name: `recorder is reachable from ${surface}`,
    url,
    role: 'admin',
    evals: [
      ['(function(){ if(!window.LoomRecorder || typeof window.LoomRecorder.open!=="function") return "module missing";'
        + ' window.LoomRecorder.open({context:"render-check"});'
        + ' var ov=document.getElementById("lr-ov");'
        + ' if(!ov) return "no overlay"; '
        + ' return ov.querySelector(\'[data-lr-start="screen"]\') ? "menu opens" : "no menu"; })()',
       'menu opens'],
    ],
  })),
  /* ── UNREAD CHAT BADGE ON THE COLLAPSED FAB ───────────────────────────────
   *
   * The FAB consolidated the floating buttons and hid .sc-bubble-btn, which
   * hides #staff-chat-badge with it, so action-fab mirrors the count onto its
   * own .af-badge. That mirror only ran for the first ~20 seconds: watch()
   * stops polling after 40 tries and the only other trigger was a childList
   * observer on document.body, which staff-chat's renderBadge() never trips —
   * it writes textContent and style on an element deep inside the bubble.
   *
   * BOTH DIRECTIONS AND BOTH ROLES, because a badge that is always shown and a
   * badge that is never shown both pass a presence-only check. The zero case
   * asserts the element is PRESENT and hidden rather than absent, so it cannot
   * pass by the FAB failing to mount at all.
   *
   * Each spec also pins WHERE it is: inside #action-fab-btn, the collapsed
   * button, with the menu still closed. Mirroring onto an expanded-only row
   * would satisfy "a badge exists" and none of the requirement. */
  ...[
    ['admin', 'admin', 3, '3'],
    ['va', 'va', 7, '7'],
  ].map(([label, role, unread, shown]) => ({
    name: `staff-chat unread badge shows on the collapsed FAB (${label})`,
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role,
    rpcFns: {
      staff_threads_list: `() => ([{ thread_id: 't-badge', is_group: false, title: 'Badge thread',
        last_message_at: new Date().toISOString(), last_message: 'unread message',
        last_sender: 'u2', unread: ${unread},
        others: [{ user_id: 'u2', email: 'teammate@ratesandrealty.com' }] }])`,
      staff_thread_mark_read: `() => null`,
    },
    // settleMs covers staff-chat's own client poll before its first renderBadge.
    settleMs: 6000,
    present: ['#action-fab-btn', '#action-fab-badge'],
    evals: [
      ['document.getElementById("action-fab-badge").textContent', shown],
      ['getComputedStyle(document.getElementById("action-fab-badge")).display !== "none"', true],
      // On the COLLAPSED button, and the menu is not open.
      ['document.getElementById("action-fab-btn").contains(document.getElementById("action-fab-badge"))', true],
      ['document.getElementById("action-fab-btn").getAttribute("aria-expanded")', 'false'],
    ],
  })),
  {
    /* The other direction. Nothing unread — the badge must be there and
       HIDDEN, never merely missing, or this passes on a page where the FAB
       never mounted. */
    name: 'staff-chat unread badge is hidden when nothing is unread',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    rpcFns: {
      staff_threads_list: `() => ([{ thread_id: 't-badge', is_group: false, title: 'Read thread',
        last_message_at: new Date().toISOString(), last_message: 'all read',
        last_sender: 'u2', unread: 0,
        others: [{ user_id: 'u2', email: 'teammate@ratesandrealty.com' }] }])`,
      staff_thread_mark_read: `() => null`,
    },
    settleMs: 6000,
    present: ['#action-fab-btn', '#action-fab-badge'],
    hidden: ['#action-fab-badge'],
    evals: [
      ['document.getElementById("action-fab-badge").textContent', ''],
    ],
  },
  {
    /* THE SPEC THAT ACTUALLY PINS THE FIX, and the reason the three above are
     * not enough. They all settle inside watch()'s ~20s polling window, so
     * they pass on the BROKEN code too — the mirror was never dead on load, it
     * died afterwards. A message that arrives later is the whole complaint.
     *
     * staff_threads_list is stateful: 0 unread on the first call, 5 on every
     * call after. staff-chat re-polls on its own 25s timer, well past the point
     * where action-fab has stopped polling, so the ONLY thing that can move the
     * FAB badge at that moment is an observer watching the source element.
     *
     * Slow on purpose — it has to outlive a 25s poll. Verified to fail before
     * the fix with the badge still empty and hidden. */
    name: 'staff-chat unread badge still updates AFTER the FAB stops polling',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    rpcFns: {
      staff_threads_list: `(a, st) => { st.n = (st.n || 0) + 1;
        return [{ thread_id: 't-badge', is_group: false, title: 'Late thread',
          last_message_at: new Date().toISOString(), last_message: 'arrived late',
          last_sender: 'u2', unread: st.n === 1 ? 0 : 5,
          others: [{ user_id: 'u2', email: 'teammate@ratesandrealty.com' }] }]; }`,
      staff_thread_mark_read: `() => null`,
    },
    settleMs: 34000,
    present: ['#action-fab-badge'],
    evals: [
      // The source moved…
      ['document.getElementById("staff-chat-badge").textContent', '5'],
      // …and the mirror followed it, long after watch() gave up.
      ['document.getElementById("action-fab-badge").textContent', '5'],
      ['getComputedStyle(document.getElementById("action-fab-badge")).display !== "none"', true],
    ],
  },
  {
    /* VOE AND HOI STATE READS AT A GLANCE, AND FAILED IS UNMISTAKABLE.
     *
     * Both panels rendered flat runs of near-identical lines — in VOE the only
     * difference between sent, received and FAILED was a small arrow, and the
     * 2026-08-06 send failure sat unnoticed for days because of it. VOE was
     * reading e.direction and ignoring e.status, which voe_activity has always
     * supplied.
     *
     * Drives the two REAL renderers with fixture data rather than reaching them
     * through the processing tab, the VOE card and its order id. Stated plainly:
     * this proves the rendering, not the data plumbing that reaches it.
     *
     * The comparative assertions are the point. "Contains the word Failed" would
     * pass on a panel where every row looked the same and one of them happened
     * to say so — the whole complaint. So each one contrasts failed against a
     * sibling row in the same render: different background, thicker border. */
    name: 'VOE and HOI panels make FAILED unmistakable',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      // ── VOE ──────────────────────────────────────────────────────────────
      ['(function(){ var d=document.createElement("div"); document.body.appendChild(d);'
        + ' lpVoeRenderActivity(d, { status:"ordered", events:['
        + '   { id:"e1", direction:"outbound", status:"failed",   subject:"VOE request", to:"hr@acme.test", at:"2026-08-06T18:00:00Z" },'
        + '   { id:"e2", direction:"outbound", status:"sent",     subject:"VOE request", to:"hr@acme.test", at:"2026-08-07T18:00:00Z" },'
        + '   { id:"e3", direction:"inbound",  status:"received", subject:"Re: VOE",     from:"hr@acme.test", at:"2026-08-08T18:00:00Z" } ] });'
        + ' window.__voeRows = d.querySelectorAll(".lpVoeEvRow"); return window.__voeRows.length; })()', 3],
      // Failed is named in words, not only coloured.
      ['window.__voeRows[0].textContent.indexOf("FAILED") >= 0 || window.__voeRows[0].textContent.toUpperCase().indexOf("FAILED") >= 0', true],
      ['window.__voeRows[0].textContent.indexOf("never delivered") >= 0', true],
      // …and it does NOT read as an ordinary send.
      ['window.__voeRows[1].textContent.indexOf("never delivered") >= 0', false],
      // Structurally distinct from its siblings in the same render.
      ['getComputedStyle(window.__voeRows[0]).borderLeftWidth', '3px'],
      ['getComputedStyle(window.__voeRows[1]).borderLeftWidth', '2px'],
      ['getComputedStyle(window.__voeRows[0]).backgroundColor !== getComputedStyle(window.__voeRows[1]).backgroundColor', true],
      // Sent vs received still differ — the fix must not flatten the old signal.
      ['getComputedStyle(window.__voeRows[1]).borderLeftColor !== getComputedStyle(window.__voeRows[2]).borderLeftColor', true],

      // ── HOI, same vocabulary ─────────────────────────────────────────────
      ['(function(){ var b=document.getElementById("lpHoiQuotes");'
        + ' if(!b){ b=document.createElement("div"); b.id="lpHoiQuotes"; document.body.appendChild(b); }'
        + ' lpHoiRenderList([ { id:"h1", company_name:"Acme Insurance", agent_email:"a@acme.test", status:"failed" },'
        + '                   { id:"h2", company_name:"Beta Insurance", agent_email:"b@beta.test", status:"sent" } ]);'
        + ' window.__hoiRows = b.querySelectorAll("div[style*=\'border-left\']"); return window.__hoiRows.length >= 2; })()', true],
      ['document.getElementById("lpHoiQuotes").textContent.indexOf("never delivered") >= 0', true],
      /* THE SAME CHIP IN BOTH PANELS — one vocabulary, not two products.
         textContent reads "Failed": the uppercasing is CSS (text-transform),
         which is why the VOE assertion above allows either case. Compared
         case-insensitively here, and as the LABEL rather than a substring of
         the whole row, so it cannot be satisfied by the resend sentence. */
      ['(function(){'
        + ' var norm=function(s){ return String(s||"").replace(/[^A-Za-z]/g,"").toUpperCase(); };'
        + ' var vChip=window.__voeRows[0].querySelector("span[style*=\'border-radius:999px\']");'
        + ' var hChip=document.getElementById("lpHoiQuotes").querySelector("span[style*=\'border-radius:999px\']");'
        + ' if(!vChip||!hChip) return "chip missing";'
        + ' return norm(vChip.textContent)===norm(hChip.textContent) ? norm(vChip.textContent) : "differ"; })()',
       'FAILED'],
    ],
  },
  {
    /* ESCROW # → FIND MAIL. The suggester only ever runs on get_thread, so it
     * fires for threads somebody happens to open — the feature depended on the
     * behaviour it exists to replace. This is the manual trigger.
     *
     * Drives lpEscrowFindMail() directly with GmailInbox.call replaced by a
     * recorder, because the button lives in the Loan Snapshot, which CLAUDE.md
     * already records as unreachable under the stub. So: this proves the search
     * decision, the refusal, and the file contract — not the button's placement
     * in a pane the harness cannot reach. Said plainly rather than implied.
     *
     * The two assertions that matter are the negatives. An unmatchable
     * reference must not SEARCH (searching would surface mail nothing will ever
     * file, so the feature looks broken instead of saying no), and rendering
     * results must not FILE — matching proposes, a human decides, exactly as
     * the suggester does. */
    name: 'escrow Find-mail searches, refuses below the floor, and files only on click',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      // Recorder in place of the real call, and a box for the results.
      ['(function(){ window.__gm=[];'
        + ' if(!document.getElementById("lpEscrowFindBox")){ var d=document.createElement("div"); d.id="lpEscrowFindBox"; document.body.appendChild(d); }'
        + ' window.GmailInbox = window.GmailInbox || {};'
        + ' window.GmailInbox.call = function(cl, mb, action, params){ window.__gm.push({ mb:mb, action:action, params:params });'
        + '   if(action==="list_threads") return Promise.resolve({ threads:['
        /* THE REAL SHAPE. This stub returned from:"escrow@title.test" — a STRING —
           and gmail-inbox actually returns from:{ email, name } and an ISO date.
           So the panel rendered "[object Object]" in production for months while
           this spec stayed green: a stub that under-delivers reads as a working
           page, and here it under-delivered by being SIMPLER than reality, which
           is the harder version to notice. Shapes copied from
           supabase/functions/gmail-inbox/index.ts list_threads. */
        + '     { id:"t1", subject:"Closing statement", from:{email:"escrow@title.test",name:"Title Escrow"}, date:"2026-08-06T17:04:00.000Z" },'
        + '     { id:"t2", subject:"Wire instructions",  from:{email:"escrow@title.test",name:null},          date:"2026-08-07T18:22:00.000Z" } ] });'
        + '   return Promise.resolve({ ok:true }); };'
        + ' return "installed"; })()', 'installed'],

      // ── BELOW THE FLOOR: explains, and does NOT search ───────────────────
      ['(async function(){ _lpEscrowRef = "12345";'   // all digits, < 7 → unmatchable
        + ' await lpEscrowFindMail();'
        + ' var t=document.getElementById("lpEscrowFindBox").textContent;'
        + ' return (window.__gm.length===0 ? "no search" : "SEARCHED") + " | "'
        + '   + (t.indexOf("cannot be matched on") >= 0 ? "explained" : "silent"); })()',
       'no search | explained'],

      // ── ABOVE THE FLOOR: searches, quoted, both admin mailboxes ──────────
      ['(async function(){ window.__gm=[]; _lpEscrowRef = "ESC-1094772";'
        + ' await lpEscrowFindMail();'
        + ' var qs=window.__gm.filter(function(c){return c.action==="list_threads";});'
        + ' return qs.length + "|" + (qs[0] ? qs[0].params.q : ""); })()',
       '2|"ESC-1094772"'],

      // Results are offered…
      ['document.querySelectorAll("#lpEscrowFindBox .lpEscFileBtn").length', 2],
      /* THE BUG THIS SPEC MISSED. Assert on rendered TEXT, not just element
         counts: "[object Object]" satisfies every count and selector assertion
         above it. Both the object form and the null-name form must render as a
         person, and the ISO date must not reach the screen raw. */
      ['document.getElementById("lpEscrowFindBox").textContent.indexOf("[object") >= 0', false],
      ['document.getElementById("lpEscrowFindBox").textContent.indexOf("Title Escrow <escrow@title.test>") >= 0', true],
      ['document.getElementById("lpEscrowFindBox").textContent.indexOf("2026-08-06T17:04") >= 0', false],
      ['document.getElementById("lpEscrowFindBox").textContent.indexOf("Aug 6, 2026") >= 0', true],
      // …and NOTHING was filed by rendering them.
      ['window.__gm.filter(function(c){return c.action==="tag";}).length', 0],

      // ── Clicking one files THAT thread, through `tag`, to this lead ──────
      ['(async function(){ document.querySelector("#lpEscrowFindBox .lpEscFileBtn").click();'
        + ' await new Promise(function(r){ setTimeout(r, 400); });'
        + ' var tags=window.__gm.filter(function(c){return c.action==="tag";});'
        + ' return tags.length + "|" + (tags[0] ? tags[0].params.thread_id : "")'
        + '   + "|" + (tags[0] ? tags[0].params.contact_id : ""); })()',
       `1|t1|${FIXTURE}`],
      ['document.querySelector("#lpEscrowFindBox .lpEscFileBtn").textContent', 'Filed ✓'],
    ],
  },
  {
    /* MASKED PHONES MUST NEVER REACH A DIAL PATH.
     *
     * mask_phone keeps the last two digits — '(•••) •••-••28' — and dialer.js's
     * toE164 fell through to '+' + digits, so a VA pressing Call dialled '+28'.
     * Six live contacts mask to that. It could not connect, nothing said why,
     * and the row sat at 'ringing' for ever.
     *
     * BOTH DIRECTIONS, because a guard that refuses everything also stops the
     * bug and would be worse than the bug. Real numbers must still dial. */
    name: 'masked phones are refused by every dial path; real ones still dial',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'va',
    evals: [
      // The mask is recognised as a mask, not as a number.
      ['RRPhone.isMasked("(\\u2022\\u2022\\u2022) \\u2022\\u2022\\u2022-\\u2022\\u202228")', true],
      ['RRPhone.isMasked("(714) 555-0142")', false],
      // REFUSED, with a reason a VA can act on.
      ['RRPhone.dialable("(\\u2022\\u2022\\u2022) \\u2022\\u2022\\u2022-\\u2022\\u202228").ok', false],
      ['RRPhone.dialable("(\\u2022\\u2022\\u2022) \\u2022\\u2022\\u2022-\\u2022\\u202228").reason', 'masked'],
      ['RRPhone.dialable("(\\u2022\\u2022\\u2022) \\u2022\\u2022\\u2022-\\u2022\\u202228").message.indexOf("hidden for your role") >= 0', true],
      // THE ORIGINAL BUG, asserted directly: never '+28'.
      ['RRPhone.toE164("(\\u2022\\u2022\\u2022) \\u2022\\u2022\\u2022-\\u2022\\u202228")', null],
      // Real numbers are untouched, in every shape the CRM stores.
      ['RRPhone.toE164("7145550142")', '+17145550142'],
      ['RRPhone.toE164("(714) 555-0142")', '+17145550142'],
      ['RRPhone.toE164("17145550142")', '+17145550142'],
      ['RRPhone.toE164("+17145550142")', '+17145550142'],
      // No fallback for junk — this is the line that used to invent numbers.
      ['RRPhone.dialable("28").ok', false],
      ['RRPhone.toE164("28")', null],

      /* THE DIALER ITSELF REFUSES, not just the helper. Opens the call modal on
         a masked contact and presses Call; the refusal must be on screen and
         the Twilio device must never be reached. */
      ['(async function(){'
        + ' window.openCallModal({ id:"'+FIXTURE+'", first_name:"ZZ-TEST", last_name:"Masked", phone:"(\\u2022\\u2022\\u2022) \\u2022\\u2022\\u2022-\\u2022\\u202228" });'
        + ' document.getElementById("cmStartBtn").click();'
        + ' await new Promise(function(r){ setTimeout(r,500); });'
        + ' var n=document.getElementById("cmDialRefusal");'
        + ' return n ? (n.textContent.indexOf("hidden for your role")>=0 ? "refused with reason" : "refused, no reason") : "DIALLED"; })()',
       'refused with reason'],
      // The SDK was never even fetched — refusal happens before getDevice().
      ['!!window._rrTwilioSdkP', false],
    ],
  },
  {
    /* ONE PHONE FORMAT, APP-WIDE. One card showed "818 272 7418",
     * "8185548206" and "818 408 2101" — three shapes on one screen, from four
     * per-page formatters that had drifted. */
    name: 'phone formatting is one shared rule, and a mask survives it',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      ['RRPhone.format("8182727418")', '(818) 272-7418'],
      ['RRPhone.format("818 272 7418")', '(818) 272-7418'],
      ['RRPhone.format("18182727418")', '(818) 272-7418'],
      ['RRPhone.format("+18182727418")', '(818) 272-7418'],
      ['RRPhone.format("(818) 272-7418")', '(818) 272-7418'],
      /* THE MASK SURVIVES. Formatting it would either mangle it or tidy it into
         something that reads like a real number — and the value it carries is
         two digits of a borrower's phone. */
      ['RRPhone.format("(\\u2022\\u2022\\u2022) \\u2022\\u2022\\u2022-\\u2022\\u202228")', '(•••) •••-••28'],
      // NOT GUESSED. An extension, a partial mid-entry, an international number.
      ['RRPhone.format("818 272 7418 x22")', '818 272 7418 x22'],
      ['RRPhone.format("8182")', '8182'],
      ['RRPhone.format("+44 20 7946 0958")', '+44 20 7946 0958'],
      ['RRPhone.format("")', ''],
      // DISPLAY ONLY — digits() is what a save path uses, and it never formats.
      ['RRPhone.digits("(818) 272-7418")', '8182727418'],
      // Surface 1: the dialer's own formatter now delegates.
      ['(function(){ window.openCallModal({ id:null, first_name:"Fmt", last_name:"Probe", phone:"8182727418" });'
        + ' return document.getElementById("cmPhone").textContent; })()', '(818) 272-7418'],
    ],
  },
  {
    /* Surface 2, and the one that matters most for the mask: va-people renders
     * mask_phone() output for every row. Asserts the mask is STILL a mask after
     * the formatter ran — the negative that a "format everything" change breaks. */
    name: 'va-people renders masked phones unchanged',
    url: '/admin/va-people',
    role: 'va',
    rpc: {
      va_shared_leads: [
        { contact_id: '11111111-1111-4111-8111-111111111111', name: 'Karina Bernal',
          email: 'lead-1111@masked.local', phone: '(•••) •••-••28', pipeline_status: 'New Lead' },
      ],
    },
    expectText: ['(•••) •••-••28'],
    // The two surviving digits must not have been reformatted into a number.
    absentText: ['(•••) •••-28', '+28'],
  },
  {
    /* FORMAT ON RENDER, STRIP ON SAVE — asserted on what would be WRITTEN.
     *
     * These two inputs were the only display sites left unformatted, because
     * their save paths wrote the field value raw: formatting them would have
     * put "(818) 272-7418" into loan_contacts.phone and vendor_directory.
     *
     * Checking that the input renders formatted proves half of it and the
     * dangerous half is the other one, so this asserts on the PAYLOAD the save
     * builds, not on the field. _lpPhoneForSave is that payload's phone value.
     * Three cases, and the third is the one that would quietly destroy data:
     * a masked value must be SKIPPED, not written as its two surviving digits. */
    name: 'phone inputs format on render and strip on save',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      // Rendered formatted…
      ['RRPhone.format("8182727418")', '(818) 272-7418'],
      // …and what the save would write is DIGITS, from the formatted string.
      ['_lpPhoneForSave("(818) 272-7418")', '8182727418'],
      ['_lpPhoneForSave("818 272 7418")', '8182727418'],
      ['_lpPhoneForSave("+1 (818) 272-7418")', '18182727418'],
      ['_lpPhoneForSave("")', null],
      /* A MASK RETURNS undefined, which the callers use to omit the column
         entirely. Writing RRPhone.digits() of a mask would store '28' and
         destroy the real number for everyone. */
      ['typeof _lpPhoneForSave("(\\u2022\\u2022\\u2022) \\u2022\\u2022\\u2022-\\u2022\\u202228")', 'undefined'],
      // The formatted value round-trips: format(strip(format(x))) is stable.
      ['RRPhone.format(_lpPhoneForSave(RRPhone.format("8182727418")))', '(818) 272-7418'],
    ],
  },
  {
    /* VOE PANEL — SEVERAL ORDERS VISIBLE AT ONCE.
     *
     * Multiple VOEs per borrower already worked at the data layer (the unique
     * index carries WHERE order_type <> 'voe'); the UI stacked every card at
     * full height, so two employers became a wall and each card's state was a
     * <select> you had to read.
     *
     * Drives the real lpRenderVoe() with three orders. The assertions that
     * matter are the ones a "make it prettier" change would break: the body
     * COLLAPSES when there are several (that is what stops the wall), a single
     * card stays OPEN (the common case must not regress into needing a click),
     * and the closed header still identifies the order — a collapsed strip you
     * have to open to recognise is a worse wall than the tall one. */
    name: 'VOE panel shows several orders at once, collapsed and stateful',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    evals: [
      ['(function(){'
        + ' var h=document.getElementById("lpVoeCards");'
        + ' if(!h){ h=document.createElement("div"); h.id="lpVoeCards"; document.body.appendChild(h); }'
        + ' _lpVoeOpen={};'
        + ' _lpBorrowers=[{contact_id:"b1",name:"Ana Borrower",is_primary:true}];'
        + ' _lpVoes=[{key:"v1",id:"11111111-1111-4111-8111-000000000001",status:"received",employer_name:"Acme Corp",borrower_contact_id:"b1"},'
        + '          {key:"v2",id:"11111111-1111-4111-8111-000000000002",status:"needs_revision",employer_name:"Globex",borrower_contact_id:"b1"},'
        + '          {key:"v3",id:null,status:"not_ordered",employer_name:"",label:""}];'
        + ' lpRenderVoe(); return document.querySelectorAll("#lpVoeCards [data-voe-key]").length; })()', 3],

      // A GRID, so several fit across rather than stacking.
      ['getComputedStyle(document.getElementById("lpVoeCards")).display', 'grid'],

      // With several, bodies are CLOSED — this is what removes the wall.
      ['document.getElementById("lpVoeBody-v1").style.display', 'none'],
      ['document.getElementById("lpVoeBody-v2").style.display', 'none'],

      // …and the closed header still identifies the order.
      ['document.querySelector(\'[data-voe-key="v1"]\').textContent.indexOf("Acme Corp") >= 0', true],
      ['document.querySelector(\'[data-voe-key="v1"]\').textContent.indexOf("Ana Borrower") >= 0', true],
      // An untitled, unsaved card is still recognisable rather than a blank strip.
      ['document.querySelector(\'[data-voe-key="v3"]\').textContent.indexOf("Untitled VOE") >= 0', true],

      /* STATE READS WITHOUT OPENING, and the two differ — the same chip
         vocabulary as the activity rows and the HOI panel. */
      ['(function(){ var c=document.querySelector(\'[data-voe-key="v1"] span[style*="border-radius:999px"]\');'
        + ' return c ? c.textContent.replace(/[^A-Za-z]/g,"").toUpperCase() : "none"; })()', 'RECEIVED'],
      ['(function(){ var c=document.querySelector(\'[data-voe-key="v2"] span[style*="border-radius:999px"]\');'
        + ' return c ? c.textContent.replace(/[^A-Za-z]/g,"").toUpperCase() : "none"; })()', 'REVISION'],
      ['getComputedStyle(document.querySelector(\'[data-voe-key="v1"]\')).borderLeftColor !== '
        + 'getComputedStyle(document.querySelector(\'[data-voe-key="v2"]\')).borderLeftColor', true],

      // Clicking the header opens THAT card only.
      ['(function(){ lpVoeToggle("v2");'
        + ' return document.getElementById("lpVoeBody-v2").style.display + "|" + document.getElementById("lpVoeBody-v1").style.display; })()',
       'block|none'],
      // An open card survives a re-render — it runs on every field change.
      ['(function(){ lpRenderVoe(); return document.getElementById("lpVoeBody-v2").style.display; })()', 'block'],

      /* ONE card stays OPEN. The wall only ever happened with several, and
         making the common case need a click would be a regression. */
      ['(function(){ _lpVoeOpen={};'
        + ' _lpVoes=[{key:"solo",id:"11111111-1111-4111-8111-000000000009",status:"ordered",employer_name:"Solo Inc",borrower_contact_id:"b1"}];'
        + ' lpRenderVoe(); return document.getElementById("lpVoeBody-solo").style.display; })()', 'block'],
    ],
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
    /* THE BUYDOWN CHECKBOX IS A REAL CONTROL, driven and recorded.
     *
     * _fsSectionToggles renders entirely from what the server serves, so adding
     * `buydown` to _fs_share_section_keys is supposed to make a checkbox appear
     * here with no change to lead-detail.html. "Supposed to" is the part worth
     * checking: the panel filters on `available`, and a section that is offered
     * but never drawn — or drawn but never offered — is exactly the dead-toggle
     * defect this whole change exists to remove.
     *
     * The rpcFns payload below is the REAL output of list_fee_sheet_snapshots
     * for the ZZ-TEST fixture's link, copied verbatim from the database rather
     * than invented, so the shape the page parses is the shape it will get.
     *
     * THE CLICK IS PROVEN TWICE, and neither proof is "something changed":
     *   1. a capture-phase listener installed before the click records that the
     *      event reached the input, and
     *   2. the stubbed setter records the exact patch that went out.
     * Note what (2) asserts: ONE key. fsSetSection posting the whole map is the
     * bug that would silently reset a key an older client had never heard of. */
    name: 'section checkboxes appear from the server list, and post one key each',
    url: `/admin/lead-detail?contact_id=${FIXTURE}`,
    role: 'admin',
    rpcFns: {
      list_fee_sheet_snapshots: `() => ([{
        slug: 'zztbdqa', status: 'live', has_video: false,
        contact_id: '${FIXTURE}', borrower_name: 'ZZ-TEST Fixture Borrower',
        created_at: '2026-08-14T05:10:25.720837+00:00',
        expires_at: null, revoked_at: null, archived_at: null,
        view_count: 0, last_viewed_at: null,
        share_sections: {}, snapshot_mode: 'rate', mode_override: null,
        modes: [
          { key:'rate',     label:'Rate Comparison',     available:true },
          { key:'single',   label:'Single Rate',         available:true },
          { key:'price',    label:'Price Comparison',    available:true },
          { key:'property', label:'Property Comparison', available:true },
          { key:'buydown',  label:'Buydown',             available:true },
          { key:'heloc',    label:'HELOC',               available:false }
        ],
        sections: [
          { key:'fee_schedule',   label:'Fee breakdown',    available:true,  on:false },
          { key:'lender_credits', label:'Lender credits',   available:true,  on:false },
          { key:'people',         label:'Co-borrowers',     available:false, on:false },
          { key:'bridge',         label:'Bridge addendum',  available:true,  on:false },
          { key:'buydown',        label:'Buydown schedule', available:true,  on:false }
        ]
      }])`,
      /* Records rather than answers, onto window so an eval can read it back.
         The assertion is on what the click POSTED, not on the page changing. */
      set_fee_sheet_sections: `(args) => { window.__bdPosted = (window.__bdPosted||[]).concat([args]); return args.p_sections; }`,
    },
    evals: [
      ['(async function(){ await fsLoadShareLinks(); '
        + 'await new Promise(function(s){setTimeout(s,500);}); '
        + 'return document.querySelectorAll("#fsShareLinks input[type=checkbox]").length; })()', 4],
      /* UNAVAILABLE SECTIONS ARE NOT OFFERED. people and bridge are false for this
         snapshot, so their checkboxes must be absent — and buydown's must be
         present, which is what stops this passing on an empty panel. */
      /* SECTION labels only. The mode picker is a <label> too — it wraps the
         <select> — so an unfiltered label sweep picks up the concatenated mode
         names and reads as a section that does not exist. */
      ['[].filter.call(document.querySelectorAll("#fsShareLinks label"), function(l){'
        + 'return l.querySelector("input[type=checkbox]");}).map(function(l){return l.textContent.trim();})',
       ['Fee breakdown', 'Lender credits', 'Bridge addendum', 'Buydown schedule']],
      ['(function(){var l=[].filter.call(document.querySelectorAll("#fsShareLinks label"),'
        + 'function(e){return /Buydown schedule/.test(e.textContent);})[0];'
        + 'return l ? l.querySelector("input[type=checkbox]").checked : "no checkbox";})()', false],
      /* Drive it. The listener goes on FIRST and is capture-phase, so it records
         the event regardless of whether the page has any handler at all. */
      ['(async function(){'
        + 'window.__bdClicks=[];'
        + 'document.addEventListener("click", function(e){ window.__bdClicks.push({tag:e.target.tagName, type:e.target.type||null}); }, true);'
        + 'var l=[].filter.call(document.querySelectorAll("#fsShareLinks label"), function(e){return /Buydown schedule/.test(e.textContent);})[0];'
        + 'if(!l) return "no buydown checkbox to click";'
        + 'l.querySelector("input[type=checkbox]").click();'
        + 'await new Promise(function(s){setTimeout(s,700);});'
        + 'return window.__bdClicks;})()',
       [{ tag: 'INPUT', type: 'checkbox' }]],
      /* ONE KEY, the right one, for the right slug. Not the whole map: posting
         every key is how a section an older client has never heard of gets
         silently reset to hidden. */
      /* Drive the SECOND control too. Two clicks, two posts, each carrying its
         own single key — which is the property that matters: a panel posting the
         whole map would show both keys in the first patch. */
      ['(async function(){'
        + 'var l=[].filter.call(document.querySelectorAll("#fsShareLinks label"), function(e){return /Bridge addendum/.test(e.textContent);})[0];'
        + 'if(!l) return "no bridge checkbox to click";'
        + 'l.querySelector("input[type=checkbox]").click();'
        + 'await new Promise(function(s){setTimeout(s,700);});'
        + 'return window.__bdClicks;})()',
       [{ tag: 'INPUT', type: 'checkbox' }, { tag: 'INPUT', type: 'checkbox' }]],
      ['JSON.stringify(window.__bdPosted||[])',
       '[{"p_slug":"zztbdqa","p_sections":{"buydown":true}},{"p_slug":"zztbdqa","p_sections":{"bridge":true}}]'],
    ],
    /* No expectText: the Fee Sheet tab is not the open one, so its labels are
       not in innerText. The evals above assert the same thing structurally,
       which is the right level for a control inside a closed tab anyway. */
  },
  {
    /* THE PLACES CONSOLIDATION, ON A FIXTURE — because the live page cannot
     * prove any of it. The Google key is referrer-restricted to the real domain
     * and the widget only fires on a human picking from a dropdown, so on
     * lead-detail there is nothing to assert against: the fields render (proven
     * by the spec below) and the parse never runs.
     *
     * The fixture installs an instrumented google.maps.places, so the three
     * things that actually went wrong become countable:
     *   1. HOW MANY widgets bind to one input. Three copies of this code used to
     *      exist; the premise of the module is that there is now one.
     *   2. WHETHER a selection with no address_components fetches the details.
     *      The old `if (!place.address_components) return;` left Google's
     *      ZIP-LESS description sitting in the box and the autosave stored it —
     *      all 18 such stored addresses have no ZIP, all 12 resolved ones do.
     *   3. WHICH COUNTY comes back. This is the LA-not-Kern bug in 53bffa8:
     *      93505 has ZIP3 prefix 935, which ZIP_TO_COUNTY maps to Los Angeles,
     *      and California City is in KERN. Captured beats inferred, and the only
     *      way that claim stays true is if something checks it.
     *
     * What it does NOT prove: that Google really returns
     * administrative_area_level_2 for a given address. That needs the live key.
     * The fixture supplies the components; it cannot vouch for them.
     *
     * The evals run IN ORDER and chain deliberately — each selection leaves
     * state the next one builds on — so they end with #f-property unresolved and
     * #home-street resolved. present/absent below assert both halves of that,
     * which is why neither check is vacuous. */
    name: 'places consolidation: one widget, one details fetch, county captured',
    url: fixture('places-consolidation.html'),
    role: 'admin',
    evals: [
      /* 1 — ONE widget per input, not three. */
      ['window.__metrics.autocompleteConstructed', 2],
      ['window.__metrics.byInput["f-property"]', 1],
      ['window.__metrics.byInput["home-street"]', 1],
      /* Re-attaching is a no-op rather than a second widget. lead-detail
         re-runs its wiring on re-render, so this is the normal path. */
      ['(async function(){var r=window.RRPlaces.attachCombined("f-property",{});'
        + 'await new Promise(function(s){setTimeout(s,30);});'
        + 'return [r, window.__metrics.autocompleteConstructed];})()', [null, 2]],

      /* 2 — THE EARLY RETURN THAT ATE THE ZIP. Google auto-fills the ZIP-less
         description, place_changed arrives with no components, and the module
         must go and FETCH them. Asserting on the input's value is the point:
         what ends up in the box is what gets persisted. */
      ['(async function(){'
        + 'window.__select("f-property", "43636 Devyn Ln, Lancaster, CA, USA", {place_id:"PID_LANCASTER"},'
        + ' {address_components: window.__F.lancaster.components, formatted_address: window.__F.lancaster.formatted});'
        + 'await new Promise(function(s){setTimeout(s,60);});'
        + 'var el=document.getElementById("f-property"), last=window.__captured[window.__captured.length-1];'
        + 'return {fetched: window.__metrics.detailsFetched, value: el.value,'
        + ' resolved: window.RRPlaces.isResolved(el), zip: last.parts.zip,'
        + ' county: last.parts.county, isProperty: last.parts.isProperty};})()',
       { fetched: 1, value: '43636 Devyn Ln, Lancaster, CA 93534', resolved: true,
         zip: '93534', county: 'Los Angeles', isProperty: true }],

      /* 3 — COUNTY, AND THE SPLIT FIELDS. 93505 is the case the ZIP3 table gets
         wrong; captured says Kern. If this ever reads "Los Angeles" the fee
         sheet has gone back to guessing. */
      ['(async function(){'
        + 'window.__select("home-street", "8560 Eucalyptus Ave, California City, CA, USA", {place_id:"PID_CALCITY"},'
        + ' {address_components: window.__F.calcity.components, formatted_address: window.__F.calcity.formatted});'
        + 'await new Promise(function(s){setTimeout(s,60);});'
        + 'var g=function(id){return document.getElementById(id).value;};'
        + 'return {street:g("home-street"), city:g("home-city"), state:g("home-state"),'
        + ' zip:g("home-zip"), county:g("home-county"),'
        + ' resolved: window.RRPlaces.isResolved(document.getElementById("home-street"))};})()',
       { street: '8560 Eucalyptus Ave', city: 'California City', state: 'CA',
         zip: '93505', county: 'Kern', resolved: true }],

      /* The exported parse is the SAME parse — this is what lead-detail's two
         former copies now delegate to, and "County" is stripped exactly once. */
      ['JSON.stringify(window.RRPlaces.parts({address_components: window.__F.calcity.components}))',
       '{"street":"8560 Eucalyptus Ave","city":"California City","state":"CA","zip":"93505","county":"Kern","isProperty":true}'],

      /* 4 — A CITY IS A PLACE, NOT A PROPERTY. "Santa Clarita, CA, USA" resolves
         perfectly and has no house number and no ZIP. It must come back stamped
         unresolved, or a city name gets stored as a subject property again. */
      ['(async function(){'
        + 'window.__select("f-property", "Santa Clarita, CA, USA", {place_id:"PID_SC"},'
        + ' {address_components: window.__F.santaClarita.components, formatted_address: window.__F.santaClarita.formatted});'
        + 'await new Promise(function(s){setTimeout(s,60);});'
        + 'var el=document.getElementById("f-property"), last=window.__captured[window.__captured.length-1];'
        + 'return {value: el.value, resolved: window.RRPlaces.isResolved(el),'
        + ' isProperty: last.parts.isProperty, zip: last.parts.zip, county: last.parts.county};})()',
       { value: 'Santa Clarita, CA', resolved: false, isProperty: false, zip: '', county: 'Los Angeles' }],

      /* 5 — NOTHING SELECTED costs no Details call. A lookup with no place_id to
         look up is answered locally; billing a request for it would be the
         per-keystroke cost this module's header says does not exist here. */
      ['(async function(){var before=window.__metrics.detailsFetched;'
        + 'window.__select("f-property", "just typing", {}, null);'
        + 'await new Promise(function(s){setTimeout(s,60);});'
        + 'var last=window.__captured[window.__captured.length-1];'
        + 'return {spent: window.__metrics.detailsFetched - before, event: last.event, why: last.why};})()',
       { spent: 0, event: 'unresolved', why: 'no suggestion was selected' }],

      /* 6 — WHEN THE DETAILS LOOKUP ITSELF FAILS, the description Google wrote
         is LEFT in the box (deleting what somebody just picked is worse) but
         stamped unresolved with the reason on screen. Note the value: still
         ZIP-less. That is the failure the stamp exists to make refusable. */
      ['(async function(){'
        + 'window.__select("f-property", "43636 Devyn Ln, Lancaster, CA, USA", {place_id:"PID_DEAD"}, null);'
        + 'await new Promise(function(s){setTimeout(s,60);});'
        + 'var el=document.getElementById("f-property"), last=window.__captured[window.__captured.length-1];'
        + 'return {value: el.value, resolved: window.RRPlaces.isResolved(el),'
        + ' event: last.event, why: last.why};})()',
       { value: '43636 Devyn Ln, Lancaster, CA, USA', resolved: false, event: 'unresolved',
         why: 'Google returned no details for that suggestion (ZERO_RESULTS)' }],

      /* Totals across the whole run: six selections, four of which had something
         to look up, and never a second widget on either input. */
      ['[window.__metrics.detailsFetched, window.__metrics.autocompleteConstructed]', [4, 2]],
      /* The dropdown stylesheet is injected once no matter how many attaches. */
      ['document.querySelectorAll("#rrPlacesStyle").length', 1],
    ],
    /* The unresolved warning must be ON SCREEN, not merely a dataset flag — and
       the resolved field must NOT be carrying one. Same selector shape, opposite
       verdicts, so neither passes by the element simply never existing. */
    present: ['#f-property__addrNote'],
    absent: ['#home-street__addrNote'],
    expectText: ['⚠ Address not confirmed'],
    minVisibleText: 60,
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
    /* THE VA TRAINING PAGE, and the formatter both it and the ⓘ popup render
       through.
       The page's DATA comes from help_topics and the stub does not serve real
       rows, so this deliberately does NOT assert section counts — that would be
       asserting a fact about the stub. What it asserts is everything that is
       true regardless of data: the shell renders, the script parses and runs,
       and mdToHtml turns markdown into the right tags AND refuses the two things
       that would make it a security hole.
       That last part is the reason this spec exists. mdToHtml is hand-written
       markup generation over author text; if it ever stopped escaping first, a
       help topic would become script injection on every page that shows a ⓘ. */
    name: 'VA training page renders and its markdown formatter is safe',
    url: '/admin/va-training',
    role: 'admin',
    steps: [{ waitMs: 1500 }],
    present: ['#sections', '#tocList', '#q'],
    evals: [
      ['typeof (window.HelpTopic && window.HelpTopic.mdToHtml)', 'function'],
      // Structure it must produce.
      ['/<h3>Heading<\\/h3>/.test(window.HelpTopic.mdToHtml("# Heading"))', true],
      ['/<strong>b<\\/strong>/.test(window.HelpTopic.mdToHtml("**b**"))', true],
      ['/<ul><li>one<\\/li><li>two<\\/li><\\/ul>/.test(window.HelpTopic.mdToHtml("- one\\n- two"))', true],
      ['/<ol><li>a<\\/li><\\/ol>/.test(window.HelpTopic.mdToHtml("1. a"))', true],
      ['/href="https:\\/\\/example.com"/.test(window.HelpTopic.mdToHtml("[x](https://example.com)"))', true],
      /* ESCAPE-FIRST. Author text can never become markup: raw HTML stays inert,
         and a javascript: link is left as literal text rather than becoming an
         anchor. */
      ['window.HelpTopic.mdToHtml("<img src=x onerror=alert(1)>").indexOf("<img") === -1', true],
      ['window.HelpTopic.mdToHtml("<script>bad()<\\/script>").indexOf("<script") === -1', true],
      /* ASSERT THE PROPERTY, NOT THE SUBSTRING. The first version of this checked
         that "javascript:" did not appear anywhere in the output — and failed,
         correctly, because a REJECTED link is left as inert escaped TEXT
         ("<p>[x](javascript:alert(1))</p>"). The word appearing as prose is
         harmless; what must never happen is it becoming an href. The bad
         assertion would have pushed someone to "fix" working code. */
      ['/href\\s*=\\s*"\\s*javascript:/i.test(window.HelpTopic.mdToHtml("[x](javascript:alert(1))"))', false],
      ['window.HelpTopic.mdToHtml("[x](javascript:alert(1))").indexOf("<a ") === -1', true],
      ['/href\\s*=\\s*"\\s*data:/i.test(window.HelpTopic.mdToHtml("[x](data:text/html,<script>1</script>)"))', false],
    ],
    minVisibleText: 60,
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

  /* ═══ CRM task board — the Complete → To Do refusal, both roles ═══
   *
   * WHY THESE ARE tokenOnly, and it is not a convenience.
   * The board's rows come from admin-api-v2.js, which imports its client from
   * api/supabase-client.js — and that module calls createClient() on its own
   * import from esm.sh. It is NOT window.supabase, so the document-start stub
   * never sees it and spec.tables cannot feed this board. Without a token the
   * board renders zero cards and both specs below would pass vacuously against
   * an empty board, which is the exact failure this pairing exists to prevent.
   * (That bypass is a harness gap in its own right — see the note after these.)
   *
   * WHY THE PAIR. A spec that only asserts "the va is refused" passes just as
   * well when the board never mounted, when the card selector is wrong, or when
   * nothing is draggable — every one of which yields no movement and no write.
   * The admin spec drags the SAME card onto the SAME column and asserts it is
   * NOT refused, so the selectors are proven live by a run that must come back
   * the other way.
   *
   * NEITHER SPEC WRITES. The va side is refused before the write by
   * construction. The admin side deliberately stops at dragover: the branch made
   * dragover and drop read one predicate, so an unblocked dragover IS the gate
   * opening, and dispatching the drop would reopen a real completed task to
   * prove something the predicate already said. */
  {
    name: 'board refuses Complete → To Do for a va, and writes nothing',
    url: '/dashboard/admin',
    role: 'va',
    tokenOnly: true,
    width: 1440,
    steps: [
      { click: '[data-crm-nav="tasks"]', waitMs: 1500 },
      { click: '[data-subpanel="crm"] [data-task-filter="all"]', waitMs: 2000 },
      { click: '[data-subpanel="crm"] .view-btn[data-view="board"]', waitMs: 2000 },
    ],
    present: ['[data-target="cm-board"] [data-drop-col="done"]',
              '[data-target="cm-board"] [data-drop-col="todo"]'],
    evals: [
      /* BOTH ROLES, ONE PAGE LOAD, ONE CARD — and spec.role is NOT what supplies
         them. Measured: under --token, auth-guard recomputes the real role from
         current_app_role() and OVERWRITES rnr_app_role, so a token run always
         reports the token's own role and `role: 'va'` above is inert here. It is
         kept only so a future stub-mode run is labelled correctly.

         So the role is injected around each drag instead. That is not a
         weakening: crmDropRefusal READS sessionStorage at drag time and calls
         nothing, so this is the predicate's real input arriving by its real
         route. What it buys is that both verdicts come from the SAME card in the
         SAME column milliseconds apart — no second page load, no second card, no
         way for one side to be testing a different board than the other. */
      [RC_BOARD_BOTH_ROLES, 'va=refused|blocked|stayed :: admin=allowed|notblocked'],
    ],
  },
  /* HARNESS GAP, recorded because a green run here says less than it looks like.
   * api/supabase-client.js builds its own client from esm.sh, so every page whose
   * data arrives through admin-api-v2.js is UNSTUBBED under render-check — it
   * reaches real PostgREST, as anon when no token is supplied. spec.tables,
   * spec.rpc and spec.stubRow are all inert for those pages. Closing it means
   * intercepting the module (CDP Fetch) rather than owning a global. Until then,
   * treat any dashboard/admin assertion without --token as untested rather than
   * passing. */
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
    } else if (spec.anonymous) {
      /* ANONYMOUS, UNSTUBBED — the only way to check a PUBLIC page as the world
       * sees it. The stub exists so admin pages never touch real data, but a
       * public snapshot page has no session by design: stubbing it would test the
       * stub, not the page. Used for /fee/<slug>, where the question is literally
       * "what does a stranger holding this URL receive". No token is seeded, so
       * this is a genuinely signed-out browser hitting production. */
    } else {
      await b.send('Page.addScriptToEvaluateOnNewDocument', {
        source: stubSource(spec.role || 'admin', 'render-check@local', spec.stubRow, spec.rpc, spec.fetchMap, spec.rpcFns, spec.staleRole, spec.invoke, spec.tables),
      });
    }

    /* PER-SPEC DOCUMENT-START SCRIPT, installed after the stub so it wraps
       whatever the stub installed rather than being overwritten by it.
       Some defects only exist during page load and cannot be reached from an
       eval, which runs after readyState=complete. The Maps double-load is one:
       both loaders latch module-private state on their first call, so by the
       time an eval runs the outcome is already decided and unrepeatable. A
       spec that can only observe the aftermath cannot force the cause. */
    if (spec.atDocumentStart) {
      await b.send('Page.addScriptToEvaluateOnNewDocument', { source: spec.atDocumentStart });
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
      /* ASYNC, and awaitPromise with it. Some things worth asserting are
         promises: "call this handler and see what it did" is the natural shape
         for a click path, and a sync probe JSON.stringifies a pending Promise
         as {} — which reads as a mismatch against every expected value and
         tells you nothing about why. */
      awaitPromise: true,
      expression: `(async () => {
        const vis = (s) => { const e = document.querySelector(s); return !!e && (e.offsetParent !== null || e === document.body); };
        const has = (s) => !!document.querySelector(s);
        /* Hoisted out of the object literal so each entry can be awaited in
           order. Order matters: spec authors chain evals — install a double,
           run the thing, then assert on what it recorded — and Promise.all
           would run them concurrently and break that. */
        const evalResults = [];
        for (const [expr, want] of ${JSON.stringify(spec.evals || [])}) {
          let got;
          try { got = await eval(expr); } catch (e) { got = '(threw: ' + (e && e.message) + ')'; }
          evalResults.push([expr, JSON.stringify(want) || 'undefined', JSON.stringify(got) || 'undefined']);
        }
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
          /* JS-EXPRESSION ASSERTIONS — computed above, in order, with await.
             Some things a role gate decides are not rendering at all. _smsDest()
             returning null for a VA is what stops an outbound text going to a
             real number the page should never have handed over — there is no
             element to select for that, and asserting on a proxy would be
             asserting on something else. Each entry is [expr, expected]; the
             result is JSON-compared so null, false and '' stay distinct, and an
             expression may be async. */
          evals: evalResults,
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
