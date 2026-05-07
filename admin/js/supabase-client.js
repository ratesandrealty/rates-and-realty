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

  async function getSupabaseClient() {
    if (window._supabaseClient) return window._supabaseClient;
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
            storageKey: 'rr-admin-auth',
          },
        }
      );

      window._supabaseClient = client;
      return client;
    })();

    return _clientPromise;
  }

  // Expose on window so plain <script>-loaded pages can call it.
  window.getSupabaseClient = getSupabaseClient;
})();
