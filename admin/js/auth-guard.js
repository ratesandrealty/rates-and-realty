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

  /* Drop the cached role and the uid it belongs to.
   *
   * Called on sign-out AND on every no-session redirect. Both matter: the role
   * lives in sessionStorage, which outlives a Supabase sign-out and is shared by
   * whoever signs in next IN THAT TAB. Leaving it behind is the same defect the
   * uid keying fixes, arriving by a different route — an admin signs out, a VA
   * signs in, and the tab still says 'admin'.
   *
   * Deliberately NOT sessionStorage.clear(): other keys in this tab belong to
   * pages, not to the guard, and clearing them would be a side effect nobody
   * asked this function for. */
  function clearCachedRole() {
    try {
      sessionStorage.removeItem('rnr_app_role');
      sessionStorage.removeItem('rnr_app_role_uid');
    } catch (_) {}
  }

  function redirectToLogin() {
    clearCachedRole();
    const path = window.location.pathname;
    const search = window.location.search || '';
    window.location.replace('/auth/admin-login.html?redirect=' + encodeURIComponent(path + search));
  }

  // Full-screen overlay shown when a non-admin hits an admin-only page.
  /* GATE PROMISE. Page gating is async — it awaits current_app_role() — so a
     page that renders as soon as the client appears paints its content BEFORE
     denyAccess() can run, and the overlay then merely covers it. Found by
     render-check on va-people: the row data was in the DOM under the lock
     screen. Any page rendering role-sensitive content should await
     window._rrGateReady first. The server remains the real control. */
  let _gateDone;
  window._rrGateReady = new Promise(function (r) { _gateDone = r; });
  function _settleGate() { window._rrGateSettled = true; if (_gateDone) _gateDone(); }

  function denyAccess() {
    /* SIGNAL THE DENIAL, don't just cover the page.
     *
     * The overlay is position:fixed over whatever already rendered — it hides
     * content visually and leaves it in the DOM, readable via devtools, the
     * accessibility tree, or select-all. Found by render-check: a denied page
     * still had the row data underneath the overlay.
     *
     * The real control is always server-side (RLS, or the RPC returning nothing
     * for that role), and that has not changed. This flag lets a page ALSO
     * decline to render, so a future page whose server-side scoping is wrong
     * does not leak through a cosmetic cover. Set BEFORE the overlay mounts so
     * a page checking it synchronously sees it. */
    window._rrAccessDenied = true;
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
      /* BEFORE navigating, and unconditionally — even when signOut threw. A
         failed signOut is exactly when a stale role must not survive: the next
         person to sign in this tab would inherit it. */
      clearCachedRole();
      window.location.replace('/auth/admin-login.html');
    };

    // ── Role-based page gating ──────────────────────────────────────────────
    // Resolve the user's app role (cached per-session). Admin is always allowed
    // everywhere; any page not listed in PAGE_ACCESS is open to all staff.
    //
    /* THE CACHE IS KEYED ON THE USER IT WAS FETCHED FOR.
     *
     * It used to be `sessionStorage.getItem('rnr_app_role')` refetched only when
     * ABSENT — never invalidated when the user changed. sessionStorage survives
     * same-tab navigation and a Supabase sign-in does not clear it, so signing
     * in as somebody else IN THE SAME TAB left the previous user's role sitting
     * over the new session.
     *
     * The path that produced it: "View as" in settings mints a real magic-link
     * session for the target user, and the modal only SUGGESTS incognito. Opened
     * in the same tab, an admin became a VA on the server while the tab still
     * said 'admin' — so _ldNonAdmin() was false, lead-detail rendered admin
     * affordances, and _smsDest() sent a real phone number where a VA session
     * must send null and let the server resolve it from contact_id.
     *
     * Keyed on the uid, a user change invalidates it on the very next guarded
     * page load, with no timer involved. A TTL would have been wrong for however
     * long it lasted — the window where the answer is stale is exactly the
     * window where it matters.
     *
     * A MISSING uid key is treated as a MISS, not as a hit. That covers the role
     * cached by an older build of this file and the one admin-login writes, and
     * it fails in the safe direction: one extra RPC, never a stale role. */
    const ROLE_KEY = 'rnr_app_role';
    const ROLE_UID_KEY = 'rnr_app_role_uid';
    const uid = (session.user && session.user.id) || '';

    let role = null;
    try {
      if (uid && sessionStorage.getItem(ROLE_UID_KEY) === uid) {
        role = sessionStorage.getItem(ROLE_KEY);
      } else {
        // Different user (or unknown provenance) — the cached role is not about
        // this session. Drop it before anything downstream can read it.
        sessionStorage.removeItem(ROLE_KEY);
        sessionStorage.removeItem(ROLE_UID_KEY);
      }
    } catch (err) {
      role = null;
    }

    if (!role) {
      try {
        const { data: r } = await client.rpc('current_app_role');
        role = r || 'none';
        try {
          sessionStorage.setItem(ROLE_KEY, role);
          sessionStorage.setItem(ROLE_UID_KEY, uid);
        } catch (_) {}
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
        // "Shared with me" — the VA's caseload, from va_shared_leads(). Listed
        // so a role that is not va/admin is denied at the page, not just served
        // an empty list by RLS. Both URL forms, as above.
        'va-people':          ['va', 'admin'],
        'va-people.html':     ['va', 'admin'],
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
        _settleGate();
        return;
      }
      _settleGate();   // allowed: release any page waiting on the gate
    }
    /* Admins skip the block above entirely, and so does a null role after a
       transient current_app_role() failure. Settle here too, or a page awaiting
       the gate would hang forever for exactly the users most likely to notice. */
    _settleGate();

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
      sc.src = '/admin/js/staff-chat.js?v=2a8cfafc29';
      document.head.appendChild(sc);
    }
    // Universal help-video ⓘ buttons (window.HelpTopic). Same app-wide, idempotent
    // pattern — any page with [data-help-topic] gets the ⓘ; admins get inline edit.
    function mountHelpButton() {
      if (document.querySelector('script[src*="/admin/js/help-button.js"]')) return;
      const hb = document.createElement('script');
      hb.src = '/admin/js/help-button.js?v=d508339ecc';
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
    /* fn-call.js — the ONE way to call an edge function as the signed-in user.
     *
     * This is mounted app-wide because auth-guard mounts things that NEED it.
     * dialer.js is on all 34 pages; fn-call.js was declared on 3. So the FAB
     * dial pad rendered everywhere and could authenticate nowhere else: the
     * calling-hours precheck died with "window.fnFetch is not a function" and,
     * correctly, refused the call.
     *
     * The rule this encodes: anything auth-guard mounts app-wide can only depend
     * on things auth-guard also guarantees. A widget on 34 pages whose helper is
     * on 3 is broken on 31 of them, and it fails at click time rather than load
     * time, so nothing notices until someone tries to use it.
     *
     * Idempotent twice over — the script-src check below, and fn-call.js's own
     * guard — so the three pages that declare it themselves do not double-load.
     * Mounted FIRST of the group for load-order sanity; nothing here needs
     * fnFetch until a user interacts, by which point both have executed. */
    function mountFnCall() {
      if (window.fnFetch || document.querySelector('script[src*="/admin/js/fn-call.js"]')) return;
      const fc = document.createElement('script');
      fc.src = '/admin/js/fn-call.js?v=85d03d2a98';
      document.head.appendChild(fc);
    }
    /* attachment-viewer.js — mounted app-wide, EAGERLY, not lazily.
     *
     * staff-chat.js is on all 34 pages and guards its use of the viewer with
     *     if (!window.AttachmentViewer) { scToast('Viewer still loading, try
     *     again in a moment'); return; }
     * The file was declared on 5 pages. On the other 29 that message is false —
     * it is not still loading and it never will, so a staff-chat attachment was
     * permanently unopenable behind a note implying patience would fix it. A
     * misleading transience message is worse than an error, because it stops
     * anyone reporting the bug.
     *
     * EAGER rather than lazy like the Twilio SDK, and the difference is
     * deliberate. The SDK is ~90 KB and only ever needed after a deliberate
     * "call" click, so the wait is attributable and the user is already
     * committed. This is ~10 KB and is needed the instant someone clicks an
     * attachment they can already see — making them wait for a fetch at that
     * moment is exactly the "still loading" experience the message was lying
     * about. 10 KB on a page that already loads staff-chat at 91 KB is not the
     * thing to optimise. */
    function mountAttachmentViewer() {
      if (window.AttachmentViewer || document.querySelector('script[src*="/admin/js/attachment-viewer.js"]')) return;
      const av = document.createElement('script');
      av.src = '/admin/js/attachment-viewer.js?v=e8f2b14c9f';
      document.head.appendChild(av);
    }
    /* One clock, app-wide: window.RRTime renders every business timestamp in
     * America/Los_Angeles with a PT label, and reads zone-less Postgres
     * `timestamp` values as UTC instead of as the viewer's local time. Mounted
     * FIRST of the group and synchronously-ish, because page scripts format
     * timestamps during their initial render. */
    function mountRRTime() {
      if (window.RRTime || document.querySelector('script[src*="/admin/js/rr-time.js"]')) return;
      const rt = document.createElement('script');
      rt.src = '/admin/js/rr-time.js?v=7306de6cb2';
      document.head.appendChild(rt);
    }
    /* One phone helper, app-wide, for the same reason as RRTime: four separate
     * per-page formatters had already drifted, and — the part that mattered —
     * nothing anywhere checked whether the value it was about to dial was a
     * mask. window.RRPhone.dialable() is now the single place that decides.
     * Mounted alongside RRTime and BEFORE the dialer, because dialer.js asks it
     * on the first Call. */
    function mountRRPhone() {
      if (window.RRPhone || document.querySelector('script[src*="/admin/js/rr-phone.js"]')) return;
      const rp = document.createElement('script');
      rp.src = '/admin/js/rr-phone.js?v=044d32fd52';
      document.head.appendChild(rp);
    }
    /* The dialer — modal + Twilio.Device — app-wide, so the FAB's Call row has
     * something to open. It mounts a hidden #rr-dial-fab trigger that the FAB
     * gates on, and lazy-loads the Twilio SDK only when someone actually dials. */
    function mountDialer() {
      if (window._rrDialerLoaded || document.querySelector('script[src*="/admin/js/dialer.js"]')) return;
      const dl = document.createElement('script');
      dl.src = '/admin/js/dialer.js?v=cf4b1032f5';
      document.head.appendChild(dl);
    }
    function mountActionFab() {
      if (document.querySelector('script[src*="/admin/js/action-fab.js"]')) return;
      const af = document.createElement('script');
      af.src = '/admin/js/action-fab.js?v=2d1b99b251';
      document.head.appendChild(af);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { mountFnCall(); mountAttachmentViewer(); mountRRTime(); mountRRPhone(); mountStaffChat(); mountHelpButton(); mountTaskCapture(); mountDialer(); mountActionFab(); });
    } else {
      mountFnCall();
      mountAttachmentViewer();
      mountRRTime();
      mountRRPhone();
      mountStaffChat();
      mountHelpButton();
      mountTaskCapture();
      mountDialer();
      mountActionFab();
    }
  })();
})();
