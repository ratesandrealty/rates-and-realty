/**
 * lead-picker.js — the one contact/lead picker.
 *
 * WHY THIS EXISTS. Four places let you attach a lead to something, and every one
 * of them silently truncated the list:
 *
 *   calendar New Event modal      limit=200   838 of 1,038 contacts unreachable
 *   ClickUp New Task modal        limit=500   ~538 unreachable
 *   ClickUp task filter dropdown  limit=500   ~538 unreachable
 *   bulk-lead-picker              limit=500   ~538 unreachable, and it HAD a
 *                                             search box — which searched a list
 *                                             that was already cut short
 *
 * None of them said so. A name simply was not there, which reads as "that contact
 * does not exist" rather than "the list stopped at 500". That is the defect; the
 * typeahead is what makes 1,038 usable once they are all reachable.
 *
 * Two more things the old pickers got wrong and this does not:
 *   - they searched NAME only. "Alba None", "Alberto Unknown", "Echeverria None"
 *     and "Edgar None" have placeholder surnames, so name-only search loses the
 *     people most likely to be looked up by phone or email.
 *   - they queried `contacts` with the ANON key as the bearer. This uses
 *     contacts_secure with the signed-in user's session token, so RLS applies.
 *
 * NO SILENT CAPS ANYWHERE. The fetch asks for a count and compares it to what
 * arrived; a short load is stated, not hidden. The result list shows 20 at a time
 * and says "showing 20 of 47" rather than looking complete.
 *
 * Public: window.LeadPicker.mount(el, opts) -> { value, setValue, destroy }
 *   opts.name        data-field name to expose for existing .value readers
 *   opts.emptyLabel  label for the explicit no-selection state
 *   opts.allowEmpty  default true
 *   opts.extra       [{value,label}] extra fixed options (e.g. "— Unlinked —")
 *   opts.onSelect    fn(id|null, contact|null)
 */
