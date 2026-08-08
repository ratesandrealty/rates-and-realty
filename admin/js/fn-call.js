/* fn-call.js — one way to call an edge function, sending the SIGNED-IN USER.
 *
 * WHY THIS EXISTS
 * admin/lead-detail.html alone contains 87 hand-rolled `/functions/v1/` fetches,
 * each building its own headers, and most of them send:
 *
 *     'Authorization': 'Bearer ' + anon
 *
 * The anon key is a project-signed JWT printed in every page's source. It passes
 * the gateway's verify_jwt check and identifies NOBODY. That is why 17 functions
 * in docs/PINNED-NOT-GUARDED.md still have no in-function guard: there was no
 * single place to fix the caller, so the guard could never be written without
 * breaking twenty call sites at once.
 *
 * This is that single place. It is the FRONTEND HALF of the order CLAUDE.md
 * requires — callers start sending the session token first, get confirmed
 * working, and only then does a guard land on the function. Shipping this on its
 * own is safe by construction: no function enforces anything yet, so a mistake
 * here shows up as a page that still works rather than an outage.
 *
 * NO ANON FALLBACK. A `|| ANON_KEY` fallback authenticates nobody and converts a
 * clear "you are not signed in" into a mystery 401 later, once guards exist.
 * Every page that loads this file is behind auth-guard.js, so a missing session
 * is a real fault and is reported as one.
 *
 *   const res = await fnFetch('generate-1003-pdf', { method:'POST', body: JSON.stringify({...}) });
 *   // res is a normal Response — existing call sites keep their .ok/.text()/.json() handling
 */
(function () {
  /* Idempotent: auth-guard mounts this app-wide AND three pages declare it
     themselves. Re-running would only reassign the same functions, but bailing
     is cheaper and states the intent. */
  if (window.fnFetch && window.fnCall) return;
  'use strict';
  if (window.fnFetch) return;

  function cfg(k, d) {
    return (window.APP_CONFIG && window.APP_CONFIG[k]) || d || '';
  }

  async function client() {
    try {
      if (typeof window.getSupabaseClient === 'function') return await window.getSupabaseClient();
    } catch (e) { /* fall through to the global the auth guard sets */ }
    return window._supabaseClient || null;
  }

  /* Read the CURRENT access token. Deliberately re-read per call rather than
     cached: tokens expire, and a cached one turns into an intermittent 401 that
     looks like a server fault. getSession() refreshes when it needs to. */
  async function sessionToken() {
    const c = await client();
    if (!c || !c.auth || typeof c.auth.getSession !== 'function') return null;
    try {
      const r = await c.auth.getSession();
      return (r && r.data && r.data.session && r.data.session.access_token) || null;
    } catch (e) { return null; }
  }

  window.fnFetch = async function (slug, init) {
    init = init || {};
    const base = cfg('SUPABASE_URL', 'https://ljywhvbmsibwnssxpesh.supabase.co');
    const anon = cfg('SUPABASE_ANON_KEY', '');
    const token = await sessionToken();

    if (!token) {
      /* Fail here, with a sentence that names the cause, rather than sending a
         key that identifies nobody and letting it fail later as a 401 from the
         gateway that nothing can explain. */
      throw new Error('Not signed in — cannot call ' + slug + '. Reload the page and sign in again.');
    }

    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      init.headers || {},
      {
        /* apikey is the project identifier the gateway routes on; Authorization
           is the IDENTITY. They are different things and only the second one
           says who is calling. */
        'Authorization': 'Bearer ' + token,
        'apikey': anon
      }
    );

    return fetch(base + '/functions/v1/' + slug, Object.assign({}, init, { headers: headers }));
  };

  /* Convenience for the common "POST json, read json, throw on failure" shape.
     Returns parsed JSON; throws an Error carrying the server's message so the
     caller can surface it instead of a bare "failed". */
  window.fnCall = async function (slug, body, init) {
    const res = await window.fnFetch(slug, Object.assign(
      { method: 'POST', body: JSON.stringify(body || {}) }, init || {}));
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || text || ('HTTP ' + res.status);
      const err = new Error(slug + ': ' + msg);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  };
})();
