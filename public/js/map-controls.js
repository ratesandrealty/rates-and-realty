/**
 * Google Maps JS API loader + shared map helpers.
 *
 * Exposes:
 *   window.loadGoogleMaps()        — promise resolving when the Maps JS is ready
 *   window.DARK_MAP_STYLE          — style array approximating the old Mapbox dark theme
 *   window.makePricePinIcon(text)  — google.maps.Icon for a gold price pill
 *   window.addAllMapControls(map)  — adds satellite / street-view / locate-me overlay buttons
 *
 * The API key is fetched from the Cloudflare worker's /config endpoint so it
 * never lives in git.
 */
(function(){
  var _loadPromise = null;

  window.loadGoogleMaps = function() {
    if (window.google && window.google.maps) return Promise.resolve(window.google.maps);
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async function() {
      var res = await fetch('/config');
      if (!res.ok) throw new Error('Failed to load /config');
      var cfg = await res.json();
      var key = cfg.googleMapsApiKey;
      if (!key) throw new Error('googleMapsApiKey missing from /config');
      await new Promise(function(resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&libraries=places&v=weekly';
        s.async = true;
        s.defer = true;
        s.onload = resolve;
        s.onerror = function() { reject(new Error('Google Maps script failed to load')); };
        document.head.appendChild(s);
      });
      return window.google.maps;
    })();
    return _loadPromise;
  };

  // Dark basemap styles — gold-tinted dark theme for the main UI.
  window.DARK_MAP_STYLE = [
    { elementType: 'geometry', stylers: [{ color: '#1d1d1d' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#1d1d1d' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#8a8a8a' }] },
    { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#b0b0b0' }] },
    { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#6b6b6b' }] },
    { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1f2a1f' }] },
    { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#4d6b4d' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a2a2a' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#151515' }] },
    { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#9a9a9a' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3a3a3a' }] },
    { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#1a1a1a' }] },
    { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#c9a84c' }] },
    { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#2a2a2a' }] },
    { featureType: 'transit.station', elementType: 'labels.text.fill', stylers: [{ color: '#8a8a8a' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0d1a24' }] },
    { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4d6f85' }] }
  ];

  // SVG gold price pill used as a google.maps.Marker icon.
  window.makePricePinIcon = function(text, highlighted) {
    var label = String(text || '');
    var w = Math.max(46, label.length * 8 + 18);
    var h = 24;
    var fill = highlighted ? '#ffffff' : '#C9A84C';
    var fg = highlighted ? '#C9A84C' : '#1A0E00';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">'
      + '<rect x="1" y="1" width="' + (w - 2) + '" height="' + (h - 2) + '" rx="12" ry="12" fill="' + fill + '" stroke="#ffffff" stroke-width="2"/>'
      + '<text x="' + (w / 2) + '" y="16" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="' + fg + '">' + label + '</text>'
      + '</svg>';
    return {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      anchor: new google.maps.Point(w / 2, h / 2),
      scaledSize: new google.maps.Size(w, h)
    };
  };

  // Subject-property pill (slightly larger, non-interactive styling).
  window.makeSubjectPinIcon = function(text) {
    var label = String(text || '\u2022');
    var w = Math.max(52, label.length * 9 + 20);
    var h = 28;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">'
      + '<rect x="1" y="1" width="' + (w - 2) + '" height="' + (h - 2) + '" rx="14" ry="14" fill="#C9A84C" stroke="#ffffff" stroke-width="2"/>'
      + '<text x="' + (w / 2) + '" y="19" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="#111">' + label + '</text>'
      + '</svg>';
    return {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      anchor: new google.maps.Point(w / 2, h),
      scaledSize: new google.maps.Size(w, h)
    };
  };

  var BTN_CSS = 'width:34px;height:34px;border:none;border-radius:6px;background:#1a1a1a;color:#fff;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.4);font-family:system-ui,sans-serif;padding:0;line-height:1;';

  function makeBtn(title, label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.style.cssText = BTN_CSS;
    b.innerHTML = label;
    return b;
  }

  function addSatelliteToggle(map, container) {
    var btn = makeBtn('Toggle satellite view', '\uD83D\uDEF0\uFE0F');
    var isSatellite = false;
    btn.addEventListener('click', function() {
      isSatellite = !isSatellite;
      map.setMapTypeId(isSatellite ? 'hybrid' : 'roadmap');
      map.setOptions({ styles: isSatellite ? [] : (window.DARK_MAP_STYLE || []) });
      btn.innerHTML = isSatellite ? '\uD83D\uDDFA\uFE0F' : '\uD83D\uDEF0\uFE0F';
      btn.title = isSatellite ? 'Switch to street view' : 'Switch to satellite';
    });
    container.appendChild(btn);
  }

  function addStreetViewBtn(map, container) {
    var btn = makeBtn('Street View', '\uD83D\uDEB6');
    btn.addEventListener('click', function() {
      var c = map.getCenter();
      var lat = c.lat().toFixed(6);
      var lng = c.lng().toFixed(6);
      var url = 'https://www.google.com/maps?q=' + lat + ',' + lng + '&layer=c&cbll=' + lat + ',' + lng;
      window.open(url, '_blank', 'noopener,noreferrer');
    });
    container.appendChild(btn);
  }

  function ensurePulseKeyframes() {
    if (document.getElementById('mapCtrlPulseStyle')) return;
    var s = document.createElement('style');
    s.id = 'mapCtrlPulseStyle';
    s.textContent = '@keyframes mapCtrlPulse{0%{box-shadow:0 0 0 0 rgba(66,133,244,0.55)}70%{box-shadow:0 0 0 16px rgba(66,133,244,0)}100%{box-shadow:0 0 0 0 rgba(66,133,244,0)}}';
    document.head.appendChild(s);
  }

  function mount(map) {
    if (map._crmControlsMounted) return;
    map._crmControlsMounted = true;
    var container = document.createElement('div');
    container.className = 'crm-map-controls';
    container.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin:10px;';
    addSatelliteToggle(map, container);
    addStreetViewBtn(map, container);
    map.controls[google.maps.ControlPosition.LEFT_TOP].push(container);
  }

  window.addAllMapControls = function(map) {
    if (!map) return;
    if (window.google && window.google.maps) { mount(map); return; }
    window.loadGoogleMaps().then(function(){ mount(map); });
  };

  // ── TOAST ─────────────────────────────────────────────────────────
  function showMapToast(msg) {
    var t = document.getElementById('gmToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'gmToast';
      t.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#C9A84C;padding:10px 18px;border-radius:22px;border:1px solid #333;font-size:.82rem;font-weight:700;z-index:9999;box-shadow:0 6px 20px rgba(0,0,0,.5);font-family:system-ui,sans-serif;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = 'block';
  }
  function hideMapToast() {
    var t = document.getElementById('gmToast');
    if (t) t.style.display = 'none';
  }

  // ── LOCATE-ME BUTTON (RIGHT_BOTTOM, above zoom) ───────────────────
  window.addLocateButton = function(map) {
    if (!map || map._locateBtnMounted) return;
    map._locateBtnMounted = true;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Locate me';
    btn.setAttribute('aria-label', 'Locate me');
    btn.style.cssText = 'width:40px;height:40px;border:none;border-radius:2px;background:#fff;color:#333;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px -1px rgba(0,0,0,.3);margin:0 10px 10px 0;';
    btn.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i>';
    var locationMarker = null;
    btn.addEventListener('click', function() {
      if (!navigator.geolocation) { alert('Geolocation not supported by your browser.'); return; }
      showMapToast('Locating you\u2026');
      btn.disabled = true;
      navigator.geolocation.getCurrentPosition(function(pos) {
        var lat = pos.coords.latitude, lng = pos.coords.longitude;
        map.panTo({ lat: lat, lng: lng });
        map.setZoom(14);
        if (locationMarker) { try { locationMarker.setMap(null); } catch(e){} }
        ensurePulseKeyframes();
        var dotSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="7" fill="#4285F4" stroke="#ffffff" stroke-width="3"/></svg>';
        locationMarker = new google.maps.Marker({
          position: { lat: lat, lng: lng },
          map: map,
          title: 'Your location',
          icon: {
            url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(dotSvg),
            anchor: new google.maps.Point(11, 11),
            scaledSize: new google.maps.Size(22, 22)
          }
        });
        btn.disabled = false;
        hideMapToast();
      }, function(err) {
        btn.disabled = false;
        hideMapToast();
        if (err.code === 1) alert('Location access denied. Please allow location in your browser settings.');
        else alert('Could not get your location. Try again.');
      }, { enableHighAccuracy: true, timeout: 10000 });
    });
    map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(btn);
  };

  // ── NEARBY PLACES TOGGLE TOOLBAR ──────────────────────────────────
  // Pill-shaped buttons for Restaurants / Grocery / Schools / Coffee —
  // each toggles PlacesService.nearbySearch markers on the given map.
  var NEARBY_CATEGORIES = [
    { key: 'restaurant', type: 'restaurant',  label: '\uD83C\uDF7D Restaurants', color: '#E74C3C' },
    { key: 'grocery',    type: 'supermarket', label: '\uD83D\uDED2 Grocery',     color: '#27AE60' },
    { key: 'school',     type: 'school',      label: '\uD83C\uDFEB Schools',     color: '#3498DB' },
    { key: 'coffee',     type: 'cafe',        label: '\u2615 Coffee',            color: '#8E5A2F' }
  ];

  function nearbyCircleIcon(color) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><circle cx="9" cy="9" r="6.5" fill="' + color + '" stroke="#ffffff" stroke-width="2"/></svg>';
    return {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      anchor: new google.maps.Point(9, 9),
      scaledSize: new google.maps.Size(18, 18)
    };
  }

  function styleNearbyBtn(btn, active, color) {
    btn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;padding:6px 13px;border-radius:20px;font-size:.78rem;font-weight:700;cursor:pointer;font-family:system-ui,sans-serif;transition:all .15s;border:1px solid ' +
      (active ? color : '#333') + ';background:' +
      (active ? 'rgba(201,168,76,0.14)' : '#1a1a1a') + ';color:' +
      (active ? '#C9A84C' : '#bbb') + ';';
  }

  window.addNearbyPlacesToolbar = function(map, mountEl) {
    if (!map || !mountEl || mountEl._nearbyToolbarMounted) return;
    mountEl._nearbyToolbarMounted = true;

    var bar = document.createElement('div');
    bar.className = 'nearby-places-bar';
    bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px;background:#0d0d0d;border:1px solid #1f1f1f;border-radius:12px;margin:8px 0;';

    var service = new google.maps.places.PlacesService(map);
    // disableAutoPan — critical: InfoWindow's default behavior pans the map
    // on open, which previously tripped 'idle' listeners and caused loops.
    var iw = new google.maps.InfoWindow({ disableAutoPan: true });
    var state = {};      // { key: { active, markers } }
    var _searching = {}; // { key: bool } — guards against rapid re-click double-fire

    function clearMarkersFor(key) {
      var s = state[key]; if (!s) return;
      s.markers.forEach(function(m){ m.setMap(null); });
      s.markers = [];
    }

    // Fire nearbySearch immediately on toggle using the current map center.
    // NO 'idle' listener — that caused a feedback loop where marker creation
    // (or auto-pan from InfoWindow) retriggered the idle event and the map
    // continuously re-searched/zoomed.
    // NEVER call fitBounds() / setZoom() / panTo() in this callback.
    function fetchFor(cat) {
      var s = state[cat.key]; if (!s || !s.active) return;
      if (_searching[cat.key]) return;
      var center = map.getCenter(); if (!center) return;
      _searching[cat.key] = true;
      service.nearbySearch({
        location: center,
        radius: 1500,
        type: cat.type
      }, function(results, status) {
        _searching[cat.key] = false;
        if (status !== google.maps.places.PlacesServiceStatus.OK || !results) return;
        if (!s.active) return; // toggled off mid-flight
        clearMarkersFor(cat.key);
        results.forEach(function(p) {
          if (!p.geometry || !p.geometry.location) return;
          var marker = new google.maps.Marker({
            position: p.geometry.location,
            map: map,
            icon: nearbyCircleIcon(cat.color),
            title: p.name || ''
          });
          marker.addListener('mouseover', function() {
            iw.setContent(
              '<div style="color:#000;font-size:12px;padding:2px;font-family:system-ui,sans-serif;max-width:220px">' +
              '<strong>' + (p.name || '') + '</strong>' +
              (p.vicinity ? '<br><span style="color:#666;font-size:11px">' + p.vicinity + '</span>' : '') +
              '</div>'
            );
            iw.open({ map: map, anchor: marker, shouldFocus: false });
          });
          marker.addListener('mouseout', function(){ iw.close(); });
          s.markers.push(marker);
        });
      });
    }

    NEARBY_CATEGORIES.forEach(function(cat) {
      state[cat.key] = { active: false, markers: [] };
      _searching[cat.key] = false;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = cat.label;
      styleNearbyBtn(btn, false, cat.color);
      btn.addEventListener('click', function() {
        var s = state[cat.key];
        s.active = !s.active;
        styleNearbyBtn(btn, s.active, cat.color);
        if (s.active) fetchFor(cat);
        else clearMarkersFor(cat.key);
      });
      bar.appendChild(btn);
    });

    mountEl.appendChild(bar);
  };
})();
