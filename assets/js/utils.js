/**
 * utils.js — shared client-side helpers loaded across admin pages.
 *
 * pinGoogleUrl(url):
 *   Append ?authuser=<email> to any Google URL so Chrome skips the
 *   "Choose an account" picker when multiple Google accounts are signed in.
 *
 * The account email is loaded once per session from the `app_config` row
 * `google_drive_account_email` and cached in localStorage. A hardcoded
 * fallback is used until the fetch resolves (or if it fails).
 */
(function () {
  var FALLBACK_EMAIL = 'rene@ratesandrealty.com';
  var CACHE_KEY = 'rr_google_account_email';

  // Seed window with the cached value (or fallback) immediately so
  // pinGoogleUrl works synchronously on first call.
  var cached = null;
  try { cached = localStorage.getItem(CACHE_KEY); } catch (_) {}
  window.RR_GOOGLE_ACCOUNT_EMAIL = window.RR_GOOGLE_ACCOUNT_EMAIL || cached || FALLBACK_EMAIL;

  function pinGoogleUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.indexOf('google.com') === -1 && url.indexOf('docs.google.com') === -1) return url;
    var email = window.RR_GOOGLE_ACCOUNT_EMAIL;
    if (!email) return url;
    var hashIdx = url.indexOf('#');
    var hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
    var base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
    // Strip any existing authuser param to avoid duplicates.
    var cleaned = base
      .replace(/([?&])authuser=[^&]*&?/g, '$1')
      .replace(/[?&]$/, '');
    var sep = cleaned.indexOf('?') >= 0 ? '&' : '?';
    return cleaned + sep + 'authuser=' + encodeURIComponent(email) + hash;
  }

  window.pinGoogleUrl = pinGoogleUrl;

  // Refresh the email from app_config in the background. If we already had a
  // cached value the fallback/cache wins for this page load; the fresh value
  // takes effect on the next navigation.
  (function loadGoogleAccountEmail() {
    if (cached) return; // already have it
    try {
      var cfg = window.APP_CONFIG || {};
      var SUPABASE_URL = cfg.SUPABASE_URL || 'https://ljywhvbmsibwnssxpesh.supabase.co';
      var ANON_KEY = cfg.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxqeXdodmJtc2lid25zc3hwZXNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNjE2NTUsImV4cCI6MjA4OTYzNzY1NX0.QaewUhTWdATj35VewvmfQcHB_b3I9FhhwXSRuqNBKvw';
      fetch(SUPABASE_URL + '/rest/v1/app_config?key=eq.google_drive_account_email&select=value', {
        headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY }
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var raw = data && data[0] && data[0].value;
          // value column stores JSON-encoded strings, e.g. "\"rene@ratesandrealty.com\""
          var email = typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : raw;
          if (email) {
            window.RR_GOOGLE_ACCOUNT_EMAIL = email;
            try { localStorage.setItem(CACHE_KEY, email); } catch (_) {}
          }
        })
        .catch(function (e) {
          console.warn('Could not load Google account email from config; using fallback', e);
        });
    } catch (e) {
      console.warn('pinGoogleUrl bootstrap failed', e);
    }
  })();
})();
