/* places-autocomplete.js — ONE Google Places address autocomplete for the whole app.
 *
 * WHY THIS FILE EXISTS
 * The behaviour below already worked, in public/unified-portal.html, and nowhere
 * else knew. lead-detail.html carried a comment saying the Places key had been
 * "retired" — it had not — and that false comment cost a full investigation down
 * the server-side path before anyone checked the portal. So this is deliberately
 * a shared module rather than a second copy: two copies drift, and a drifted copy
 * is how the wrong one becomes the one people read.
 *
 * TWO KEYS, AND ONLY ONE OF THEM IS ALIVE — do not confuse them:
 *   GOOGLE_MAPS_API_KEY      Worker env -> /api/env.js -> window.APP_CONFIG.
 *                            REFERRER-RESTRICTED, so it works ONLY from a page.
 *                            This is what this file uses, and it is live.
 *   GOOGLE_PLACES_SERVER_KEY Supabase secret behind the address-autocomplete
 *                            edge function, which has zero callers. A referrer-
 *                            restricted key cannot be used server-side at all —
 *                            Google answers REQUEST_DENIED, "API keys with
 *                            referer restrictions cannot be used with this API."
 * If you ever want the server path, it needs its own unrestricted key. It is not
 * a drop-in for this.
 *
 * The Maps JS widget paces its own network calls and manages session tokens, so
 * there is no per-keystroke cost here to debounce. That question only applies to
 * the REST endpoint.
 */
