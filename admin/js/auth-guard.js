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

  /* Cookie on the PARENT domain so admin.* and the apex share it. Only set on a
   * real ratesandrealty.com host — on localhost a Domain= cookie is silently
   * dropped, so skip it rather than pretend it took. */
  function setStaffMarker(on) {
    try {
      var h = location.hostname;
      if (h !== 'ratesandrealty.com' && h.indexOf('.ratesandrealty.com') === -1) return;
      document.cookie = 'rr_staff=' + (on ? '1' : '') +
        '; Domain=.ratesandrealty.com; Path=/; Max-Age=' + (on ? 2592000 : 0) +
        '; SameSite=Lax; Secure';
    } catch (err) {
      console.warn('[auth-guard] staff marker not set:', err);
    }
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

  // Full-screen overlay shown when a non-admin hits an admin-only page.
  function denyAccess() {
    const overlay = document.createElement('div');
    overlay.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:999999',
      'background:#0a0a0a', 'color:#fff',
      'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
      'text-align:center', 'gap:14px', 'padding:24px',
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
    ].join(';'));
    overlay.innerHTML =
      '<div style="font-size:38px">🔒</div>' +
      '<div style="font-size:20px;font-weight:800;letter-spacing:-0.3px">Access restricted</div>' +
      '<div style="font-size:13px;color:rgba(255,255,255,0.55);max-width:360px;line-height:1.5">' +
        'This page is limited to administrators.</div>' +
      '<a href="/admin/people" style="margin-top:6px;text-decoration:none;background:#c9a84c;color:#000;' +
        'font-size:12px;font-weight:700;padding:9px 18px;border-radius:8px">Go to my workspace</a>';
    function mount() {
      document.body.appendChild(overlay);
    }
    if (document.body) {
      mount();
    } else {
      document.addEventListener('DOMContentLoaded', mount);
    }
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

    /* STAFF BROWSER MARKER — self-view suppression for /v/<slug>.
     * The CRM runs on admin.ratesandrealty.com; video links open on the apex,
     * where this session's localStorage is unreadable, so the landing page has
     * no way to tell Rene from a borrower. A cookie scoped to the parent domain
     * does cross the subdomain boundary. It carries NO secret and grants
     * nothing — video-track only uses it to decide not to score the view — so a
     * plain flag is the right shape here, not a token. */
    setStaffMarker(true);

    // Logout helper. Capture the client at init time (matches current semantics).
    window.adminLogout = async function () {
      try {
        await client.auth.signOut();
      } catch (err) {
        console.error('[auth-guard] signOut failed:', err);
      }
      setStaffMarker(false);
      window.location.replace('/auth/admin-login.html');
    };

    // ── Role-based page gating ──────────────────────────────────────────────
    // Resolve the user's app role (cached per-session). Admin is always allowed
    // everywhere; any page not listed in PAGE_ACCESS is open to all staff.
    let role = sessionStorage.getItem('rnr_app_role');
    if (!role) {
      try {
        const { data: r } = await client.rpc('current_app_role');
        role = r || 'none';
        sessionStorage.setItem('rnr_app_role', role);
      } catch (err) {
        // Transient failure: never strand the user (especially admins). Allow.
        console.warn('[auth-guard] current_app_role failed, allowing page:', err);
        role = null;
      }
    }

    if (role && role !== 'admin') {
      const PAGE_ACCESS = {
        'settings':           ['admin'],
        'earnings-dashboard': ['admin'],
        'reports':            ['admin'],
        'insights':           ['admin'],
        'emc-import':         ['admin'],
        'referral-partners':  ['admin'],
        'partner-detail':     ['admin'],
        // VA dashboard (post-login landing) + daily-tasks screen: VAs (intended
        // users) + admins (to preview). Both URL forms listed since post-login /
        // view-as land here as .html.
        'va-dashboard':       ['va', 'admin'],
        'va-dashboard.html':  ['va', 'admin'],
        'va-tasks':           ['va', 'admin'],
        'va-tasks.html':      ['va', 'admin'],
        // Gmail inbox surfaces. Admin inbox exposes the mailbox switcher (rene@ +
        // processing@); the VA inbox is processing@ only (also enforced server-side
        // by gmail-inbox, which 403s any mailbox a role may not touch).
        'inbox':              ['admin'],
        'inbox.html':         ['admin'],
        'va-inbox':           ['va', 'admin'],
        'va-inbox.html':      ['va', 'admin'],
        // Staff-to-staff chat: open to all internal staff roles.
        'chat':               ['va', 'admin', 'agent', 'loa'],
        'chat.html':          ['va', 'admin', 'agent', 'loa'],
        // Chat attachment vault: admin only.
        'vault':              ['admin'],
        'vault.html':         ['admin'],
      };
      const filename = window.location.pathname.split('/').pop();
      const allowed = PAGE_ACCESS[filename];
      if (allowed && allowed.indexOf(role) === -1) {
        denyAccess();
        return;
      }
    }

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

    // Mount the staff-to-staff Chat bubble on every staff page. auth-guard runs
    // ONLY on authenticated admin/staff pages (never public/borrower pages), so this
    // is the single place that reliably covers all admin CRM + VA portal pages —
    // most of which don't load components/layout.js. staff-chat.js is role-gated
    // (admin/agent/va/loa) and idempotent (window._staffChatLoaded); skip the
    // <script> if the page already loads it (dashboard/admin + chat.html do).
    function mountStaffChat() {
      if (document.querySelector('script[src*="/admin/js/staff-chat.js"]')) return;
      const sc = document.createElement('script');
      sc.src = '/admin/js/staff-chat.js?v=c1c8cfd043';
      document.head.appendChild(sc);
    }
    // Universal help-video ⓘ buttons (window.HelpTopic). Same app-wide, idempotent
    // pattern — any page with [data-help-topic] gets the ⓘ; admins get inline edit.
    function mountHelpButton() {
      if (document.querySelector('script[src*="/admin/js/help-button.js"]')) return;
      const hb = document.createElement('script');
      hb.src = '/admin/js/help-button.js?v=22c7ad6524';
      document.head.appendChild(hb);
    }
    // Universal task capture (📌 + Ctrl+Shift+K). Same reasoning as the two
    // above: auth-guard is the only script guaranteed on every authenticated
    // staff page, so it is the single place that reliably mounts an app-wide
    // widget. Idempotent via window._taskCaptureLoaded.
    function mountTaskCapture() {
      if (document.querySelector('script[src*="/admin/js/task-capture.js"]')) return;
      const tc = document.createElement('script');
      tc.src = '/admin/js/task-capture.js?v=8f5f287211';
      document.head.appendChild(tc);
    }
    /* One FAB in the bottom-right corner, replacing the two independent floating
     * buttons that staff-chat and task-capture each mount. It does not
     * reimplement either — it hides their buttons and forwards clicks to them,
     * and it only shows an action whose original button is actually in the DOM,
     * so each widget's own role gate still decides. Mounted LAST so both sources
     * are more likely to exist on first render; it re-checks either way. */
    /* One clock, app-wide: window.RRTime renders every business timestamp in
     * America/Los_Angeles with a PT label, and reads zone-less Postgres
     * `timestamp` values as UTC instead of as the viewer's local time. Mounted
     * FIRST of the group and synchronously-ish, because page scripts format
     * timestamps during their initial render. */
    function mountRRTime() {
      if (window.RRTime || document.querySelector('script[src*="/admin/js/rr-time.js"]')) return;
      const rt = document.createElement('script');
      rt.src = '/admin/js/rr-time.js?v=561d9fe9fb';
      document.head.appendChild(rt);
    }
    function mountActionFab() {
      if (document.querySelector('script[src*="/admin/js/action-fab.js"]')) return;
      const af = document.createElement('script');
      af.src = '/admin/js/action-fab.js?v=9771b7a62f';
      document.head.appendChild(af);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { mountRRTime(); mountStaffChat(); mountHelpButton(); mountTaskCapture(); mountActionFab(); });
    } else {
      mountRRTime();
      mountStaffChat();
      mountHelpButton();
      mountTaskCapture();
      mountActionFab();
    }
  })();
})();
