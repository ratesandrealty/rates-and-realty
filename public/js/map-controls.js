/**
 * Shared Mapbox GL map controls for CRM pages.
 * Adds a vertical control stack to the top-left of any map:
 *   1. Satellite / street-view style toggle
 *   2. Street View (opens Google Maps street view in a new tab)
 *   3. Locate Me (browser geolocation → pulsing blue dot)
 *
 * Usage: call window.addAllMapControls(mapInstance) after creating a
 * mapboxgl.Map. Safe to call before or after the 'load' event.
 *
 * Notes:
 * - setStyle() does NOT remove mapboxgl.Marker instances (they are DOM
 *   elements attached to the marker-container), only style-owned layers.
 * - After a style change, the map fires a 'style-changed' custom event.
 *   Pages that use map.addSource / map.addLayer should re-add them in a
 *   handler: map.on('style-changed', () => { /* re-add layers *\/ }).
 */
(function(){
  var DARK_STYLE = 'mapbox://styles/mapbox/dark-v11';
  var SATELLITE_STYLE = 'mapbox://styles/mapbox/satellite-streets-v12';
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
      map.setStyle(isSatellite ? SATELLITE_STYLE : DARK_STYLE);
      btn.innerHTML = isSatellite ? '\uD83D\uDDFA\uFE0F' : '\uD83D\uDEF0\uFE0F';
      btn.title = isSatellite ? 'Switch to street view' : 'Switch to satellite';
      map.once('styledata', function() {
        map.fire('style-changed', { satellite: isSatellite });
      });
    });
    container.appendChild(btn);
  }

  function addStreetViewBtn(map, container) {
    var btn = makeBtn('Street View', '\uD83D\uDEB6');
    btn.addEventListener('click', function() {
      var c = map.getCenter();
      var lat = c.lat.toFixed(6);
      var lng = c.lng.toFixed(6);
      // Fallback while GCP Maps key is unavailable: open Google Maps street
      // view in a new tab (layer=c enables pegman/Streetside pane).
      var url = 'https://www.google.com/maps?q=' + lat + ',' + lng +
                '&layer=c&cbll=' + lat + ',' + lng;
      window.open(url, '_blank', 'noopener,noreferrer');
    });
    container.appendChild(btn);
  }

  // Inject @keyframes pulse once per page
  function ensurePulseKeyframes() {
    if (document.getElementById('mapCtrlPulseStyle')) return;
    var s = document.createElement('style');
    s.id = 'mapCtrlPulseStyle';
    s.textContent = '@keyframes mapCtrlPulse{0%{box-shadow:0 0 0 0 rgba(66,133,244,0.55)}70%{box-shadow:0 0 0 16px rgba(66,133,244,0)}100%{box-shadow:0 0 0 0 rgba(66,133,244,0)}}';
    document.head.appendChild(s);
  }

  function addLocateBtn(map, container) {
    var btn = makeBtn('Show my location', '\uD83D\uDCCD');
    var locationMarker = null;
    btn.addEventListener('click', function() {
      if (!navigator.geolocation) {
        alert('Geolocation not supported by your browser.');
        return;
      }
      var orig = btn.innerHTML;
      btn.innerHTML = '\u231B';
      btn.disabled = true;
      navigator.geolocation.getCurrentPosition(function(pos) {
        var lat = pos.coords.latitude;
        var lng = pos.coords.longitude;
        map.flyTo({ center: [lng, lat], zoom: 15, speed: 1.4 });
        if (locationMarker) { try { locationMarker.remove(); } catch(e){} }
        ensurePulseKeyframes();
        var dot = document.createElement('div');
        dot.style.cssText = 'width:18px;height:18px;border-radius:50%;background:#4285F4;border:3px solid #fff;box-shadow:0 0 0 0 rgba(66,133,244,0.55);animation:mapCtrlPulse 2s infinite;';
        locationMarker = new mapboxgl.Marker({ element: dot })
          .setLngLat([lng, lat])
          .setPopup(new mapboxgl.Popup({offset:20,closeButton:false}).setHTML('<div style="color:#000;font-size:12px;padding:4px;font-family:sans-serif">Your location</div>'))
          .addTo(map);
        btn.innerHTML = orig;
        btn.disabled = false;
      }, function(err) {
        btn.innerHTML = orig;
        btn.disabled = false;
        if (err.code === 1) alert('Location access denied. Please allow location in your browser settings.');
        else alert('Could not get your location. Try again.');
      }, { enableHighAccuracy: true, timeout: 10000 });
    });
    container.appendChild(btn);
  }

  function mount(map) {
    // Avoid double-mounting
    if (map._crmControlsMounted) return;
    map._crmControlsMounted = true;
    var container = document.createElement('div');
    container.className = 'crm-map-controls';
    container.style.cssText = 'position:absolute;top:10px;left:10px;z-index:5;display:flex;flex-direction:column;gap:4px;';
    map.getContainer().appendChild(container);
    addSatelliteToggle(map, container);
    addStreetViewBtn(map, container);
    addLocateBtn(map, container);
  }

  window.addAllMapControls = function(map) {
    if (!map) return;
    if (map.loaded && map.loaded()) { mount(map); return; }
    map.once('load', function(){ mount(map); });
  };
})();
