/**
 * ClickUp Automations subpanel — Layer 2 trigger configuration + activity log.
 *
 * Backend: PostgREST tables (read/write directly via Supabase REST).
 *   GET   /rest/v1/clickup_automation_config?order=display_order.asc&select=*
 *   PATCH /rest/v1/clickup_automation_config?trigger_type=eq.{type}
 *           body: { enabled, default_priority, due_offset_days, due_offset_hours }
 *   GET   /rest/v1/clickup_automation_log?order=fired_at.desc&limit=20&select=*
 *
 * Self-firing on hashchange to #tasks (matches the clickup-tasks.js pattern).
 * Idempotent — wireOnce flag + per-call refresh.
 */
(function () {
  'use strict';

  var SUPABASE_URL = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_URL) || 'https://ljywhvbmsibwnssxpesh.supabase.co';
  var ANON_KEY = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_ANON_KEY) || '';

  var TRIGGER_NAMES = {
    new_lead: 'New lead created',
    cold_lead_3d: 'Cold lead (3+ days no contact)',
    tour_sent: 'Tour sent to lead',
    tour_confirmed: 'Tour confirmed by lead',
    tour_completed: 'Tour completed',
    app_submitted: 'Mortgage application submitted',
    doc_uploaded: 'Borrower uploaded document',
    closed_won: 'Pipeline → Closed Won',
    approval_letter: 'Pre-approval letter generated',
  };

  var PRIORITY_OPTIONS = [
    { v: 'urgent', label: '🔴 Urgent' },
    { v: 'high',   label: '🟠 High' },
    { v: 'normal', label: '🟣 Normal' },
    { v: 'low',    label: '⚪ Low' },
  ];

  var STATUS_LABELS = {
    created: 'Created',
    skipped_duplicate: 'Duplicate',
    skipped_disabled: 'Disabled',
    failed: 'Failed',
  };

  var initialized = false;
  var configs = []; // last-loaded list of trigger configs
  var contactCache = {}; // contact_id → { name, lead_id }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function relTime(iso) {
    if (!iso) return '';
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return '';
    var diff = Math.max(0, (Date.now() - t) / 1000);
    if (diff < 60) return Math.floor(diff) + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago';
    var d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  async function rest(path, opts) {
    opts = opts || {};
    var headers = Object.assign(
      { 'Content-Type': 'application/json', 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY },
      opts.headers || {}
    );
    if (opts.method === 'PATCH') headers['Prefer'] = 'return=representation';
    var res = await fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({}, opts, { headers: headers }));
    if (!res.ok) {
      var body = '';
      try { body = await res.text(); } catch (e) {}
      throw new Error(res.status + (body ? ': ' + body.slice(0, 200) : ''));
    }
    var ct = res.headers.get('content-type') || '';
    if (ct.indexOf('json') !== -1) return res.json();
    return null;
  }

  // ── Config rendering ─────────────────────────────────────────────
  function renderConfigList() {
    var host = document.querySelector('[data-target=auto-config-list]');
    if (!host) return;
    if (!configs.length) {
      host.innerHTML = '<div class="auto-empty">No automation triggers configured.</div>';
      return;
    }
    var html = configs.map(function (c) { return rowHtml(c); }).join('');
    host.innerHTML = html;
  }

  function rowHtml(c) {
    var name = TRIGGER_NAMES[c.trigger_type] || c.trigger_type;
    var pri = (c.default_priority || 'normal').toLowerCase();
    var priLabel = (PRIORITY_OPTIONS.find(function (o) { return o.v === pri; }) || PRIORITY_OPTIONS[2]).label;
    var offset = parseInt(c.due_offset_days, 10);
    if (!isFinite(offset)) offset = 0;
    var template = c.title_template || '';
    var enabled = !!c.enabled;
    return '' +
      '<div class="auto-row" data-trigger="' + esc(c.trigger_type) + '">' +
        '<button class="auto-toggle" role="switch" aria-checked="' + (enabled ? 'true' : 'false') + '" data-action="auto-toggle" aria-label="Enable trigger"></button>' +
        '<div class="auto-row-meta">' +
          '<div class="auto-row-name">' + esc(name) + '</div>' +
          '<div class="auto-row-desc">' + esc(c.description || '') + '</div>' +
          (template ? '<div class="auto-template" title="' + esc(template) + '">' + esc(template) + '</div>' : '') +
        '</div>' +
        '<button class="auto-priority-btn" data-action="auto-priority" data-current="' + esc(pri) + '">' +
          '<span class="pri-label">' + priLabel + '</span>' +
          '<span class="pri-arrow">▾</span>' +
        '</button>' +
        '<div class="auto-offset-stepper">' +
          '<button type="button" data-action="auto-offset-dec" aria-label="Decrease">−</button>' +
          '<input type="number" data-action="auto-offset-input" value="' + offset + '" min="-7" max="14" step="1" />' +
          '<button type="button" data-action="auto-offset-inc" aria-label="Increase">+</button>' +
          '<span class="auto-offset-suffix">d</span>' +
        '</div>' +
      '</div>';
  }

  function flashRow(row, ok) {
    if (!row) return;
    row.classList.remove('flash-ok', 'flash-err');
    // Force reflow so the animation re-fires if it was already applied.
    void row.offsetWidth;
    row.classList.add(ok ? 'flash-ok' : 'flash-err');
  }

  function setBusy(row, busy) {
    if (!row) return;
    var ctl = row.querySelectorAll('button, input');
    [].slice.call(ctl).forEach(function (el) {
      if (busy) el.setAttribute('disabled', 'disabled');
      else el.removeAttribute('disabled');
    });
  }

  async function patchConfig(triggerType, patch, row) {
    setBusy(row, true);
    try {
      var data = await rest('clickup_automation_config?trigger_type=eq.' + encodeURIComponent(triggerType), {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      if (Array.isArray(data) && data[0]) {
        // Update local cache
        for (var i = 0; i < configs.length; i++) {
          if (configs[i].trigger_type === triggerType) {
            configs[i] = Object.assign({}, configs[i], data[0]);
            break;
          }
        }
      }
      flashRow(row, true);
    } catch (err) {
      console.warn('[automations] PATCH failed:', err);
      flashRow(row, false);
    } finally {
      setBusy(row, false);
    }
  }

  // ── Activity log rendering ───────────────────────────────────────
  async function loadActivity() {
    var host = document.querySelector('[data-target=auto-activity-wrap]');
    if (!host) return;
    host.innerHTML = '<div class="auto-loading">Loading activity…</div>';
    try {
      var rows = await rest('clickup_automation_log?order=fired_at.desc&limit=20&select=*');
      if (!Array.isArray(rows) || !rows.length) {
        host.innerHTML = '<div class="auto-empty">No automations have fired yet. Add a new lead or send a tour to test.</div>';
        return;
      }
      // Resolve any contact_ids we don't have cached yet.
      var needed = [];
      rows.forEach(function (r) {
        if (r.contact_id && !contactCache[r.contact_id]) needed.push(r.contact_id);
      });
      if (needed.length) await fetchContacts(needed);
      renderActivity(rows);
    } catch (err) {
      host.innerHTML = '<div class="auto-empty">Could not load activity: ' + esc(err.message || err) + '</div>';
    }
  }

  async function fetchContacts(ids) {
    var unique = Array.from(new Set(ids));
    if (!unique.length) return;
    try {
      var url = 'contacts?id=in.(' + unique.map(encodeURIComponent).join(',') + ')&select=id,first_name,last_name';
      var data = await rest(url);
      (data || []).forEach(function (c) {
        var name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || ('Contact ' + String(c.id).slice(0, 6));
        contactCache[c.id] = { name: name };
      });
    } catch (e) {
      // Silent — activity table will fall back to "Contact xxxxxx".
    }
  }

  function renderActivity(rows) {
    var host = document.querySelector('[data-target=auto-activity-wrap]');
    if (!host) return;
    var body = rows.map(function (r) {
      var trigger = TRIGGER_NAMES[r.trigger_type] || r.trigger_type || '—';
      var contactCell;
      if (r.contact_id) {
        var c = contactCache[r.contact_id];
        var label = (c && c.name) || ('Contact ' + String(r.contact_id).slice(0, 6));
        contactCell = '<a href="#leads?lead=' + esc(r.contact_id) + '" class="auto-contact-link">' + esc(label) + '</a>';
      } else {
        contactCell = '<span class="auto-contact-empty">—</span>';
      }
      var statusKey = r.status || 'failed';
      var statusLabel = STATUS_LABELS[statusKey] || statusKey;
      var statusCell = '<span class="auto-status-chip" data-s="' + esc(statusKey) + '">' + esc(statusLabel) + '</span>';
      var taskCell;
      if (r.clickup_task_id) {
        var url = 'https://app.clickup.com/t/' + encodeURIComponent(r.clickup_task_id);
        taskCell = '<a href="' + esc(url) + '" target="_blank" rel="noopener" class="auto-task-link">Open ↗</a>';
      } else {
        taskCell = '<span class="auto-task-link-empty">—</span>';
      }
      return '' +
        '<tr>' +
          '<td><span class="auto-time-rel">' + esc(relTime(r.fired_at)) + '</span></td>' +
          '<td><span class="auto-trigger-name">' + esc(trigger) + '</span></td>' +
          '<td>' + contactCell + '</td>' +
          '<td>' + statusCell + '</td>' +
          '<td>' + taskCell + '</td>' +
        '</tr>';
    }).join('');
    host.innerHTML = '' +
      '<table class="auto-activity-table">' +
        '<thead><tr><th>Time</th><th>Trigger</th><th>Contact</th><th>Status</th><th>Task</th></tr></thead>' +
        '<tbody>' + body + '</tbody>' +
      '</table>';
  }

  // ── Wiring ───────────────────────────────────────────────────────
  function getRow(el) {
    return el && el.closest ? el.closest('.auto-row') : null;
  }

  function wireOnce() {
    if (initialized) return;
    var panel = document.querySelector('[data-subpanel=automations]');
    if (!panel) return;
    initialized = true;

    // Click delegation for toggles, priority buttons, offset steppers.
    panel.addEventListener('click', function (e) {
      var toggleBtn = e.target.closest('[data-action=auto-toggle]');
      if (toggleBtn) {
        var row = getRow(toggleBtn);
        if (!row) return;
        var nowOn = toggleBtn.getAttribute('aria-checked') !== 'true';
        toggleBtn.setAttribute('aria-checked', nowOn ? 'true' : 'false');
        patchConfig(row.dataset.trigger, { enabled: nowOn }, row);
        return;
      }
      var priBtn = e.target.closest('[data-action=auto-priority]');
      if (priBtn) {
        e.stopPropagation();
        if (!window.__rrPickers) { console.warn('[automations] picker module not loaded'); return; }
        var rowP = getRow(priBtn);
        var current = priBtn.dataset.current;
        window.__rrPickers.priority(priBtn, 1, function (chosen) {
          if (!chosen || chosen === current) return;
          var opt = PRIORITY_OPTIONS.find(function (o) { return o.v === chosen; });
          if (opt) {
            priBtn.querySelector('.pri-label').textContent = opt.label;
            priBtn.dataset.current = chosen;
          }
          patchConfig(rowP.dataset.trigger, { default_priority: chosen }, rowP);
        });
        return;
      }
      var dec = e.target.closest('[data-action=auto-offset-dec]');
      if (dec) {
        var inputD = dec.parentElement.querySelector('input');
        bumpOffset(inputD, -1);
        return;
      }
      var inc = e.target.closest('[data-action=auto-offset-inc]');
      if (inc) {
        var inputI = inc.parentElement.querySelector('input');
        bumpOffset(inputI, +1);
        return;
      }
    });

    // Save offset on blur or Enter.
    panel.addEventListener('blur', function (e) {
      var input = e.target.closest('[data-action=auto-offset-input]');
      if (input) commitOffset(input);
    }, true);
    panel.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var input = e.target.closest('[data-action=auto-offset-input]');
      if (input) { e.preventDefault(); input.blur(); }
    });

    // Refresh activity log.
    panel.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action=auto-refresh-log]');
      if (btn) loadActivity();
    });

    // When the user clicks the Automations sub-tab, kick a refresh.
    [].slice.call(document.querySelectorAll('.task-subtab[data-subtab=automations]')).forEach(function (tab) {
      tab.addEventListener('click', function () { refresh(); });
    });
  }

  function bumpOffset(input, delta) {
    if (!input) return;
    var cur = parseInt(input.value, 10);
    if (!isFinite(cur)) cur = 0;
    var next = Math.max(-7, Math.min(14, cur + delta));
    if (next === cur) return;
    input.value = next;
    commitOffset(input);
  }

  function commitOffset(input) {
    var row = getRow(input);
    if (!row) return;
    var raw = parseInt(input.value, 10);
    if (!isFinite(raw)) raw = 0;
    var clamped = Math.max(-7, Math.min(14, raw));
    if (clamped !== raw) input.value = clamped;
    var existing = configs.find(function (c) { return c.trigger_type === row.dataset.trigger; });
    if (existing && existing.due_offset_days === clamped) return; // no-op
    patchConfig(row.dataset.trigger, { due_offset_days: clamped }, row);
  }

  // ── Lifecycle ────────────────────────────────────────────────────
  async function loadConfigs() {
    var host = document.querySelector('[data-target=auto-config-list]');
    if (!host) return;
    host.innerHTML = '<div class="auto-loading">Loading triggers…</div>';
    try {
      var rows = await rest('clickup_automation_config?order=display_order.asc&select=*');
      configs = Array.isArray(rows) ? rows : [];
      renderConfigList();
    } catch (err) {
      host.innerHTML = '<div class="auto-empty">Could not load triggers: ' + esc(err.message || err) + '</div>';
    }
  }

  function refresh() {
    loadConfigs();
    loadActivity();
  }

  function init() {
    wireOnce();
    if (!initialized) return; // panel not in DOM yet
    refresh();
  }

  function maybeAutoInit() {
    if (location.hash !== '#tasks' && location.hash !== '#dashboard') return;
    setTimeout(function () {
      wireOnce();
      // Only fetch on init if the saved sub-tab is automations — otherwise
      // we'll lazy-load when the user clicks the sub-tab.
      var saved = '';
      try { saved = localStorage.getItem('rr_tasks_subtab') || ''; } catch (e) {}
      if (saved === 'automations') refresh();
    }, 80);
  }

  window.initClickupAutomations = init;
  window.addEventListener('hashchange', maybeAutoInit);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeAutoInit);
  } else {
    maybeAutoInit();
  }
})();
