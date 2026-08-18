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
  /* KEYED ON THE ELEMENT, NOT ITS ID.
   *
   * This was `elementId -> true`, and it is only ever cleared in the catch — so
   * on success an id stayed latched for the life of the page. Any input that is
   * DESTROYED AND REBUILT WITH THE SAME ID therefore attached exactly once:
   * the first open bound it, and every open after that hit the latch, returned
   * null, and left the new element as plain text. Silently, because returning
   * null is also what a legitimate re-init does.
   *
   * That is what killed the Loan Snapshot's Property Address popup (#lpSpAddr),
   * which rebuilds its markup on every open. Suggestions appeared once per page
   * load and never again.
   *
   * Clearing on teardown was the alternative and is worse: it needs every caller
   * to remember to call it, and the callers that need it most are the ones
   * assembling innerHTML strings, which have no teardown hook to hang it on. A
   * WeakSet is correct by construction — a rebuilt element is a different object
   * and is simply not in the set — and it cannot leak, because entries vanish
   * with the elements. Re-attaching the SAME element is still a no-op. */
  var _bound = new WeakSet();

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

  /* COUNTY IS `administrative_area_level_2`, and capturing it here is the whole
     point of this function existing in one place.
     Two other copies of this parse used to live in admin/lead-detail.html and
     BOTH captured county; this one, the shared module, was the only one that
     dropped it — and it is the one the Subject Property field uses. So the fee
     sheet fell back to guessing a county from a 3-digit ZIP prefix while Google
     had already told us the answer on the same keystroke.

     A ZIP3 prefix cannot express county (ZIP3 areas straddle county lines) and
     every entry added to that table is another chance to capture a split
     prefix — 935 was added for Lancaster and now resolves California City, which
     is KERN, to Los Angeles. Captured beats inferred, always. */
  function parts(place) {
    var num = '', route = '', city = '', state = '', zip = '', county = '';
    (place.address_components || []).forEach(function (c) {
      var t = c.types;
      if (t.indexOf('street_number') > -1) num = c.long_name;
      if (t.indexOf('route') > -1) route = c.short_name;
      if (t.indexOf('locality') > -1) city = c.long_name;
      if (t.indexOf('sublocality_level_1') > -1 && !city) city = c.long_name;
      if (t.indexOf('administrative_area_level_1') > -1) state = c.short_name;
      if (t.indexOf('postal_code') > -1) zip = c.long_name;
      /* long_name is "Los Angeles County"; short_name is often the same string,
         so the suffix is stripped rather than avoided. Case-insensitive and
         anchored so a place genuinely called "…County" keeps its name. */
      if (t.indexOf('administrative_area_level_2') > -1) county = (c.long_name || '').replace(/\s+County$/i, '');
    });
    return {
      street: num + (route ? ' ' + route : ''),
      city: city, state: state, zip: zip, county: county,
      /* A property address needs a house number and a ZIP. A city-level pick
         ("Santa Clarita, CA, USA") resolves fine and has neither — it is a real
         place, just not a property, and the fee sheet cannot price it. */
      isProperty: !!(num && zip),
    };
  }

  /* ── THE EARLY RETURN THAT ATE THE ZIP ────────────────────────────────────
   * This used to be `if (!place.address_components) return;` — in BOTH copies.
   * That reads as harmless and is not, because by the time place_changed fires
   * Google has ALREADY written the prediction's description into the input:
   *
   *     "43636 Devyn Ln, Lancaster, CA, USA"     <- description. No ZIP.
   *     "43636 Devyn Ln, Lancaster, CA 93534"    <- formatted_address. Has one.
   *
   * Returning leaves the description sitting in the box, and the autosave then
   * persists it as though it were a resolved address. Measured across the 48
   * stored property addresses: all 18 that came from autocomplete-without-
   * details are ZIP-less, and all 12 that did resolve carry a ZIP. There is no
   * row in between. The ZIP was never dropped — it was never fetched.
   *
   * So: ask for the details explicitly instead of giving up. If that also fails
   * the value is reported UNRESOLVED to the caller rather than silently kept. */
  function resolve(ac, input, cb) {
    var place = ac.getPlace();
    if (place && place.address_components) return cb(place, null);

    var id = place && (place.place_id || place.placeId);
    if (!id) return cb(null, 'no suggestion was selected');

    try {
      var svc = new w.google.maps.places.PlacesService(document.createElement('div'));
      svc.getDetails({ placeId: id, fields: ['address_components', 'formatted_address'] }, function (res, status) {
        if (status === w.google.maps.places.PlacesServiceStatus.OK && res && res.address_components) return cb(res, null);
        cb(null, 'Google returned no details for that suggestion (' + status + ')');
      });
    } catch (e) {
      cb(null, 'details lookup failed: ' + (e && e.message));
    }
  }

  /* An unresolved value must be VISIBLE, not just absent from a callback. The
     input is stamped so persistence paths can refuse it, and the reason is shown
     next to the field — a silent failure here is what put a city name in a
     borrower's property field and a guessed county on their loan estimate. */
  function markResolution(el, ok, why) {
    if (!el) return;
    el.dataset.rrAddrResolved = ok ? '1' : '0';
    var noteId = (el.id || 'rr') + '__addrNote';
    var note = document.getElementById(noteId);
    if (ok) { if (note) note.remove(); el.style.borderColor = ''; return; }
    if (!note) {
      note = document.createElement('div');
      note.id = noteId;
      note.style.cssText = 'font-size:11px;line-height:1.35;color:#e0a03a;margin-top:4px;';
      if (el.parentNode) el.parentNode.insertBefore(note, el.nextSibling);
    }
    note.textContent = '⚠ Address not confirmed — ' + why + '. Pick a suggestion from the list, or type the full address including ZIP.';
    el.style.borderColor = '#e0a03a';
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

  /* SPLIT: street/city/state/zip across four inputs, plus opts.countyId for a
     fifth. County is opt-in by id rather than a positional argument so the two
     existing 4-argument callers keep working unchanged.
     opts.onFill runs after a selection (the portal uses it for updateAppProgress). */
  function attachSplit(streetId, cityId, stateId, zipId, opts) {
    opts = opts || {};
    var input = document.getElementById(streetId);
    if (!input || _bound.has(input)) return null;
    _bound.add(input);
    return load().then(function () {
      styleOnce();
      var ac = autocompleteOn(input, ['address_components', 'formatted_address', 'place_id']);
      ac.addListener('place_changed', function () {
        resolve(ac, input, function (place, why) {
          if (!place) {
            markResolution(input, false, why);
            if (typeof opts.onUnresolved === 'function') { try { opts.onUnresolved(why, input); } catch (_) {} }
            return;
          }
          var p = parts(place);
          markResolution(input, p.isProperty, 'that suggestion is a place, not a property address');
          input.value = p.street; flash(input); notify(input);
          var set = function (id, val) {
            var el = id && document.getElementById(id);
            if (el && val) { el.value = val; flash(el); notify(el); }
          };
          set(cityId, p.city); set(stateId, p.state); set(zipId, p.zip);
          set(opts.countyId, p.county);
          if (typeof opts.onFill === 'function') { try { opts.onFill(p); } catch (_) {} }
        });
      });
      return ac;
    }).catch(function (e) {
      /* No key, or Places blocked. The input stays an ordinary text box and
         typing a full address by hand still works — autocomplete assists, it
         never gates. Logged rather than silent so a dead key is findable. */
      _bound.delete(input);
      console.warn('[places] ' + streetId + ' stays plain text:', e.message);
      return null;
    });
  }

  /* COMBINED: one input holding the whole address, e.g. lead-detail's Subject
     Property field. Uses formatted_address rather than reassembling the parts. */
  function attachCombined(inputId, opts) {
    opts = opts || {};
    var input = document.getElementById(inputId);
    if (!input || _bound.has(input)) return null;
    _bound.add(input);
    return load().then(function () {
      styleOnce();
      var ac = autocompleteOn(input, ['address_components', 'formatted_address', 'place_id']);
      ac.addListener('place_changed', function () {
        resolve(ac, input, function (place, why) {
          if (!place) {
            /* The description Google auto-filled is still in the box. It is left
               there — deleting what somebody just picked is worse — but it is
               STAMPED unresolved and the reason is on screen, so the autosave can
               refuse it instead of storing a city name as a property address. */
            markResolution(input, false, why);
            if (typeof opts.onUnresolved === 'function') { try { opts.onUnresolved(why, input); } catch (_) {} }
            return;
          }
          var p = parts(place);
          var val = place.formatted_address
            || [p.street, p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
          if (!val) { markResolution(input, false, 'Google returned an empty address'); return; }
          // Google appends ", USA" to US formatted_address; the loan file does not want it.
          input.value = val.replace(/,\s*USA$/, '');
          flash(input); notify(input);
          markResolution(input, p.isProperty, 'that suggestion is a place, not a property address');
          if (typeof opts.onFill === 'function') { try { opts.onFill(input.value, place, p); } catch (_) {} }
        });
      });
      return ac;
    }).catch(function (e) {
      _bound.delete(input);
      console.warn('[places] ' + inputId + ' stays plain text:', e.message);
      return null;
    });
  }

  /* `parts` and `isResolved` are exported so the callers that used to carry
     their own copy of this parse can delegate instead of drifting. That is the
     entire premise of this file; two of the three copies already disagreed about
     whether county was worth capturing. */
  w.RRPlaces = {
    load: load, attachSplit: attachSplit, attachCombined: attachCombined,
    parts: parts,
    isResolved: function (el) { return !!(el && el.dataset && el.dataset.rrAddrResolved === '1'); },
    hasKey: function () { return !!key(); },
  };
})(window);
