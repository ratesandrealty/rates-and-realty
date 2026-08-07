/* notif-bell — the notification bell, shared by admin/lead-detail.html and
 * dashboard/admin.html.
 *
 * WHY THIS EXISTS
 * There were two hand-ported copies. They drifted, and the drift was invisible
 * because each page looked right on its own:
 *
 *   - The dashboard tested `source_kind === 'task_note'`, but the producer
 *     (add_task_note) writes kind='task_note', source_kind='task'. So the test
 *     never matched: clicking a task-note notification from the dashboard
 *     navigated to the lead with the task still shut. lead-detail had been
 *     fixed to accept EITHER field; the dashboard never was. This module keeps
 *     lead-detail's rule.
 *   - `kind='system'` rows rendered a 🛠 on the dashboard and no icon at all on
 *     lead-detail — 7 of the 21 rows live at the time of writing.
 *   - @mentions rendered as gold chips on lead-detail and as raw text on the
 *     dashboard. Mentions now render everywhere.
 *
 * THE onclick INTERPOLATION IS GONE, DELIBERATELY
 * Both copies built `onclick="notifOpen('<id>','<contact>',…)"` by string
 * concatenation. NEITHER escaping strategy protected the inner JS string:
 * lead-detail's lpEsc does not escape `'` at all, and the dashboard's
 * escapeHtml turns it into `&#39;` — which the HTML parser decodes back to a
 * bare quote BEFORE the JS in the attribute is parsed. Same hole, two spellings.
 * Nothing in app_notifications exploited it, but a value reaching `link` or
 * `source_id` from anywhere less trusted would have. Rows now carry data-
 * attributes and one delegated listener reads them, so no field is ever parsed
 * as code.
 *
 * USAGE
 *   NotifBell.mount({
 *     client:           async () => supabaseClient,   // required
 *     onError:          (err, msg) => {},             // optional
 *     currentContactId: () => 'uuid' | null,          // optional
 *     shortcuts: { taskNote(id){}, sms(){}, doc(){} } // optional
 *   });
 *
 * `currentContactId` + `shortcuts` are what let lead-detail act in place when
 * the notification belongs to the lead already on screen. A page that omits
 * them (the dashboard) always navigates. Nothing else differs between hosts.
 */