(function (w) {
  'use strict';

  var _loading = null;
  var _bound = Object.create(null);   // elementId -> true, so re-init is a no-op

  function key() {
    var cfg = w.APP_CONFIG || {};
    return cfg.GOOGLE_MAPS_API_KEY || cfg.GOOGLE_PLACES_API_KEY || '';
  }

  function ready() {
    return !!(w.google && w.google.maps && w.google.maps.places);
  }

  /* ON DEMAND. The Maps JS bundle is not small and most page opens never touch an
     address field, so it is fetched when a field is actually attached — the same
     shape as people.html's _apmLoadPlaces(), which this replaces. */
  function load() {
    if (ready()) return Promise.resolve();
    if (_loading) return _loading;

    /* SOMEONE ELSE MAY ALREADY BE LOADING IT. lead-detail.html pulls the Maps JS
       bundle for its own map work, and appending a second <script> makes Google
       log "You have included the Google Maps JavaScript API multiple times on
       this page" — caught by render-check, which is why this exists. Adopt the
       in-flight tag and poll for readiness instead of racing it. */
    var existing = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
    if (existing) {
      _loading = new Promise(function (resolve, reject) {
        var waited = 0;
        (function poll() {
          if (ready()) return resolve();
          waited += 100;
          if (waited > 15000) { _loading = null; return reject(new Error('Maps JS already on the page but never became ready')); }
          setTimeout(poll, 100);
        })();
      });
      return _loading;
    }

    var k = key();
    if (!k) return Promise.reject(new Error('no Google Maps key in APP_CONFIG'));
    _loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(k) + '&libraries=places';
      s.async = true; s.defer = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { _loading = null; reject(new Error('Places failed to load')); };
      document.head.appendChild(s);
    });
    return _loading;
  }

  /* The dropdown is Google's own element appended to <body>, so it inherits none
     of the page styling. Injected once. */
  function styleOnce() {
    if (document.getElementById('rrPlacesStyle')) return;
    var st = document.createElement('style');
    st.id = 'rrPlacesStyle';
    st.textContent =
      '.pac-container{background:#1a1a1a!important;border:1px solid rgba(201,168,76,.33)!important;' +
      'border-radius:0 0 10px 10px!important;box-shadow:0 10px 26px rgba(0,0,0,.55)!important;' +
      'font-family:inherit!important;z-index:100000!important}' +
      '.pac-item{color:#c9c3b4!important;border-top:1px solid rgba(255,255,255,.06)!important;padding:7px 11px!important;cursor:pointer}' +
      '.pac-item:first-child{border-top:none!important}' +
      '.pac-item:hover,.pac-item-selected{background:rgba(201,168,76,.12)!important}' +
      '.pac-item-query{color:#e0ddd4!important}' +
      '.pac-matched{color:#C9A84C!important}' +
      '.pac-icon{display:none!important}' +
      '.pac-logo:after{filter:invert(1) opacity(.35)}';
    document.head.appendChild(st);
  }

  function flash(el) {
    if (!el) return;
    var bc = el.style.borderColor, bg = el.style.background;
    el.style.borderColor = '#C9A84C';
    el.style.background = 'rgba(201,168,76,.05)';
    setTimeout(function () { el.style.borderColor = bc; el.style.background = bg; }, 1200);
  }

  function parts(place) {
    var num = '', route = '', city = '', state = '', zip = '';
    (place.address_components || []).forEach(function (c) {
      var t = c.types;
      if (t.indexOf('street_number') > -1) num = c.long_name;
      if (t.indexOf('route') > -1) route = c.short_name;
      if (t.indexOf('locality') > -1) city = c.long_name;
      if (t.indexOf('sublocality_level_1') > -1 && !city) city = c.long_name;
      if (t.indexOf('administrative_area_level_1') > -1) state = c.short_name;
      if (t.indexOf('postal_code') > -1) zip = c.long_name;
    });
    return { street: num + (route ? ' ' + route : ''), city: city, state: state, zip: zip };
  }

  /* Fire the events a framework or an autosave handler would expect from typing.
     lead-detail autosaves address fields on change, and a value set purely in JS
     would otherwise never persist — the field would look filled and save nothing. */
  function notify(el) {
    if (!el) return;
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) { /* older browsers: the value is still set */ }
  }

  function autocompleteOn(input, fields) {
    return new w.google.maps.places.Autocomplete(input, {
      types: ['address'],
      componentRestrictions: { country: 'us' },
      fields: fields,
    });
  }

  /* SPLIT: street/city/state/zip across four inputs.
     opts.onFill runs after a selection (the portal uses it for updateAppProgress). */
  function attachSplit(streetId, cityId, stateId, zipId, opts) {
    opts = opts || {};
    var input = document.getElementById(streetId);
    if (!input || _bound[streetId]) return null;
    _bound[streetId] = true;
    return load().then(function () {
      styleOnce();
      var ac = autocompleteOn(input, ['address_components', 'formatted_address']);
      ac.addListener('place_changed', function () {
        var place = ac.getPlace();
        if (!place || !place.address_components) return;   // free text, left alone
        var p = parts(place);
        input.value = p.street; flash(input); notify(input);
        var set = function (id, val) {
          var el = id && document.getElementById(id);
          if (el && val) { el.value = val; flash(el); notify(el); }
        };
        set(cityId, p.city); set(stateId, p.state); set(zipId, p.zip);
        if (typeof opts.onFill === 'function') { try { opts.onFill(p); } catch (_) {} }
      });
      return ac;
    }).catch(function (e) {
      /* No key, or Places blocked. The input stays an ordinary text box and
         typing a full address by hand still works — autocomplete assists, it
         never gates. Logged rather than silent so a dead key is findable. */
      _bound[streetId] = false;
      console.warn('[places] ' + streetId + ' stays plain text:', e.message);
      return null;
    });
  }

  /* COMBINED: one input holding the whole address, e.g. lead-detail's Subject
     Property field. Uses formatted_address rather than reassembling the parts. */
  function attachCombined(inputId, opts) {
    opts = opts || {};
    var input = document.getElementById(inputId);
    if (!input || _bound[inputId]) return null;
    _bound[inputId] = true;
    return load().then(function () {
      styleOnce();
      var ac = autocompleteOn(input, ['address_components', 'formatted_address']);
      ac.addListener('place_changed', function () {
        var place = ac.getPlace();
        if (!place) return;
        var val = place.formatted_address || '';
        if (!val && place.address_components) {
          var p = parts(place);
          val = [p.street, p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
        }
        if (!val) return;
        // Google appends ", USA" to US formatted_address; the loan file does not want it.
        input.value = val.replace(/,\s*USA$/, '');
        flash(input); notify(input);
        if (typeof opts.onFill === 'function') { try { opts.onFill(input.value, place); } catch (_) {} }
      });
      return ac;
    }).catch(function (e) {
      _bound[inputId] = false;
      console.warn('[places] ' + inputId + ' stays plain text:', e.message);
      return null;
    });
  }

  w.RRPlaces = { load: load, attachSplit: attachSplit, attachCombined: attachCombined, hasKey: function () { return !!key(); } };
})(window);
