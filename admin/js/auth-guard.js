// admin/js/auth-guard.js
// Guards every admin/* page: ensures a Supabase session exists, redirects to login if not,
// and exposes window._supabaseClient + window._adminUser + window.adminLogout for the rest of the page.
//
// Loading strategy:
//   - If /admin/js/supabase-client.js is loaded first (preferred), we call getSupabaseClient().
//   - Otherwise we fall back to the legacy inline behavior: lazy-inject the supabase-js CDN
//     and /api/env.js, then create a client ourselves. This keeps pages that haven't been
//     migrated to the canonical client working unchanged.

(function () {
  'use strict';

  // 1. Skip entirely on the login page.
  if (window.location.pathname.includes('admin-login')) {
    return;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  async function ensureSupabaseLib() {
    if (typeof window.supabase !== 'undefined' && window.supabase) return;
    await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
  }

  async function ensureAppConfig() {
    if (typeof window.APP_CONFIG !== 'undefined' && window.APP_CONFIG) return;
    await loadScript('/api/env.js');
  }

  async function getClient() {
    // Preferred path: canonical getter from /admin/js/supabase-client.js
    if (typeof window.getSupabaseClient === 'function') {
      return await window.getSupabaseClient();
    }
    // Fallback path: legacy inline behavior so unmigrated pages keep working.
    await ensureAppConfig();
    await ensureSupabaseLib();
    if (window._supabaseClient) return window._supabaseClient;
    const cfg = window.APP_CONFIG;
    const client = window.supabase.createClient(
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
    return client;
  }

  function redirectToLogin() {
    const path = window.location.pathname;
    const search = window.location.search || '';
    window.location.replace('/auth/admin-login.html?redirect=' + encodeURIComponent(path + search));
  }

  // Run the guard immediately (do not wait for DOMContentLoaded — we want to redirect
  // before unauthenticated page scripts start firing fetches).
  (async () => {
    let client;
    try {
      client = await getClient();
    } catch (err) {
      console.error('[auth-guard] failed to initialize Supabase client:', err);
      redirectToLogin();
      return;
    }

    // Make sure the rest of the page sees the same client instance.
    window._supabaseClient = client;

    let session = null;
    try {
      const { data } = await client.auth.getSession();
      session = data && data.session ? data.session : null;
    } catch (err) {
      console.error('[auth-guard] getSession failed:', err);
      session = null;
    }

    if (!session) {
      redirectToLogin();
      return;
    }

    window._adminUser = session.user;

    // Logout helper. Capture the client at init time (matches current semantics).
    window.adminLogout = async function () {
      try {
        await client.auth.signOut();
      } catch (err) {
        console.error('[auth-guard] signOut failed:', err);
      }
      window.location.replace('/auth/admin-login.html');
    };

    // Fill #adminUserEmail when the DOM is ready.
    function fillEmail() {
      const el = document.getElementById('adminUserEmail');
      if (el && session.user && session.user.email) {
        el.textContent = session.user.email;
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fillEmail);
    } else {
      fillEmail();
    }
  })();
})();