(function () {
  'use strict';

  var LEAD_URL = '/admin/lead-detail';   // absolute: the dashboard lives at /dashboard/
  var POLL_MS = 30000;
  var _timer = null;
  var _opts = null;

  /* Escapes the five characters that matter in both attribute and text position.
   * lead-detail's lpEsc left ' and > alone; this does not. */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderMentions(text) {
    return esc(text).replace(/@([A-Za-z0-9_.\-]+)/g,
      '<span style="color:#C9A84C;font-weight:600;">@$1</span>');
  }

  /* lead-detail's relativeTime — kept over the dashboard's shorter timeAgo
   * because it distinguishes "Yesterday 4:15 PM", which reads better on a list
   * people scan for what happened overnight. */
  function relTime(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr).getTime();
    var diff = Math.floor((Date.now() - d) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 172800) return 'Yesterday ' + (window.RRTime ? window.RRTime.time(dateStr) : '');
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return window.RRTime ? window.RRTime.dateShort(dateStr) : '';
  }

  function fail(err, msg) {
    try { console.warn('[notifications]', msg, err || ''); } catch (_) {}
    if (_opts && typeof _opts.onError === 'function') { try { _opts.onError(err, msg); return; } catch (_) {} }
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2a1a1a;border:1px solid rgba(229,72,77,.5);color:#ff9a9a;padding:9px 16px;border-radius:8px;font-size:12px;z-index:10002;';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  /* The dashboard's client can be set after this script runs, so resolving it is
   * async and allowed to wait. lead-detail's is ready synchronously; its thunk
   * just returns. */
  async function client() {
    if (!_opts || typeof _opts.client !== 'function') return null;
    try { return await _opts.client(); } catch (_) { return null; }
  }

  function box() {
    var b = document.getElementById('notifDropdown');
    if (!b) {
      b = document.createElement('div');
      b.id = 'notifDropdown';
      b.style.cssText = 'position:fixed;z-index:10000;display:none;width:340px;max-height:440px;overflow-y:auto;background:#15140f;border:1px solid rgba(201,168,76,.35);border-radius:10px;box-shadow:0 18px 44px rgba(0,0,0,.6);';
      document.body.appendChild(b);
      b.addEventListener('click', onBoxClick);   // the one delegated listener
      b.addEventListener('mouseover', onBoxHover);
      b.addEventListener('mouseout', onBoxHover);
    }
    return b;
  }
  function hide() { var b = document.getElementById('notifDropdown'); if (b) b.style.display = 'none'; }

  function onBoxHover(e) {
    var row = e.target.closest && e.target.closest('[data-nb-row]');
    if (!row) return;
    row.style.background = e.type === 'mouseover' ? 'rgba(255,255,255,.04)' : (row.dataset.nbBg || 'transparent');
  }

  function onBoxClick(e) {
    if (!e.target.closest) return;
    if (e.target.closest('[data-nb-act="mark-all"]')) { markAll(); return; }
    var row = e.target.closest('[data-nb-row]');
    if (row) open(row.dataset);
  }

  async function refreshCount() {
    try {
      var sb = await client(); if (!sb) return;
      var r = await sb.rpc('notifications_unread_count');
      if (r.error) return;
      var n = Number(r.data) || 0, badge = document.getElementById('notifBadge');
      if (!badge) return;
      if (n > 0) { badge.textContent = n > 99 ? '99+' : String(n); badge.style.display = 'block'; }
      else badge.style.display = 'none';
    } catch (_) {}
  }

  var HEAD = '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);position:sticky;top:0;background:#15140f;">'
    + '<span style="font-size:12px;font-weight:700;color:#C9A84C;">Notifications</span>'
    + '<button type="button" data-nb-act="mark-all" style="background:transparent;border:none;color:#888;font-size:11px;cursor:pointer;font-family:inherit;">Mark all read</button></div>';
  var note = function (txt, colour) {
    return '<div style="padding:14px;color:' + colour + ';font-size:12px;">' + txt + '</div>';
  };

  function icon(kind) {
    var e = kind === 'sms_inbound' ? '💬' : kind === 'doc_uploaded' ? '📄' : kind === 'system' ? '🛠' : '';
    return e ? '<span style="flex-shrink:0;margin-right:1px;">' + e + '</span>' : '';
  }

  async function renderList() {
    var b = box();
    b.innerHTML = HEAD + note('Loading…', '#888');
    try {
      var sb = await client();
      if (!sb) { b.innerHTML = HEAD + note('Client not ready.', '#E5484D'); return; }
      var r = await sb.rpc('notifications_list', { p_limit: 30, p_only_unread: false });
      if (r.error) { fail(r.error, 'Could not load notifications'); b.innerHTML = HEAD + note('Could not load.', '#E5484D'); return; }
      var rows = r.data || [];
      if (!rows.length) {
        b.innerHTML = HEAD + '<div style="padding:20px;text-align:center;color:#888;font-size:12px;">No notifications</div>';
        return;
      }
      b.innerHTML = HEAD + rows.map(function (n) {
        var unread = !n.is_read, bg = unread ? 'rgba(201,168,76,.07)' : 'transparent';
        /* A row is clickable-to-somewhere only when it carries an explicit link
         * or a contact. Monitor/system alerts have contact_id null, and a
         * pointer cursor there advertised a jump that never came. */
        var canNav = !!(n.link || n.contact_id);
        var title = n.link ? 'Open' : (n.contact_id ? 'Open lead' : 'Click to mark read');
        return '<div data-nb-row="1"'
          + ' data-id="' + esc(n.id) + '"'
          + ' data-contact="' + esc(n.contact_id || '') + '"'
          + ' data-source-kind="' + esc(n.source_kind || '') + '"'
          + ' data-source-id="' + esc(n.source_id || '') + '"'
          + ' data-kind="' + esc(n.kind || '') + '"'
          + ' data-link="' + esc(n.link || '') + '"'
          + ' data-nb-bg="' + bg + '"'
          + ' title="' + esc(title) + '"'
          + ' style="padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.05);cursor:' + (canNav ? 'pointer' : 'default') + ';background:' + bg + ';">'
          + '<div style="display:flex;gap:6px;align-items:baseline;">'
          + (unread ? '<span style="flex-shrink:0;width:7px;height:7px;border-radius:50%;background:#C9A84C;display:inline-block;"></span>' : '')
          + icon(n.kind)
          + '<span style="font-size:12px;color:#eee;font-weight:600;">' + esc(n.actor_display || 'Someone') + '</span>'
          + '<span style="margin-left:auto;font-size:10px;color:#777;flex-shrink:0;">' + esc(relTime(n.created_at)) + '</span></div>'
          + '<div style="font-size:11px;color:#bbb;margin-top:2px;">' + renderMentions(n.preview || '') + '</div></div>';
      }).join('');
    } catch (e) { fail(e, 'Could not load notifications'); }
  }

  function toggle(ev) {
    if (ev) ev.stopPropagation();
    var b = box();
    if (b.style.display === 'block') { hide(); return; }
    var bell = document.getElementById('notifBell');
    var rc = bell ? bell.getBoundingClientRect() : { bottom: 48, right: 240 };
    b.style.left = Math.max(8, Math.min(rc.right - 340, window.innerWidth - 348)) + 'px';
    b.style.top = (rc.bottom + 6) + 'px';
    b.style.display = 'block';
    renderList();
  }

  async function open(d) {
    var id = d.id, contactId = d.contact, sourceKind = d.sourceKind,
        sourceId = d.sourceId, kind = d.kind, link = d.link;
    try { var sb = await client(); if (sb) await sb.rpc('notification_mark_read', { p_id: id }); } catch (_) {}
    refreshCount();
    hide();

    /* An explicit target wins over the contact_id rule. "Someone chatted on your
     * video" from a visitor who left no details has no lead to open, but it does
     * name a session /admin/video-chats can read — that was a dead click.
     * Site-relative paths only; anything else is ignored rather than followed. */
    if (link && /^\/[^/]/.test(link)) { window.location.href = link; return; }

    /* lead-detail's rule, not the dashboard's. add_task_note writes
     * kind='task_note' with source_kind='task', so testing source_kind alone
     * never matched and the task never opened. Accept either field. */
    var isTaskNote = !!sourceId && (sourceKind === 'task_note' || kind === 'task_note');
    var isSms = kind === 'sms_inbound';
    var isDoc = kind === 'doc_uploaded';
    var sc = (_opts && _opts.shortcuts) || {};
    var here = null;
    if (_opts && typeof _opts.currentContactId === 'function') {
      try { here = _opts.currentContactId(); } catch (_) { here = null; }
    }

    if (contactId) {
      // Already looking at this lead? Act in place rather than reloading the page.
      if (here && here === contactId) {
        if (isTaskNote && sc.taskNote) { sc.taskNote(sourceId); return; }
        if (isSms && sc.sms) { sc.sms(); return; }
        if (isDoc && sc.doc) { sc.doc(); return; }
        return;   // no shortcut for this kind — we are already where it points
      }
      var hash = isSms ? '#text' : isDoc ? '#documents'
               : (isTaskNote ? '#vatask=' + encodeURIComponent(sourceId) : '');
      window.location.href = LEAD_URL + '?contact_id=' + encodeURIComponent(contactId) + hash;
      return;
    }
    // No contact and no link. A task note can still be opened in place if the
    // host offers it; otherwise marking read was the whole action.
    if (isTaskNote && sc.taskNote) sc.taskNote(sourceId);
  }

  async function markAll() {
    try {
      var sb = await client(); if (!sb) return;
      var r = await sb.rpc('notifications_mark_all_read');
      if (r.error) { fail(r.error, 'Could not mark all read'); return; }
    } catch (e) { fail(e, 'Could not mark all read'); return; }
    refreshCount(); renderList();
  }

  function liveRefresh() {
    refreshCount();
    var b = document.getElementById('notifDropdown');
    if (b && b.style.display === 'block') renderList();
  }

  function mount(opts) {
    _opts = opts || {};
    refreshCount();
    if (_timer) clearInterval(_timer);
    _timer = setInterval(refreshCount, POLL_MS);
    if (!window.__notifLiveBound) {
      window.__notifLiveBound = true;
      // Light real-time: surface new lead replies on tab focus / visibility
      // without a manual reload.
      window.addEventListener('focus', liveRefresh);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) liveRefresh(); });
      document.addEventListener('click', function (e) {
        var b = document.getElementById('notifDropdown');
        if (!b || b.style.display !== 'block') return;
        if (e.target.closest && (e.target.closest('#notifDropdown') || e.target.closest('#notifBell'))) return;
        hide();
      });
    }
  }

  window.NotifBell = { mount: mount, toggle: toggle, refreshCount: refreshCount, markAll: markAll };
  /* Both bells are markup with onclick="notifToggle(event)". Keep that name
   * working rather than editing two more places. */
  window.notifToggle = toggle;
})();
