/**
 * ClickUp Tasks subpage — sub-tab inside Dashboard Tasks.
 *
 * Backend: clickup-bridge v5 (no JWT). Endpoints used:
 *   GET  /tasks?status=open&due=overdue&priority=high&contact_id=X&q=...&include_contact=1&limit=300
 *        → { tasks: [...], count, counts: { total, open, overdue, today, unlinked, by_priority } }
 *   GET  /contacts → { contacts: [{id, name}] } (only contacts that have tasks)
 *   POST /task        body: { title, description, priority, due_date, contact_id }
 *   POST /task/update body: { clickup_task_id, title?, description?, priority?, due_date? }
 *   POST /task/complete body: { clickup_task_id }
 *   POST /task/reopen   body: { clickup_task_id }
 *   POST /task/relink   body: { clickup_task_id, contact_id }
 *   POST /task/delete   body: { clickup_task_id }
 *   POST /sync-pull (no body) → { synced, ... }
 *
 * Self-firing on hashchange to #tasks (matches the Insights/Calendar
 * pattern so it doesn't depend on the SPA's renderActiveTab dashboardData
 * gate). Idempotent — wireOnce flag + per-call refresh.
 */
(function () {
  'use strict';

  var SUPABASE_URL = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_URL) || 'https://ljywhvbmsibwnssxpesh.supabase.co';
  var ANON_KEY = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_ANON_KEY) || '';
  var BASE = SUPABASE_URL + '/functions/v1/clickup-bridge';

  var initialized = false;
  var taskCache = []; // last loaded list — used to fill the edit modal without re-fetching
  var currentFilters = { status: 'open', due: '', priority: '', contact_id: '', q: '' };

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Standardized fetch wrapper. Swallows the raw text on non-OK so the caller
  // gets a useful error message ("HTTP 500: ClickUp API error: ...") rather
  // than a generic "fetch failed".
  async function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign(
      { 'Content-Type': 'application/json', 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY },
      opts.headers || {}
    );
    var res = await fetch(BASE + path, Object.assign({}, opts, { headers: headers }));
    if (!res.ok) {
      var body = '';
      try { body = await res.text(); } catch (e) {}
      throw new Error(res.status + (body ? ': ' + body.slice(0, 150) : ''));
    }
    return res.json();
  }

  function buildQuery() {
    var p = new URLSearchParams();
    if (currentFilters.status) p.set('status', currentFilters.status);
    if (currentFilters.due) p.set('due', currentFilters.due);
    if (currentFilters.priority) p.set('priority', currentFilters.priority);
    if (currentFilters.contact_id) p.set('contact_id', currentFilters.contact_id);
    if (currentFilters.q) p.set('q', currentFilters.q);
    p.set('include_contact', '1');
    p.set('limit', '300');
    return p.toString();
  }

  function fmtDue(due) {
    if (!due) return 'No due date';
    var d = new Date(due);
    if (isNaN(d.getTime())) return 'No due date';
    var opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('en-US', opts);
  }

  function isDoneStatus(s) {
    s = String(s || '').toLowerCase();
    return s === 'complete' || s === 'closed' || s === 'done';
  }

  function priorityClass(p) {
    if (p === 'urgent') return 'pri-urgent';
    if (p === 'high') return 'pri-high';
    if (p === 'low') return 'pri-low';
    if (p === 'normal') return 'pri-normal';
    return '';
  }

  // ── Render ──────────────────────────────────────────────────────
  function rowHtml(t) {
    var due = t.due_date ? new Date(t.due_date) : null;
    var open = !isDoneStatus(t.status);
    var overdue = open && due && due.getTime() < Date.now();
    var dueStr = fmtDue(t.due_date);
    var contactCell = t.contact && t.contact.id
      ? '<a class="ct-contact" href="/admin/lead-detail.html?contact_id=' + esc(t.contact.id) + '" onclick="event.stopPropagation()">' + esc(t.contact.name) + '</a>'
      : '<span class="ct-unlinked">No lead linked</span>';
    return '<div class="ct-row' + (overdue ? ' is-overdue' : '') + (open ? '' : ' is-done') + '" data-task-id="' + esc(t.clickup_task_id) + '">'
      + '<button class="ct-checkbox" data-action="ct-toggle-complete" data-task-id="' + esc(t.clickup_task_id) + '" data-current="' + esc(t.status || '') + '" title="' + (open ? 'Mark complete' : 'Reopen') + '">'
      +   (open ? '○' : '✓')
      + '</button>'
      + '<div class="ct-row-main" data-action="ct-edit" data-task-id="' + esc(t.clickup_task_id) + '">'
      +   '<div class="ct-row-title">' + esc(t.title) + '</div>'
      +   '<div class="ct-row-meta">'
      +     '<span class="ct-status">' + esc(t.status || 'to do') + '</span>'
      +     (t.priority ? '<span class="ct-pri ' + priorityClass(t.priority) + '">' + esc(t.priority) + '</span>' : '')
      +     '<span class="ct-due' + (overdue ? ' is-overdue' : '') + '">' + (overdue ? '⚠ ' : '') + esc(dueStr) + '</span>'
      +     contactCell
      +   '</div>'
      + '</div>'
      + '<div class="ct-row-actions">'
      +   '<a class="btn-icon-link" href="' + esc(t.url) + '" target="_blank" rel="noopener" title="Open in ClickUp" onclick="event.stopPropagation()">↗</a>'
      + '</div>'
      + '</div>';
  }

  function renderList(tasks) {
    var list = document.querySelector('[data-target=ct-list]');
    if (!list) return;
    if (!tasks || !tasks.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">🎉</div><h4>No tasks match your filter</h4><p>Try a different status or due window</p></div>';
      return;
    }
    list.innerHTML = tasks.map(rowHtml).join('');
  }

  function updateChipCounts(counts) {
    counts = counts || {};
    var setChip = function (key, n) {
      var el = document.querySelector('[data-chip-count="' + key + '"]');
      if (el) el.textContent = String(n || 0);
    };
    setChip('open', counts.open);
    setChip('overdue', counts.overdue);
    setChip('today', counts.today);
  }

  function updateSubtabBadge(openCount) {
    var badge = document.querySelector('[data-target=ct-subtab-count]');
    if (!badge) return;
    if (openCount && openCount > 0) {
      badge.textContent = String(openCount);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  // ── Loaders ─────────────────────────────────────────────────────
  async function loadTasks() {
    var list = document.querySelector('[data-target=ct-list]');
    if (!list) return;
    list.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i> Loading…</div>';
    try {
      var data = await api('/tasks?' + buildQuery());
      taskCache = data.tasks || [];
      renderList(taskCache);
      updateChipCounts(data.counts);
      updateSubtabBadge((data.counts && data.counts.open) || 0);
    } catch (e) {
      console.error('[ct] tasks load failed:', e);
      list.innerHTML = '<div class="error-state">Failed: ' + esc(e.message || 'unknown') + '</div>';
    }
  }

  async function loadContactsDropdowns() {
    // Filter dropdown: use /contacts (only those with tasks) so the menu is short.
    try {
      var data = await api('/contacts');
      var contacts = (data && data.contacts) || [];
      var filterSel = document.querySelector('[data-target=ct-contact-filter]');
      if (filterSel) {
        filterSel.innerHTML = '<option value="">All leads</option>'
          + '<option value="unlinked">— Unlinked tasks —</option>'
          + contacts.map(function (c) {
            return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
          }).join('');
      }
    } catch (e) { console.warn('[ct] contacts (filter) load failed:', e); }

    // Modal dropdown: needs ALL contacts so the user can link a brand-new
    // task to any lead, not just ones that already have ClickUp tasks.
    try {
      var res = await fetch(SUPABASE_URL + '/rest/v1/contacts?select=id,first_name,last_name&order=first_name&limit=500', {
        headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY }
      });
      var rows = await res.json();
      if (!Array.isArray(rows)) return;
      var modalSel = document.querySelector('[data-field=ct-contact]');
      if (modalSel) {
        modalSel.innerHTML = '<option value="">— No lead —</option>'
          + rows.map(function (r) {
            var name = ((r.first_name || '') + ' ' + (r.last_name || '')).trim() || '(unnamed)';
            return '<option value="' + esc(r.id) + '">' + esc(name) + '</option>';
          }).join('');
      }
    } catch (e) { console.warn('[ct] contacts (modal) load failed:', e); }
  }

  // ── Modal (create + edit) ───────────────────────────────────────
  function openModal(task) {
    var modal = document.querySelector('[data-target=ct-modal]');
    if (!modal) return;
    var titleEl = document.querySelector('[data-field=ct-modal-title]');
    var deleteBtn = document.querySelector('[data-action=ct-delete]');
    var titleInput = document.querySelector('[data-field=ct-title]');

    if (task) {
      titleEl.textContent = 'Edit ClickUp task';
      document.querySelector('[data-field=ct-edit-id]').value = task.clickup_task_id;
      titleInput.value = task.title || '';
      var desc = (task.raw && task.raw.description) || (task.raw && task.raw.text_content) || '';
      document.querySelector('[data-field=ct-description]').value = desc;
      document.querySelector('[data-field=ct-priority]').value = task.priority || 'none';
      document.querySelector('[data-field=ct-due-date]').value = task.due_date
        ? new Date(task.due_date).toISOString().substring(0, 10) : '';
      document.querySelector('[data-field=ct-contact]').value = task.contact_id || '';
      if (deleteBtn) deleteBtn.hidden = false;
    } else {
      titleEl.textContent = 'New ClickUp task';
      document.querySelector('[data-field=ct-edit-id]').value = '';
      titleInput.value = '';
      document.querySelector('[data-field=ct-description]').value = '';
      document.querySelector('[data-field=ct-priority]').value = 'normal';
      document.querySelector('[data-field=ct-due-date]').value = '';
      document.querySelector('[data-field=ct-contact]').value = '';
      if (deleteBtn) deleteBtn.hidden = true;
    }
    modal.hidden = false;
    setTimeout(function () { titleInput.focus(); }, 50);
  }

  function closeModal() {
    var modal = document.querySelector('[data-target=ct-modal]');
    if (modal) modal.hidden = true;
  }

  async function saveTask() {
    var editId = document.querySelector('[data-field=ct-edit-id]').value;
    var title = document.querySelector('[data-field=ct-title]').value.trim();
    if (!title) { alert('Title required'); return; }
    var description = document.querySelector('[data-field=ct-description]').value.trim() || null;
    var priorityRaw = document.querySelector('[data-field=ct-priority]').value;
    var priority = priorityRaw === 'none' ? null : priorityRaw;
    var dueDateStr = document.querySelector('[data-field=ct-due-date]').value;
    // Force a 9 AM local-time anchor so toISOString gives a sensible date for
    // the ClickUp API (which uses ms since epoch). Otherwise YYYY-MM-DD parses
    // to UTC midnight and may render on the wrong day in negative-offset zones.
    var dueIso = null;
    if (dueDateStr) {
      var d = new Date(dueDateStr + 'T09:00:00');
      if (!isNaN(d.getTime())) dueIso = d.toISOString();
    }
    var contactId = document.querySelector('[data-field=ct-contact]').value || null;

    var saveBtn = document.querySelector('[data-action=ct-save]');
    var origText = saveBtn.textContent;
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

    try {
      if (editId) {
        // Update + relink in parallel-ish. Update first, then relink only if
        // the contact_id actually changed (cached row's contact_id vs new).
        await api('/task/update', {
          method: 'POST',
          body: JSON.stringify({
            clickup_task_id: editId,
            title: title,
            description: description,
            priority: priority,
            due_date: dueIso,
          }),
        });
        var cached = taskCache.find(function (t) { return t.clickup_task_id === editId; });
        var prevContactId = cached ? (cached.contact_id || null) : null;
        if ((prevContactId || null) !== (contactId || null)) {
          await api('/task/relink', {
            method: 'POST',
            body: JSON.stringify({ clickup_task_id: editId, contact_id: contactId }),
          });
        }
      } else {
        await api('/task', {
          method: 'POST',
          body: JSON.stringify({
            title: title,
            description: description,
            priority: priority,
            due_date: dueIso,
            contact_id: contactId,
          }),
        });
      }
      closeModal();
      await loadTasks();
    } catch (e) {
      alert('Save failed: ' + (e.message || 'unknown'));
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = origText;
    }
  }

  async function deleteTask() {
    var editId = document.querySelector('[data-field=ct-edit-id]').value;
    if (!editId) return;
    if (!confirm('Delete this task from ClickUp permanently? This cannot be undone.')) return;
    try {
      await api('/task/delete', {
        method: 'POST',
        body: JSON.stringify({ clickup_task_id: editId }),
      });
      closeModal();
      await loadTasks();
    } catch (e) { alert('Delete failed: ' + (e.message || 'unknown')); }
  }

  async function toggleComplete(taskId, currentStatus) {
    var open = !isDoneStatus(currentStatus);
    try {
      await api(open ? '/task/complete' : '/task/reopen', {
        method: 'POST',
        body: JSON.stringify({ clickup_task_id: taskId }),
      });
      await loadTasks();
    } catch (e) { alert('Update failed: ' + (e.message || 'unknown')); }
  }

  async function syncNow() {
    var btn = document.querySelector('[data-action=ct-sync-now]');
    var origText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
    try {
      var result = await api('/sync-pull', { method: 'POST' });
      if (btn) btn.textContent = '✓ Synced ' + (result.synced != null ? result.synced : '');
      setTimeout(function () { if (btn) { btn.textContent = origText; btn.disabled = false; } }, 2000);
      await loadTasks();
    } catch (e) {
      if (btn) btn.textContent = '✗ Failed';
      setTimeout(function () { if (btn) { btn.textContent = origText; btn.disabled = false; } }, 2000);
    }
  }

  // ── Wiring (idempotent) ─────────────────────────────────────────
  function init() {
    if (initialized) return;
    if (!document.querySelector('[data-target=ct-list]')) return;
    initialized = true;

    // Sub-tab switching (CRM ↔ ClickUp)
    [].slice.call(document.querySelectorAll('.task-subtab')).forEach(function (tab) {
      tab.addEventListener('click', function () {
        [].slice.call(document.querySelectorAll('.task-subtab')).forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        [].slice.call(document.querySelectorAll('.task-subpanel')).forEach(function (p) {
          p.hidden = p.dataset.subpanel !== tab.dataset.subtab;
        });
        if (tab.dataset.subtab === 'clickup') loadTasks();
      });
    });

    // Status chips (single-select, can clear)
    [].slice.call(document.querySelectorAll('[data-filter-status]')).forEach(function (chip) {
      chip.addEventListener('click', function () {
        [].slice.call(document.querySelectorAll('[data-filter-status]')).forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        currentFilters.status = chip.dataset.filterStatus;
        loadTasks();
      });
    });

    // Due chips (single-select, click-again clears)
    [].slice.call(document.querySelectorAll('[data-filter-due]')).forEach(function (chip) {
      chip.addEventListener('click', function () {
        var wasActive = chip.classList.contains('active');
        [].slice.call(document.querySelectorAll('[data-filter-due]')).forEach(function (c) { c.classList.remove('active'); });
        if (!wasActive) chip.classList.add('active');
        else {
          // Re-activate the "Any time" empty-due chip when nothing else is.
          var anyChip = document.querySelector('[data-filter-due=""]');
          if (anyChip) anyChip.classList.add('active');
        }
        currentFilters.due = wasActive ? '' : chip.dataset.filterDue;
        loadTasks();
      });
    });

    var priSel = document.querySelector('[data-target=ct-priority-filter]');
    if (priSel) priSel.addEventListener('change', function (e) {
      currentFilters.priority = e.target.value;
      loadTasks();
    });

    var contactSel = document.querySelector('[data-target=ct-contact-filter]');
    if (contactSel) contactSel.addEventListener('change', function (e) {
      currentFilters.contact_id = e.target.value;
      loadTasks();
    });

    var searchInput = document.querySelector('[data-target=ct-search]');
    if (searchInput) {
      var searchTimer = null;
      searchInput.addEventListener('input', function (e) {
        if (searchTimer) clearTimeout(searchTimer);
        var v = e.target.value;
        searchTimer = setTimeout(function () {
          currentFilters.q = v;
          loadTasks();
        }, 300);
      });
    }

    var syncBtn = document.querySelector('[data-action=ct-sync-now]');
    if (syncBtn) syncBtn.addEventListener('click', syncNow);

    var newBtn = document.querySelector('[data-action=ct-new-task]');
    if (newBtn) newBtn.addEventListener('click', function () { openModal(null); });

    var saveBtn = document.querySelector('[data-action=ct-save]');
    if (saveBtn) saveBtn.addEventListener('click', saveTask);

    var deleteBtn = document.querySelector('[data-action=ct-delete]');
    if (deleteBtn) deleteBtn.addEventListener('click', deleteTask);

    [].slice.call(document.querySelectorAll('[data-action=ct-modal-close]')).forEach(function (b) {
      b.addEventListener('click', closeModal);
    });
    var modalRoot = document.querySelector('[data-target=ct-modal]');
    if (modalRoot) modalRoot.addEventListener('click', function (e) {
      if (e.target === modalRoot) closeModal();
    });

    // Delegated row click + complete toggle. Inside #tab-tasks only so we
    // don't catch clicks elsewhere on the page.
    var tasksTab = document.getElementById('tab-tasks');
    if (tasksTab) {
      tasksTab.addEventListener('click', function (e) {
        var completeBtn = e.target.closest('[data-action=ct-toggle-complete]');
        if (completeBtn) {
          e.stopPropagation();
          toggleComplete(completeBtn.dataset.taskId, completeBtn.dataset.current);
          return;
        }
        var editTrigger = e.target.closest('[data-action=ct-edit]');
        if (editTrigger) {
          var taskId = editTrigger.dataset.taskId;
          var task = taskCache.find(function (t) { return t.clickup_task_id === taskId; });
          if (task) openModal(task);
        }
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var modal = document.querySelector('[data-target=ct-modal]');
      if (modal && !modal.hidden) closeModal();
    });

    loadContactsDropdowns();
    // Pre-fetch open count for the sub-tab badge even if user is on CRM tab
    api('/tasks?status=open&include_contact=0&limit=1').then(function (d) {
      updateSubtabBadge((d && d.counts && d.counts.open) || 0);
    }).catch(function () {});
  }

  function maybeAutoInit() {
    if (location.hash !== '#tasks' && location.hash !== '#dashboard') return;
    setTimeout(init, 60);
  }

  window.initClickupTasks = init;
  window.addEventListener('hashchange', maybeAutoInit);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeAutoInit);
  } else {
    maybeAutoInit();
  }
})();
