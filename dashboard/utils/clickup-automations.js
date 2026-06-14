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

  var AE_EVENTS = [
    { v:'new_lead', label:'New lead created' }, { v:'cold_lead_3d', label:'Cold lead (3+ days no contact)' },
    { v:'tour_sent', label:'Tour sent to lead' }, { v:'tour_confirmed', label:'Tour confirmed by lead' },
    { v:'tour_completed', label:'Tour completed' }, { v:'app_submitted', label:'Mortgage application submitted' },
    { v:'doc_uploaded', label:'Borrower uploaded document' }, { v:'closed_won', label:'Pipeline -> Closed Won' },
    { v:'approval_letter', label:'Pre-approval letter generated' }, { v:'lender_submitted', label:'Submitted to lender' },
    { v:'lender_conditions', label:'Conditions issued' }, { v:'lender_cleared', label:'Approved / clear-to-close' },
    { v:'lender_denied', label:'Suspended or denied' }
  ];
  function closeAutomationEditor() { var m = document.getElementById('auto-editor'); if (m) m.remove(); }
  function showAutomationEditor(cfg) {
    closeAutomationEditor();
    if (!document.getElementById('auto-editor-css')) {
      var st = document.createElement('style'); st.id = 'auto-editor-css';
      st.textContent = [
        '#auto-editor{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;}',
        '#auto-editor .ae-backdrop{position:absolute;inset:0;background:rgba(0,0,0,0.6);}',
        '#auto-editor .ae-card{position:relative;width:min(460px,94vw);max-height:88vh;overflow:auto;background:#15161a;border:1px solid rgba(212,175,90,0.3);border-radius:14px;padding:20px;box-shadow:0 18px 50px rgba(0,0,0,0.6);}',
        '#auto-editor .ae-x{position:absolute;top:8px;right:12px;background:none;border:none;color:#8a8f98;font-size:20px;cursor:pointer;}',
        '#auto-editor .ae-title{font-size:17px;font-weight:600;color:#f3f4f6;margin-bottom:6px;}',
        '#auto-editor .ae-label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#7f8590;margin:12px 0 4px;}',
        '#auto-editor .ae-hint{text-transform:none;letter-spacing:0;color:#6b7280;}',
        '#auto-editor .ae-input{width:100%;box-sizing:border-box;background:#0e0e0e;border:1px solid #2a2a2a;border-radius:8px;color:#e6e8ec;padding:9px 10px;font-size:13.5px;font-family:inherit;}',
        '#auto-editor textarea.ae-input{resize:vertical;}',
        '#auto-editor .ae-static{background:#0e0e0e;border:1px solid #2a2a2a;border-radius:8px;color:#9aa0aa;padding:9px 10px;font-size:13.5px;}',
        '#auto-editor .ae-row2{display:flex;gap:12px;}#auto-editor .ae-row2>div{flex:1;}',
        '#auto-editor .ae-check{display:flex;align-items:center;gap:8px;margin-top:14px;color:#e6e8ec;font-size:13.5px;}',
        '#auto-editor .ae-actions{display:flex;justify-content:space-between;align-items:center;margin-top:18px;}',
        '#auto-editor .ae-right{display:flex;gap:8px;margin-left:auto;}',
        '#auto-editor .ae-btn{padding:9px 16px;border-radius:9px;border:1px solid rgba(212,175,90,0.35);background:none;color:#e9c46a;font-size:13px;cursor:pointer;}',
        '#auto-editor .ae-save{background:rgba(212,175,90,0.15);}',
        '#auto-editor .ae-cancel{color:#9aa0aa;border-color:#2a2a2a;}',
        '#auto-editor .ae-del{color:#ff8b8b;border-color:rgba(255,139,139,0.4);}',
        '.auto-edit-btn{background:none;border:none;color:#7f8590;font-size:15px;cursor:pointer;padding:4px 8px;}',
        '.auto-edit-btn:hover{color:#e9c46a;}'
      ].join('');
      document.head.appendChild(st);
    }
    var isEdit = !!(cfg && cfg.id);
    var eventField = isEdit
      ? '<div class="ae-static">' + esc((AE_EVENTS.find(function(o){return o.v===cfg.trigger_type;})||{}).label || cfg.trigger_type) + '</div>'
      : '<select class="ae-input" id="ae-event">' + AE_EVENTS.map(function(o){return '<option value="'+esc(o.v)+'">'+esc(o.label)+'</option>';}).join('') + '<option value="__custom">Custom (fires only once wired)</option></select>';
    var pri = (cfg && cfg.default_priority) || 'normal';
    var priOpts = ['urgent','high','normal','low'].map(function(p){ return '<option value="'+p+'"'+(p===pri?' selected':'')+'>'+p.charAt(0).toUpperCase()+p.slice(1)+'</option>'; }).join('');
    var off = (cfg && isFinite(parseInt(cfg.due_offset_days,10))) ? parseInt(cfg.due_offset_days,10) : 1;
    var m = document.createElement('div');
    m.id = 'auto-editor';
    m.setAttribute('data-edit-id', isEdit ? cfg.id : '');
    m.innerHTML =
      '<div class="ae-backdrop" data-action="ae-close"></div>' +
      '<div class="ae-card" role="dialog" aria-modal="true">' +
        '<button class="ae-x" data-action="ae-close" aria-label="Close">×</button>' +
        '<div class="ae-title">' + (isEdit ? 'Edit automation' : 'New automation') + '</div>' +
        '<label class="ae-label">Fires on</label>' + eventField +
        '<label class="ae-label">Name</label><input class="ae-input" id="ae-name" value="' + esc((cfg && cfg.display_name) || '') + '" placeholder="e.g. Welcome call" />' +
        '<label class="ae-label">Task title <span class="ae-hint">{full_name} {first_name} {lender} {stage}</span></label>' +
        '<input class="ae-input" id="ae-title" value="' + esc((cfg && cfg.title_template) || '') + '" placeholder="Follow up with {full_name}" />' +
        '<label class="ae-label">Description</label><textarea class="ae-input" id="ae-desc" rows="2" placeholder="optional">' + esc((cfg && cfg.description_template) || '') + '</textarea>' +
        '<div class="ae-row2"><div><label class="ae-label">Priority</label><select class="ae-input" id="ae-pri">' + priOpts + '</select></div>' +
        '<div><label class="ae-label">Due (days)</label><input class="ae-input" id="ae-off" type="number" min="-7" max="30" value="' + off + '" /></div></div>' +
        '<label class="ae-check"><input type="checkbox" id="ae-enabled" ' + ((!cfg || cfg.enabled) ? 'checked' : '') + ' /> Enabled</label>' +
        '<div class="ae-actions">' + (isEdit ? '<button class="ae-btn ae-del" data-action="ae-delete">Delete</button>' : '<span></span>') +
        '<div class="ae-right"><button class="ae-btn ae-cancel" data-action="ae-close">Cancel</button><button class="ae-btn ae-save" data-action="ae-save">Save</button></div></div>' +
      '</div>';
    document.body.appendChild(m);
  }
  async function aeApi(path, payload) {
    var res = await fetch(SUPABASE_URL + '/functions/v1/automation-config/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  async function saveFromEditor() {
    var m = document.getElementById('auto-editor'); if (!m) return;
    var id = m.getAttribute('data-edit-id') || '';
    var title = (document.getElementById('ae-title').value || '').trim();
    if (!title) { alert('Task title is required.'); return; }
    var payload = {
      display_name: (document.getElementById('ae-name').value || '').trim(),
      title_template: title,
      description_template: (document.getElementById('ae-desc').value || '').trim() || null,
      default_priority: document.getElementById('ae-pri').value,
      due_offset_days: parseInt(document.getElementById('ae-off').value, 10) || 0,
      enabled: document.getElementById('ae-enabled').checked
    };
    if (id) payload.id = id;
    else { var ev = document.getElementById('ae-event').value; if (ev !== '__custom') payload.trigger_type = ev; }
    try { await aeApi('save', payload); closeAutomationEditor(); await loadConfigs(); }
    catch (err) { alert('Save failed: ' + (err && err.message || err)); }
  }
  async function deleteFromEditor() {
    var m = document.getElementById('auto-editor'); if (!m) return;
    var id = m.getAttribute('data-edit-id'); if (!id) return;
    if (!confirm('Delete this automation? This cannot be undone.')) return;
    try { await aeApi('delete', { id: id }); closeAutomationEditor(); await loadConfigs(); }
    catch (err) { alert('Delete failed: ' + (err && err.message || err)); }
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
      '<div class="auto-row" data-id="' + esc(c.id) + '" data-trigger="' + esc(c.trigger_type) + '">' +
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
        '<button class="auto-edit-btn" data-action="auto-edit" title="Edit or delete">✎</button>' +
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

  async function patchConfig(id, patch, row) {
    setBusy(row, true);
    try {
      var res = await fetch(SUPABASE_URL + '/functions/v1/automation-config/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY },
        body: JSON.stringify(Object.assign({ id: id }, patch))
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (data && data.config) {
        for (var i = 0; i < configs.length; i++) {
          if (configs[i].id === id) { configs[i] = Object.assign({}, configs[i], data.config); break; }
        }
      }
      flashRow(row, true);
    } catch (err) {
      console.warn('[automations] save failed:', err);
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
      var res = await fetch(SUPABASE_URL + '/functions/v1/clickup-bridge/resolve-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY },
        body: JSON.stringify({ ids: unique })
      });
      if (!res.ok) return;
      var data = await res.json();
      var map = (data && data.contacts) || {};
      Object.keys(map).forEach(function (id) { contactCache[id] = map[id]; });
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

    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-action=ae-close]')) { closeAutomationEditor(); return; }
      if (e.target.closest('[data-action=ae-save]')) { saveFromEditor(); return; }
      if (e.target.closest('[data-action=ae-delete]')) { deleteFromEditor(); return; }
    });

    // Click delegation for toggles, priority buttons, offset steppers.
    panel.addEventListener('click', function (e) {
      var newBtn = e.target.closest('[data-action=auto-new]');
      if (newBtn) { showAutomationEditor(null); return; }
      var editBtn = e.target.closest('[data-action=auto-edit]');
      if (editBtn) {
        var rowE = getRow(editBtn);
        var cfgE = configs.find(function (c) { return c.id === rowE.dataset.id; });
        if (cfgE) showAutomationEditor(cfgE);
        return;
      }
      var toggleBtn = e.target.closest('[data-action=auto-toggle]');
      if (toggleBtn) {
        var row = getRow(toggleBtn);
        if (!row) return;
        var nowOn = toggleBtn.getAttribute('aria-checked') !== 'true';
        toggleBtn.setAttribute('aria-checked', nowOn ? 'true' : 'false');
        patchConfig(row.dataset.id, { enabled: nowOn }, row);
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
          patchConfig(rowP.dataset.id, { default_priority: chosen }, rowP);
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
    var existing = configs.find(function (c) { return c.id === row.dataset.id; });
    if (existing && existing.due_offset_days === clamped) return; // no-op
    patchConfig(row.dataset.id, { due_offset_days: clamped }, row);
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
