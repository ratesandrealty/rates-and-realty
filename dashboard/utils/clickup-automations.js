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

  var supabaseClient = null;
  function getClient() {
    if (supabaseClient) return supabaseClient;
    if (window.supabase && SUPABASE_URL && ANON_KEY) {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, ANON_KEY);
    }
    return supabaseClient;
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
  var logById = {}; // log_id -> full log row, for the activity popup

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
    var name = c.display_name || TRIGGER_NAMES[c.trigger_type] || c.trigger_type;
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
      var token = await getAuthToken();
      var url = SUPABASE_URL + '/rest/v1/contacts?id=in.(' + unique.map(encodeURIComponent).join(',') +
                ')&select=id,first_name,last_name,phone,email,pipeline_status,lead_status';
      var res = await fetch(url, { headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + token } });
      if (!res.ok) return;
      var data = await res.json();
      (data || []).forEach(function (c) {
        var name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || ('Contact ' + String(c.id).slice(0, 6));
        contactCache[c.id] = {
          name: name, phone: c.phone || '', email: c.email || '',
          stage: c.pipeline_status || c.lead_status || ''
        };
      });
    } catch (e) {
      // Silent — activity table falls back to "Contact xxxxxx".
    }
  }

  function renderActivity(rows) {
    var host = document.querySelector('[data-target=auto-activity-wrap]');
    if (!host) return;
    logById = {};
    var body = rows.map(function (r) {
      logById[r.id] = r;
      var cfgMatch = configs.find(function (x) { return x.trigger_type === r.trigger_type; });
      var trigger = (cfgMatch && cfgMatch.display_name) || TRIGGER_NAMES[r.trigger_type] || r.trigger_type || '—';
      var contactCell;
      if (r.contact_id) {
        var c = contactCache[r.contact_id];
        var label = (c && c.name) || ('Contact ' + String(r.contact_id).slice(0, 6));
        contactCell = '<span class="auto-contact-link">' + esc(label) + '</span>';
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
        '<tr class="auto-activity-row" data-action="auto-activity-open" data-log-id="' + esc(r.id) + '">' +
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

  function fmtDue(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return '';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) +
           ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function closeActivityPopover() {
    var p = document.getElementById('auto-activity-pop');
    if (p) p.remove();
  }

  function showActivityPopover(logId) {
    var r = logById[logId];
    if (!r) return;
    closeActivityPopover();
    var c = r.contact_id ? contactCache[r.contact_id] : null;
    var meta = r.metadata || {};
    var title = meta.title || meta.attempted_title || '—';
    var cfgMatch = configs.find(function (x) { return x.trigger_type === r.trigger_type; });
    var trigger = (cfgMatch && cfgMatch.display_name) || TRIGGER_NAMES[r.trigger_type] || r.trigger_type || '—';
    var statusKey = r.status || 'failed';
    var statusLabel = STATUS_LABELS[statusKey] || statusKey;
    var due = fmtDue(meta.due_date);
    var priority = meta.priority || '';
    var contactName = c ? c.name : (r.contact_id ? ('Contact ' + String(r.contact_id).slice(0, 6)) : 'No contact');

    var rowsHtml = '';
    rowsHtml += '<div class="aap-row"><span class="aap-k">Task</span><span class="aap-v">' + esc(title) + '</span></div>';
    rowsHtml += '<div class="aap-row"><span class="aap-k">Trigger</span><span class="aap-v">' + esc(trigger) + '</span></div>';
    rowsHtml += '<div class="aap-row"><span class="aap-k">Status</span><span class="aap-v"><span class="auto-status-chip" data-s="' + esc(statusKey) + '">' + esc(statusLabel) + '</span></span></div>';
    if (due) rowsHtml += '<div class="aap-row"><span class="aap-k">Due</span><span class="aap-v">' + esc(due) + '</span></div>';
    if (priority) rowsHtml += '<div class="aap-row"><span class="aap-k">Priority</span><span class="aap-v">' + esc(priority) + '</span></div>';
    if (r.error) rowsHtml += '<div class="aap-row"><span class="aap-k">Error</span><span class="aap-v aap-err">' + esc(String(r.error).slice(0, 160)) + '</span></div>';

    var contactSub = '';
    if (c && (c.phone || c.email || c.stage)) {
      var bits = [];
      if (c.stage) bits.push(esc(c.stage));
      if (c.phone) bits.push(esc(c.phone));
      if (c.email) bits.push(esc(c.email));
      contactSub = '<div class="aap-sub">' + bits.join(' · ') + '</div>';
    }

    var actions = '';
    if (r.contact_id) actions += '<a class="aap-btn" href="#leads?lead=' + esc(r.contact_id) + '" data-action="aap-nav">View lead →</a>';
    if (r.clickup_task_id) actions += '<a class="aap-btn" href="https://app.clickup.com/t/' + esc(r.clickup_task_id) + '" target="_blank" rel="noopener">Open in ClickUp ↗</a>';

    var pop = document.createElement('div');
    pop.id = 'auto-activity-pop';
    pop.innerHTML =
      '<div class="aap-backdrop" data-action="aap-close"></div>' +
      '<div class="aap-card" role="dialog" aria-modal="true">' +
        '<button class="aap-x" data-action="aap-close" aria-label="Close">×</button>' +
        '<div class="aap-name">' + esc(contactName) + '</div>' +
        contactSub +
        '<div class="aap-body">' + rowsHtml + '</div>' +
        (actions ? '<div class="aap-actions">' + actions + '</div>' : '') +
      '</div>';
    document.body.appendChild(pop);
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

    if (!document.getElementById('auto-activity-pop-css')) {
      var st = document.createElement('style');
      st.id = 'auto-activity-pop-css';
      st.textContent = [
        '#auto-activity-pop{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;}',
        '#auto-activity-pop .aap-backdrop{position:absolute;inset:0;background:rgba(0,0,0,0.55);}',
        '#auto-activity-pop .aap-card{position:relative;width:min(420px,92vw);max-height:84vh;overflow:auto;background:#15161a;border:1px solid rgba(212,175,90,0.28);border-radius:14px;padding:18px;box-shadow:0 18px 50px rgba(0,0,0,0.55);}',
        '#auto-activity-pop .aap-x{position:absolute;top:8px;right:12px;background:none;border:none;color:#8a8f98;font-size:20px;cursor:pointer;}',
        '#auto-activity-pop .aap-x:hover{color:#fff;}',
        '#auto-activity-pop .aap-name{font-size:17px;font-weight:600;color:#f3f4f6;padding-right:24px;}',
        '#auto-activity-pop .aap-sub{margin-top:3px;font-size:12.5px;color:#9aa0aa;word-break:break-word;}',
        '#auto-activity-pop .aap-body{margin-top:14px;display:flex;flex-direction:column;gap:9px;}',
        '#auto-activity-pop .aap-row{display:flex;gap:12px;font-size:13.5px;}',
        '#auto-activity-pop .aap-k{flex:0 0 70px;color:#7f8590;text-transform:uppercase;font-size:11px;letter-spacing:.04em;padding-top:2px;}',
        '#auto-activity-pop .aap-v{flex:1;color:#e6e8ec;}',
        '#auto-activity-pop .aap-err{color:#ff8b8b;}',
        '#auto-activity-pop .aap-actions{margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;}',
        '#auto-activity-pop .aap-btn{flex:1;text-align:center;padding:9px 12px;border-radius:9px;border:1px solid rgba(212,175,90,0.35);color:#e9c46a;text-decoration:none;font-size:13px;white-space:nowrap;}',
        '#auto-activity-pop .aap-btn:hover{background:rgba(212,175,90,0.10);}',
        '.auto-activity-row{cursor:pointer;}',
        '.auto-activity-row:hover{background:rgba(255,255,255,0.03);}',
        '.auto-contact-link{color:#e9c46a;}'
      ].join('');
      document.head.appendChild(st);
    }
    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-action=aap-close]')) { closeActivityPopover(); return; }
      if (e.target.closest('[data-action=aap-nav]')) { closeActivityPopover(); }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeActivityPopover(); });

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

      var openEl = e.target.closest('[data-action=auto-activity-open]');
      if (openEl && !e.target.closest('a')) {
        showActivityPopover(openEl.getAttribute('data-log-id'));
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