(function () {
  'use strict';

  var SUPABASE_URL = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_URL) || 'https://ljywhvbmsibwnssxpesh.supabase.co';
  var ANON_KEY = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_ANON_KEY) || '';
  var MAX_RESULTS = 20;

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var digits = function (s) { return String(s || '').replace(/\D/g, ''); };

  async function getToken() {
    var sb = window._dashSupabase || window._pipelineSupabase || window._supabaseClient;
    if (!sb || !sb.auth) return null;
    try {
      var s = await sb.auth.getSession();
      return (s && s.data && s.data.session && s.data.session.access_token) || null;
    } catch (e) { return null; }
  }

  /* One load, shared by every picker on the page. Resolves to
   * { rows, total, short } — `short` is true when fewer rows arrived than the
   * server says exist, which is the case that must never be silent. */
  var _cache = null;
  function loadContacts(force) {
    if (_cache && !force) return _cache;
    _cache = (async function () {
      var token = await getToken();
      if (!token) throw new Error('Not signed in — reload the page and sign in again.');
      // limit is deliberately far above the row count; Prefer: count=exact lets us
      // PROVE we got everything rather than assume it.
      var url = SUPABASE_URL + '/rest/v1/contacts_secure'
        + '?select=id,first_name,last_name,phone,email&order=first_name.asc&limit=5000';
      var res = await fetch(url, {
        headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token, Prefer: 'count=exact' }
      });
      if (!res.ok) throw new Error('contacts ' + res.status);
      var rows = await res.json();
      if (!Array.isArray(rows)) rows = [];
      // Content-Range: 0-1037/1038
      var total = rows.length;
      var cr = res.headers.get('content-range') || '';
      var m = /\/(\d+)$/.exec(cr);
      if (m) total = parseInt(m[1], 10);
      rows.forEach(function (c) {
        c._name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
        c._hay = (c._name + ' ' + (c.email || '')).toLowerCase();
        c._digits = digits(c.phone);
      });
      return { rows: rows, total: total, short: rows.length < total };
    })();
    _cache.catch(function () { _cache = null; });   // let a failed load be retried
    return _cache;
  }

  function match(rows, q) {
    var s = q.trim().toLowerCase();
    if (!s) return rows;
    var d = digits(s);
    return rows.filter(function (c) {
      if (c._hay.indexOf(s) !== -1) return true;
      return d.length >= 3 && c._digits.indexOf(d) !== -1;
    });
  }

  function mount(el, opts) {
    opts = opts || {};
    var emptyLabel = opts.emptyLabel || '— No lead —';
    var allowEmpty = opts.allowEmpty !== false;
    var extra = opts.extra || [];
    var selected = null;          // {id,label} or null
    var active = -1;
    var results = [];
    var state = { rows: [], total: 0, short: false };

    el.classList.add('lead-picker');
    el.innerHTML =
      '<input type="hidden" ' + (opts.name ? 'data-field="' + esc(opts.name) + '"' : '') + ' value="">'
      + '<input type="text" class="lp-input" autocomplete="off" spellcheck="false" placeholder="' + esc(opts.placeholder || 'Search leads by name, phone or email…') + '">'
      + '<div class="lp-menu" hidden></div>';
    var hidden = el.querySelector('input[type=hidden]');
    var input = el.querySelector('.lp-input');
    var menu = el.querySelector('.lp-menu');

    function setValue(id, label) {
      selected = id ? { id: id, label: label } : null;
      hidden.value = id || '';
      input.value = label || (id ? '' : '');
      close();
      if (opts.onSelect) opts.onSelect(id || null, selected);
    }

    function rowsHtml() {
      var q = input.value;
      var all = match(state.rows, q);
      results = all.slice(0, MAX_RESULTS);
      var head = '';
      if (state.short) {
        head += '<div class="lp-warn">Only ' + state.rows.length + ' of ' + state.total
              + ' contacts loaded — this list is incomplete. Reload the page.</div>';
      }
      var opts_ = [];
      if (allowEmpty) opts_.push({ value: '', label: emptyLabel, sub: '' });
      extra.forEach(function (o) { opts_.push({ value: o.value, label: o.label, sub: '' }); });
      var fixed = opts_.map(function (o, i) {
        return '<button type="button" class="lp-opt' + (active === i ? ' is-active' : '') + '" data-i="' + i + '" data-id="' + esc(o.value) + '">'
             + '<span class="lp-name">' + esc(o.label) + '</span></button>';
      }).join('');
      var offset = opts_.length;
      var body = results.map(function (c, i) {
        var sub = c.phone || c.email || '';
        return '<button type="button" class="lp-opt' + (active === i + offset ? ' is-active' : '') + '" data-i="' + (i + offset) + '" data-id="' + esc(c.id) + '">'
             + '<span class="lp-name">' + esc(c._name || '(unnamed)') + '</span>'
             + (sub ? '<span class="lp-sub">' + esc(sub) + '</span>' : '')
             + '</button>';
      }).join('');
      var foot = '';
      if (!all.length) foot = '<div class="lp-empty">No match for “' + esc(q) + '”</div>';
      else if (all.length > results.length) foot = '<div class="lp-count">Showing ' + results.length + ' of ' + all.length + ' matches — keep typing to narrow</div>';
      else if (q.trim()) foot = '<div class="lp-count">' + all.length + ' match' + (all.length === 1 ? '' : 'es') + '</div>';
      else foot = '<div class="lp-count">' + state.total + ' contacts</div>';
      menu.innerHTML = head + fixed + body + foot;
      // index -> {id,label} for keyboard selection
      menu._items = opts_.map(function (o) { return { id: o.value, label: o.label }; })
        .concat(results.map(function (c) { return { id: c.id, label: c._name || '(unnamed)' }; }));
    }

    function open() { menu.hidden = false; rowsHtml(); }
    function close() { menu.hidden = true; active = -1; }

    input.addEventListener('focus', async function () {
      open();
      menu.innerHTML = '<div class="lp-count">Loading…</div>';
      try {
        state = await loadContacts();
      } catch (e) {
        menu.innerHTML = '<div class="lp-warn">' + esc(e.message || 'Could not load contacts') + '</div>';
        return;
      }
      rowsHtml();
    });
    input.addEventListener('input', function () { active = -1; if (!menu.hidden) rowsHtml(); });
    input.addEventListener('keydown', function (e) {
      var n = (menu._items || []).length;
      if (e.key === 'ArrowDown') { e.preventDefault(); if (n) { active = (active + 1) % n; rowsHtml(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { active = (active - 1 + n) % n; rowsHtml(); } }
      else if (e.key === 'Enter') {
        if (active >= 0 && menu._items && menu._items[active]) {
          e.preventDefault();
          var it = menu._items[active];
          setValue(it.id, it.id ? it.label : '');
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (!menu.hidden) close();
        else setValue('', '');       // Escape on a closed picker clears the selection
      }
    });
    menu.addEventListener('mousedown', function (e) {
      var btn = e.target.closest('.lp-opt');
      if (!btn) return;
      e.preventDefault();
      var id = btn.dataset.id || '';
      var label = btn.querySelector('.lp-name').textContent;
      setValue(id, id ? label : '');
    });
    document.addEventListener('mousedown', function (e) { if (!el.contains(e.target)) close(); });

    return {
      get value() { return hidden.value || ''; },
      setValue: function (id, label) { setValue(id || '', label || ''); },
      reset: function () { setValue('', ''); input.value = ''; },
      destroy: function () { el.innerHTML = ''; }
    };
  }

  window.LeadPicker = { mount: mount, reload: function () { return loadContacts(true); } };
})();
