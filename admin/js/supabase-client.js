// admin/js/supabase-client.js
// Canonical Supabase client for the admin dashboard.
// All admin pages should call getSupabaseClient() instead of creating their own client
// or building manual fetch headers. This ensures supabase-js auto-attaches the session JWT
// to every request, so RLS policies see the authenticated user (not anon).
//
// Usage:
//   const client = await getSupabaseClient();
//   const { data, error } = await client.from('contacts').select('*').limit(500);
//
// Requirements (load order in HTML):
//   1. /admin/js/env.js              -> sets window.APP_CONFIG { SUPABASE_URL, SUPABASE_ANON_KEY }
//   2. supabase-js CDN                -> sets window.supabase
//   3. /admin/js/supabase-client.js  -> this file
//   4. /admin/js/auth-guard.js       -> uses getSupabaseClient()

(function () {
  'use strict';

  // Poll for a global to appear, up to timeoutMs.
  function waitForGlobal(name, timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function check() {
        if (typeof window[name] !== 'undefined' && window[name] !== null) {
          return resolve(window[name]);
        }
        if (Date.now() - start > timeoutMs) {
          return reject(new Error('Timed out waiting for window.' + name));
        }
        setTimeout(check, 25);
      })();
    });
  }

  let _clientPromise = null;

  /* THE CLIENT EXISTING IS NOT THE SESSION BEING READY.
   *
   * supabase-js restores the persisted session from localStorage ASYNCHRONOUSLY
   * after createClient() returns. This function used to resolve the moment the
   * client object existed, so `await getSupabaseClient()` could hand back a
   * client with no session attached yet — and the very next .from(...) went out
   * with the anon key alone.
   *
   * Against an RLS-protected table that is a 403 on EVERY policy at once, which
   * is what it looks like from the outside: Rene's
   *   GET /rest/v1/mortgage_applications?select=borrower_type&id=eq.33262b23… 403
   * on a row with four policies, as an admin, on a lead that IS shared. All four
   * resolve through auth.uid(), and auth.uid() was NULL. Intermittent, because it
   * is a race — "works sometimes" is the signature.
   *
   * Fixing it at each call site is whack-a-mole: every admin page shares this
   * helper, and a call site that remembers is indistinguishable from one that
   * forgets until it fails. So the promise now resolves only once the session
   * question has been ANSWERED — signed in or genuinely signed out.
   *
   * A logged-out page is not delayed meaningfully: getSession() resolves with
   * { session: null } as soon as storage has been read. The timeout exists so a
   * hung auth endpoint degrades to the old behaviour instead of hanging the page
   * forever — the request may then 403, which is the pre-existing failure, not a
   * new one. */
  async function _awaitSessionSettled(client) {
    try {
      await Promise.race([
        client.auth.getSession(),
        new Promise(function (r) { setTimeout(r, 3000); }),
      ]);
    } catch (e) {
      console.warn('[supabase-client] getSession() failed; continuing unauthenticated:', e);
    }
    return client;
  }

  async function getSupabaseClient() {
    /* Return the shared promise, not the bare global, so callers arriving during
       session restore wait for it too. window._supabaseClient is still set for
       legacy synchronous readers, but they get no such guarantee. */
    if (_clientPromise) return _clientPromise;

    _clientPromise = (async () => {
      // Wait for env config and the supabase-js library to be present.
      const cfg = await waitForGlobal('APP_CONFIG', 5000);
      const supabaseLib = await waitForGlobal('supabase', 5000);

      if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
        throw new Error('APP_CONFIG missing SUPABASE_URL or SUPABASE_ANON_KEY');
      }
      if (typeof supabaseLib.createClient !== 'function') {
        throw new Error('window.supabase.createClient is not a function (CDN not loaded?)');
      }

      const client = supabaseLib.createClient(
        cfg.SUPABASE_URL,
        cfg.SUPABASE_ANON_KEY,
        {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        }
      );

      window._supabaseClient = client;
      /* Set the global BEFORE awaiting the session so synchronous legacy readers
         (_authClient() and friends) still find a client, then hold this promise
         open until the session has settled. */
      return await _awaitSessionSettled(client);
    })();

    return _clientPromise;
  }

  // Expose on window so plain <script>-loaded pages can call it.
  window.getSupabaseClient = getSupabaseClient;
})();
