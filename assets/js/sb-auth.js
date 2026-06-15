/*
 * sb-auth.js — Dashboard authentication layer.
 * The admin dashboard historically used the anon key, so RLS-locked tables
 * (contacts, uploaded_documents, closed_deals, …) returned empty. This:
 *   1. Uses the existing supabase-js session (same one admin/lead-detail.html uses,
 *      persisted under sb-<ref>-auth-token and auto-refreshed).
 *   2. Rewrites the Authorization header on every Supabase REST + Storage request
 *      to carry the logged-in user's JWT instead of the anon key.
 * Load order: AFTER /api/env.js (needs APP_CONFIG) and AFTER supabase-js.
 * /auth/v1/ and /functions/v1/ calls are left untouched.
 */
(function () {
  var SB_HOST = 'ljywhvbmsibwnssxpesh.supabase.co';
  function cfg() { return window.APP_CONFIG || {}; }
  function anon() { return cfg().SUPABASE_ANON_KEY || ''; }

  var _client = null;
  function client() {
    if (_client) return _client;
    if (window.supabase && window.supabase.createClient && cfg().SUPABASE_URL && anon()) {
      _client = window.supabase.createClient(cfg().SUPABASE_URL, anon(), {
        auth: { persistSession: true, autoRefreshToken: true }
      });
      if (!window._supabaseClient) window._supabaseClient = _client;
    }
    return _client;
  }
  if (typeof window.getSupabaseClient !== 'function') {
    window.getSupabaseClient = function () { return Promise.resolve(client()); };
  }

  function token() {
    var c = client();
    if (!c) return Promise.resolve(null);
    return c.auth.getSession()
      .then(function (s) { return (s && s.data && s.data.session) ? s.data.session.access_token : null; })
      .catch(function () { return null; });
  }

  var _origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : ((input && input.url) || '');
    var isSupabaseData =
      url.indexOf(SB_HOST) !== -1 &&
      (url.indexOf('/rest/v1/') !== -1 || url.indexOf('/storage/v1/') !== -1);
    if (!isSupabaseData) return _origFetch(input, init);
    return token().then(function (t) {
      if (!t) return _origFetch(input, init);
      var base = (init && init.headers) || (typeof input !== 'string' && input.headers) || {};
      var h = new Headers(base);
      h.set('apikey', anon());
      h.set('Authorization', 'Bearer ' + t);
      if (typeof input === 'string') { init = init || {}; init.headers = h; return _origFetch(input, init); }
      return _origFetch(new Request(input, { headers: h }), init);
    });
  };

  window.rnrAuthHeaders = function () {
    return token().then(function (t) { return { apikey: anon(), Authorization: 'Bearer ' + (t || anon()) }; });
  };
})();
