/**
 * Calendar tab module — replaces the old month-grid renderCalendar().
 *
 * Backed by /functions/v1/calendar-data v1 which merges Google Calendar
 * events + CRM appointments + tour batches + tasks. Server does the
 * deduplication of Google events that originated from CRM appointments
 * (so we don't render the same meeting twice).
 *
 * Self-firing on hashchange (#calendar) so it doesn't depend on the SPA
 * dispatcher's dashboardData gate. Idempotent init.
 */
(function () {
  'use strict';

  var SUPABASE_URL = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_URL) || 'https://ljywhvbmsibwnssxpesh.supabase.co';
  var ANON_KEY = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_ANON_KEY) || '';

  var viewMode = 'week';
  var currentDate = new Date();
  var allEvents = [];
  var activeSources = new Set(['google', 'appts', 'tours', 'tasks']);
  var initialized = false;
  var supabaseClient = null;

  function getClient() {
    if (supabaseClient) return supabaseClient;
    if (window.supabase && SUPABASE_URL && ANON_KEY) {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, ANON_KEY);
    }
    return supabaseClient;
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function getAuthToken() {
    var client = getClient();
    if (client) {
      try {
        var sess = await client.auth.getSession();
        var token = sess && sess.data && sess.data.session && sess.data.session.access_token;
        if (token) return token;
      } catch (e) { /* fall through */ }
    }
    return ANON_KEY;
  }

  // ── Range / navigation ────────────────────────────────────────────
  function getViewRange() {
    var d = new Date(currentDate);
    var start, end;
    if (viewMode === 'day') {
      start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    } else if (viewMode === 'week') {
      var day = d.getDay();
      start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
      end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    } else if (viewMode === 'month') {
      // Pull a wider window so events from neighboring months that bleed
      // into the visible 6-week grid still come back.
      start = new Date(d.getFullYear(), d.getMonth() - 1, 15);
      end = new Date(d.getFullYear(), d.getMonth() + 1, 15);
    } else { // agenda
      start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 30);
    }
    return { start: start, end: end };
  }

  function navigate(direction) {
    var d = new Date(currentDate);
    if (viewMode === 'day') d.setDate(d.getDate() + direction);
    else if (viewMode === 'week') d.setDate(d.getDate() + 7 * direction);
    else if (viewMode === 'month') d.setMonth(d.getMonth() + direction);
    else d.setDate(d.getDate() + direction * 7);
    currentDate = d;
    refresh();
  }

  function setView(mode) {
    if (viewMode === mode) return;
    viewMode = mode;
    [].slice.call(document.querySelectorAll('.cal-view-toggle button')).forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === mode);
    });
    refresh();
  }

  // ── Backend ──────────────────────────────────────────────────────
  async function fetchEvents() {
    var range = getViewRange();
    var sources = Array.from(activeSources).join(',');
    var token = await getAuthToken();
    var url = SUPABASE_URL + '/functions/v1/calendar-data'
      + '?start=' + encodeURIComponent(range.start.toISOString())
      + '&end=' + encodeURIComponent(range.end.toISOString())
      + '&sources=' + encodeURIComponent(sources);
    var res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token, 'apikey': ANON_KEY }
    });
    if (!res.ok) {
      var body = '';
      try { body = await res.text(); } catch (e) {}
      throw new Error('calendar-data ' + res.status + (body ? ': ' + body.slice(0, 120) : ''));
    }
    return res.json();
  }

  // ── Formatting ────────────────────────────────────────────────────
  function fmtTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    } catch (e) { return ''; }
  }

  function updateTitle() {
    var titleEl = document.querySelector('[data-field=cal-title]');
    var subEl = document.querySelector('[data-field=cal-subtitle]');
    if (!titleEl) return;
    var r = getViewRange();
    if (viewMode === 'day') {
      titleEl.textContent = currentDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    } else if (viewMode === 'week') {
      var endDay = new Date(r.end); endDay.setDate(endDay.getDate() - 1);
      titleEl.textContent = r.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        + ' – ' + endDay.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } else if (viewMode === 'month') {
      titleEl.textContent = currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    } else {
      titleEl.textContent = 'Next 30 days';
    }
    if (subEl) {
      var n = allEvents.length;
      subEl.textContent = n + ' event' + (n === 1 ? '' : 's');
    }
  }

  function updateCounts(counts) {
    Object.keys(counts || {}).forEach(function (source) {
      var el = document.querySelector('[data-count="' + source + '"]');
      if (el) el.textContent = counts[source];
    });
  }

  // ── Renderers ────────────────────────────────────────────────────
  function eventChipHtml(e) {
    return '<div class="cal-event-chip" data-event-id="' + esc(e.id) + '" style="border-left-color:' + esc(e.color || '#C9A84C') + '">'
      + '<div class="ev-time">' + (e.all_day ? 'All day' : esc(fmtTime(e.start))) + '</div>'
      + '<div class="ev-title">' + esc(e.title) + '</div>'
      + (e.contact_name ? '<div class="ev-meta">' + esc(e.contact_name) + '</div>' : '')
      + '</div>';
  }

  function eventRowHtml(e) {
    var timeRange = e.all_day
      ? 'All day'
      : esc(fmtTime(e.start)) + (e.end && e.end !== e.start ? ' – ' + esc(fmtTime(e.end)) : '');
    return '<div class="cal-event-row" data-event-id="' + esc(e.id) + '" style="border-left-color:' + esc(e.color || '#C9A84C') + '">'
      + '<div class="ev-row-time">' + timeRange + '</div>'
      + '<div class="ev-row-body">'
      +   '<div class="ev-row-title">' + esc(e.title) + '</div>'
      +   (e.contact_name ? '<div class="ev-row-contact">📞 ' + esc(e.contact_name) + (e.contact_phone ? ' · ' + esc(e.contact_phone) : '') + '</div>' : '')
      +   (e.location ? '<div class="ev-row-loc">📍 ' + esc(e.location) + '</div>' : '')
      +   (e.description ? '<div class="ev-row-desc">' + esc(String(e.description).substring(0, 120)) + (String(e.description).length > 120 ? '…' : '') + '</div>' : '')
      + '</div>'
      + '<div class="ev-row-actions"><span class="src-tag src-' + esc(e.source) + '">' + esc(e.source) + '</span></div>'
      + '</div>';
  }

  function renderWeek() {
    var main = document.querySelector('[data-target=cal-main]');
    var r = getViewRange();
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(r.start); d.setDate(d.getDate() + i);
      days.push(d);
    }
    var todayKey = new Date().toDateString();
    var byDay = days.map(function (d) {
      var key = d.toDateString();
      return allEvents.filter(function (e) { return new Date(e.start).toDateString() === key; })
        .sort(function (a, b) { return new Date(a.start).getTime() - new Date(b.start).getTime(); });
    });
    main.innerHTML = '<div class="cal-week-grid">' + days.map(function (d, i) {
      var dayEvents = byDay[i];
      return '<div class="cal-week-day' + (d.toDateString() === todayKey ? ' is-today' : '') + '">'
        + '<div class="cal-day-header">'
        +   '<div class="cal-day-name">' + d.toLocaleDateString('en-US', { weekday: 'short' }) + '</div>'
        +   '<div class="cal-day-num">' + d.getDate() + '</div>'
        + '</div>'
        + '<div class="cal-day-events">'
        + (dayEvents.length === 0 ? '<div class="cal-day-empty-marker">·</div>' : dayEvents.map(eventChipHtml).join(''))
        + '</div>'
        + '</div>';
    }).join('') + '</div>';
  }

  function renderDay() {
    var main = document.querySelector('[data-target=cal-main]');
    var dayKey = currentDate.toDateString();
    var dayEvents = allEvents.filter(function (e) { return new Date(e.start).toDateString() === dayKey; })
      .sort(function (a, b) { return new Date(a.start).getTime() - new Date(b.start).getTime(); });
    if (!dayEvents.length) {
      main.innerHTML = '<div class="cal-empty-day"><div class="cal-empty-icon">📅</div><h3>Nothing scheduled</h3><p>Click + New Event to add something</p></div>';
      return;
    }
    main.innerHTML = '<div class="cal-day-list">' + dayEvents.map(eventRowHtml).join('') + '</div>';
  }

  function renderMonth() {
    var main = document.querySelector('[data-target=cal-main]');
    var year = currentDate.getFullYear();
    var month = currentDate.getMonth();
    var firstDay = new Date(year, month, 1);
    var startOffset = firstDay.getDay();
    var monthStart = new Date(firstDay); monthStart.setDate(monthStart.getDate() - startOffset);
    var cells = [];
    for (var i = 0; i < 42; i++) {
      var d = new Date(monthStart); d.setDate(d.getDate() + i);
      cells.push(d);
    }
    var todayKey = new Date().toDateString();
    var byDay = {};
    allEvents.forEach(function (e) {
      var key = new Date(e.start).toDateString();
      if (!byDay[key]) byDay[key] = [];
      byDay[key].push(e);
    });
    Object.keys(byDay).forEach(function (k) {
      byDay[k].sort(function (a, b) { return new Date(a.start).getTime() - new Date(b.start).getTime(); });
    });
    main.innerHTML = '<div class="cal-month-grid">'
      + '<div class="cal-month-header">' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(function (n) { return '<div>' + n + '</div>'; }).join('') + '</div>'
      + '<div class="cal-month-cells">' + cells.map(function (d) {
          var key = d.toDateString();
          var evs = byDay[key] || [];
          var inMonth = d.getMonth() === month;
          var visible = evs.slice(0, 3);
          var more = evs.length > 3 ? '<div class="cal-month-more">+' + (evs.length - 3) + ' more</div>' : '';
          return '<div class="cal-month-cell' + (key === todayKey ? ' is-today' : '') + (inMonth ? '' : ' is-other-month') + '">'
            + '<div class="cal-month-num">' + d.getDate() + '</div>'
            + visible.map(function (e) {
                return '<div class="cal-month-event" data-event-id="' + esc(e.id) + '" style="border-left-color:' + esc(e.color || '#C9A84C') + '" title="' + esc(e.title) + '">'
                  + esc(fmtTime(e.start)) + ' ' + esc(String(e.title).substring(0, 24))
                  + '</div>';
              }).join('')
            + more
            + '</div>';
        }).join('') + '</div>'
      + '</div>';
  }

  function renderAgenda() {
    var main = document.querySelector('[data-target=cal-main]');
    var sorted = allEvents.slice().sort(function (a, b) { return new Date(a.start).getTime() - new Date(b.start).getTime(); });
    if (!sorted.length) {
      main.innerHTML = '<div class="cal-empty-day"><div class="cal-empty-icon">📭</div><h3>Calendar is clear</h3><p>Nothing in the next 30 days</p></div>';
      return;
    }
    var groups = {};
    var order = [];
    sorted.forEach(function (e) {
      var key = new Date(e.start).toDateString();
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(e);
    });
    main.innerHTML = '<div class="cal-agenda-list">' + order.map(function (key) {
      var d = new Date(key);
      var evs = groups[key];
      return '<div class="cal-agenda-day">'
        + '<div class="cal-agenda-date">'
        +   '<div class="cal-agenda-weekday">' + d.toLocaleDateString('en-US', { weekday: 'long' }) + '</div>'
        +   '<div class="cal-agenda-num">' + d.getDate() + '</div>'
        +   '<div class="cal-agenda-month">' + d.toLocaleDateString('en-US', { month: 'short' }) + '</div>'
        + '</div>'
        + '<div class="cal-agenda-events">' + evs.map(eventRowHtml).join('') + '</div>'
        + '</div>';
    }).join('') + '</div>';
  }

  function renderUpcoming() {
    var target = document.querySelector('[data-target=cal-upcoming-list]');
    if (!target) return;
    var now = Date.now();
    var upcoming = allEvents.filter(function (e) { return new Date(e.start).getTime() > now; })
      .sort(function (a, b) { return new Date(a.start).getTime() - new Date(b.start).getTime(); })
      .slice(0, 5);
    if (!upcoming.length) {
      target.innerHTML = '<div class="cal-empty-mini">Nothing upcoming</div>';
      return;
    }
    target.innerHTML = upcoming.map(function (e) {
      return '<div class="upcoming-item" data-event-id="' + esc(e.id) + '">'
        + '<div class="up-dot" style="background:' + esc(e.color || '#C9A84C') + '"></div>'
        + '<div class="up-body">'
        +   '<div class="up-when">' + new Date(e.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + esc(fmtTime(e.start)) + '</div>'
        +   '<div class="up-title">' + esc(e.title) + '</div>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  // ── Event detail popover ─────────────────────────────────────────
  function showEventPopover(eventId, anchor) {
    var e = allEvents.find(function (x) { return x.id === eventId; });
    if (!e) return;
    var pop = document.querySelector('[data-target=cal-popover]');
    if (!pop) return;
    pop.innerHTML = '<div class="popover-header" style="border-top:4px solid ' + esc(e.color || '#C9A84C') + '">'
      + '<h4>' + esc(e.title) + '</h4>'
      + '<button class="cal-btn-icon" data-action="popover-close" aria-label="Close">✕</button>'
      + '</div>'
      + '<div class="popover-body">'
      +   '<div class="popover-when">' + new Date(e.start).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</div>'
      +   (e.contact_name ? '<div class="popover-row"><strong>Lead:</strong> ' + esc(e.contact_name) + '</div>' : '')
      +   (e.contact_phone ? '<div class="popover-row"><a href="tel:' + esc(String(e.contact_phone).replace(/[^0-9+]/g, '')) + '">📞 ' + esc(e.contact_phone) + '</a></div>' : '')
      +   (e.contact_email ? '<div class="popover-row"><a href="mailto:' + esc(e.contact_email) + '">✉ ' + esc(e.contact_email) + '</a></div>' : '')
      +   (e.location ? '<div class="popover-row"><strong>Location:</strong> ' + esc(e.location) + '</div>' : '')
      +   (e.description ? '<div class="popover-row popover-desc">' + esc(e.description) + '</div>' : '')
      +   '<div class="popover-actions">'
      +     (e.link ? '<a class="cal-btn-secondary" href="' + esc(e.link) + '">Open in CRM →</a>' : '')
      +     (e.lead_facing_link ? '<a class="cal-btn-secondary" href="' + esc(e.lead_facing_link) + '" target="_blank" rel="noopener">Public link ↗</a>' : '')
      +   '</div>'
      + '</div>';
    var rect = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = Math.min(rect.bottom + 6, window.innerHeight - 320) + 'px';
    pop.style.left = Math.min(rect.left, window.innerWidth - 360) + 'px';
    pop.hidden = false;
  }

  function closePopover() {
    var pop = document.querySelector('[data-target=cal-popover]');
    if (pop) pop.hidden = true;
  }

  // ── New event modal ──────────────────────────────────────────────
  function openNewEventModal() {
    var modal = document.querySelector('[data-target=cal-event-modal]');
    if (!modal) return;
    document.querySelector('[data-field=modal-title]').textContent = 'New event';
    document.querySelector('[data-field=ev-title]').value = '';
    var now = new Date();
    now.setMinutes(0); now.setSeconds(0); now.setMilliseconds(0);
    now.setHours(now.getHours() + 1);
    // datetime-local needs naive ISO without tz suffix
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var iso = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
      + 'T' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    document.querySelector('[data-field=ev-start]').value = iso;
    document.querySelector('[data-field=ev-duration]').value = 60;
    document.querySelector('[data-field=ev-location]').value = '';
    document.querySelector('[data-field=ev-notes]').value = '';
    populateContactsDropdown();
    modal.hidden = false;
  }

  async function populateContactsDropdown() {
    var sel = document.querySelector('[data-field=ev-contact]');
    if (!sel || sel.options.length > 1) return; // already populated
    try {
      var token = await getAuthToken();
      var res = await fetch(SUPABASE_URL + '/rest/v1/contacts?select=id,first_name,last_name&order=first_name&limit=200', {
        headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + token }
      });
      var contacts = await res.json();
      if (!Array.isArray(contacts)) return;
      contacts.forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || '(unnamed)';
        sel.appendChild(opt);
      });
    } catch (e) { console.warn('[cal] contacts dropdown failed:', e); }
  }

  async function saveNewEvent() {
    var title = document.querySelector('[data-field=ev-title]').value.trim();
    if (!title) { alert('Title required'); return; }
    var startLocal = document.querySelector('[data-field=ev-start]').value;
    if (!startLocal) { alert('Start time required'); return; }
    var startD = new Date(startLocal);
    var duration = parseInt(document.querySelector('[data-field=ev-duration]').value, 10) || 60;
    var endD = new Date(startD.getTime() + duration * 60000);
    var body = {
      title: title,
      type: document.querySelector('[data-field=ev-type]').value,
      start: startD.toISOString(),
      end: endD.toISOString(),
      contact_id: document.querySelector('[data-field=ev-contact]').value || null,
      location: document.querySelector('[data-field=ev-location]').value || null,
      description: document.querySelector('[data-field=ev-notes]').value || null,
    };
    var btn = document.querySelector('[data-action=cal-save-event]');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      var token = await getAuthToken();
      var res = await fetch(SUPABASE_URL + '/functions/v1/calendar-data/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'apikey': ANON_KEY },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        var errBody = '';
        try { errBody = await res.text(); } catch (e) {}
        throw new Error(res.status + (errBody ? ': ' + errBody.slice(0, 120) : ''));
      }
      document.querySelector('[data-target=cal-event-modal]').hidden = true;
      await refresh();
    } catch (e) {
      alert('Save failed: ' + (e.message || 'unknown'));
    } finally {
      btn.disabled = false; btn.textContent = 'Create event';
    }
  }

  // ── Refresh / view dispatcher ────────────────────────────────────
  async function refresh() {
    var main = document.querySelector('[data-target=cal-main]');
    if (main) main.innerHTML = '<div class="cal-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>';
    try {
      var data = await fetchEvents();
      allEvents = data.events || [];
      updateCounts(data.counts || {});
      updateTitle();
      if (viewMode === 'day') renderDay();
      else if (viewMode === 'week') renderWeek();
      else if (viewMode === 'month') renderMonth();
      else renderAgenda();
      renderUpcoming();
    } catch (e) {
      console.error('[cal] refresh failed:', e);
      if (main) main.innerHTML = '<div class="cal-error">Failed to load: ' + esc(e.message || 'unknown') + '</div>';
    }
  }

  // ── Wiring (idempotent) ──────────────────────────────────────────
  function init() {
    if (initialized) return;
    if (!document.querySelector('[data-target=cal-main]')) return;
    initialized = true;

    [].slice.call(document.querySelectorAll('.cal-view-toggle button')).forEach(function (b) {
      b.addEventListener('click', function () { setView(b.dataset.view); });
    });
    var todayBtn = document.querySelector('[data-action=cal-today]');
    if (todayBtn) todayBtn.addEventListener('click', function () { currentDate = new Date(); refresh(); });
    var prevBtn = document.querySelector('[data-action=cal-prev]');
    if (prevBtn) prevBtn.addEventListener('click', function () { navigate(-1); });
    var nextBtn = document.querySelector('[data-action=cal-next]');
    if (nextBtn) nextBtn.addEventListener('click', function () { navigate(1); });
    var newBtn = document.querySelector('[data-action=cal-new-event]');
    if (newBtn) newBtn.addEventListener('click', openNewEventModal);
    var saveBtn = document.querySelector('[data-action=cal-save-event]');
    if (saveBtn) saveBtn.addEventListener('click', saveNewEvent);
    [].slice.call(document.querySelectorAll('[data-action=cal-modal-close]')).forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelector('[data-target=cal-event-modal]').hidden = true;
      });
    });

    [].slice.call(document.querySelectorAll('.source-filter input')).forEach(function (cb) {
      cb.addEventListener('change', function () {
        if (cb.checked) activeSources.add(cb.dataset.source);
        else activeSources.delete(cb.dataset.source);
        refresh();
      });
    });

    // Event clicks (popover) — delegated, scoped to the calendar tab so we
    // don't intercept clicks elsewhere. Excludes anchor clicks inside the
    // popover (Open in CRM links should follow normal navigation).
    document.addEventListener('click', function (e) {
      var calSection = document.getElementById('tab-calendar');
      if (!calSection || !calSection.classList.contains('is-active')) return;

      var closer = e.target.closest('[data-action=popover-close]');
      if (closer) { closePopover(); return; }

      var ev = e.target.closest('[data-event-id]');
      if (ev && calSection.contains(ev)) {
        e.stopPropagation();
        showEventPopover(ev.dataset.eventId, ev);
        return;
      }
      // Click outside the popover/modal closes the popover.
      if (!e.target.closest('[data-target=cal-popover]') && !e.target.closest('[data-target=cal-event-modal]')) {
        closePopover();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (location.hash !== '#calendar') return;
      var tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft') { navigate(-1); return; }
      if (e.key === 'ArrowRight') { navigate(1); return; }
      if (e.key === 't' || e.key === 'T') { currentDate = new Date(); refresh(); return; }
      if (e.key === 'd') { setView('day'); return; }
      if (e.key === 'w') { setView('week'); return; }
      if (e.key === 'm') { setView('month'); return; }
      if (e.key === 'a') { setView('agenda'); return; }
      if (e.key === 'n') { openNewEventModal(); return; }
      if (e.key === 'Escape') {
        closePopover();
        var modal = document.querySelector('[data-target=cal-event-modal]');
        if (modal) modal.hidden = true;
      }
    });

    refresh();
  }

  function maybeAutoInit() {
    if (location.hash !== '#calendar') return;
    // 60ms tick to let the SPA flip is-active first.
    setTimeout(function () {
      init();
      // Always refresh on hash entry (covers re-entering the tab after a
      // long idle — Google events may have changed).
      if (initialized) refresh();
    }, 60);
  }

  window.initCalendar = function () { init(); if (initialized) refresh(); };

  window.addEventListener('hashchange', maybeAutoInit);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeAutoInit);
  } else {
    maybeAutoInit();
  }
})();
