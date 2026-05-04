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
  var currentView = localStorage.getItem('rr_view_clickup') || 'list';
  var currentSort = localStorage.getItem('rr_sort_clickup') || 'due_asc';
  var calendarRefDate = new Date();
  var selectedIds = new Set();

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
      + '<input type="checkbox" class="ct-select-box" data-action="ct-select-row" data-task-id="' + esc(t.clickup_task_id) + '" aria-label="Select task" />'
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

    // Split by status. ClickUp uses lots of "open-ish" statuses (to do,
    // in progress, blocked, etc.) — anything that isn't a recognized
    // done-state goes in Open.
    var openTasks = tasks.filter(function (t) { return !isDoneStatus(t.status); });
    var doneTasks = tasks.filter(function (t) { return isDoneStatus(t.status); });

    // Section visibility follows the status filter:
    //   'open'      → Open visible, Completed hidden
    //   'complete'  → Open hidden,  Completed visible (auto-expanded)
    //   '' (All)    → both visible, Completed collapsed by default
    var fs = currentFilters.status;
    var showOpen = fs !== 'complete';
    var showDone = fs !== 'open';
    var doneCollapsed = fs !== 'complete';

    var html = '';
    if (showOpen) {
      html += '<div class="ct-section" data-section="open" data-collapsed="false">'
        + '<div class="ct-section-header" data-action="ct-toggle-section">'
        +   '<span class="ct-section-icon">▼</span>'
        +   '<input type="checkbox" class="ct-select-box ct-select-all" data-section="open" aria-label="Select all open" />'
        +   '<span class="ct-section-title">Open</span>'
        +   '<span class="ct-section-count">' + openTasks.length + '</span>'
        + '</div>'
        + '<div class="ct-section-body">'
        + (openTasks.length ? openTasks.map(rowHtml).join('') : '<div class="ct-section-empty">All caught up — no open tasks</div>')
        + '</div>'
        + '</div>';
    }
    if (showDone) {
      html += '<div class="ct-section" data-section="done" data-collapsed="' + (doneCollapsed ? 'true' : 'false') + '">'
        + '<div class="ct-section-header" data-action="ct-toggle-section">'
        +   '<span class="ct-section-icon">▼</span>'
        +   '<input type="checkbox" class="ct-select-box ct-select-all" data-section="done" aria-label="Select all completed" />'
        +   '<span class="ct-section-title">Completed</span>'
        +   '<span class="ct-section-count">' + doneTasks.length + '</span>'
        + '</div>'
        + '<div class="ct-section-body">'
        + (doneTasks.length ? doneTasks.map(rowHtml).join('') : '<div class="ct-section-empty">No completed tasks yet</div>')
        + '</div>'
        + '</div>';
    }
    list.innerHTML = html;
    updateSelectionUI();
  }

  // ── Sort + view dispatch ────────────────────────────────────────
  function sortTasks(tasks) {
    var sorted = tasks.slice();
    var priWeight = { urgent: 1, high: 2, normal: 3, low: 4 };
    sorted.sort(function (a, b) {
      switch (currentSort) {
        case 'due_asc': {
          if (!a.due_date && !b.due_date) return 0;
          if (!a.due_date) return 1;
          if (!b.due_date) return -1;
          return new Date(a.due_date) - new Date(b.due_date);
        }
        case 'due_desc': {
          if (!a.due_date && !b.due_date) return 0;
          if (!a.due_date) return 1;
          if (!b.due_date) return -1;
          return new Date(b.due_date) - new Date(a.due_date);
        }
        case 'created_desc': return new Date(b.fetched_at || 0) - new Date(a.fetched_at || 0);
        case 'created_asc':  return new Date(a.fetched_at || 0) - new Date(b.fetched_at || 0);
        case 'priority':     return (priWeight[a.priority] || 99) - (priWeight[b.priority] || 99);
        case 'title_asc':    return (a.title || '').localeCompare(b.title || '');
        default: return 0;
      }
    });
    return sorted;
  }

  function dispatchRender(tasks) {
    var sorted = sortTasks(tasks || []);
    if (currentView === 'list') renderList(sorted);
    else if (currentView === 'board') renderBoard(sorted);
    else if (currentView === 'calendar') renderCalendar(sorted);
  }

  // ── Board renderer ──────────────────────────────────────────────
  function colKey(t) {
    var s = String(t.status || '').toLowerCase();
    if (s === 'complete' || s === 'closed' || s === 'done') return 'done';
    if (s === 'in progress') return 'inprogress';
    return 'todo';
  }

  function boardCardHtml(t) {
    var due = t.due_date ? new Date(t.due_date) : null;
    var open = !isDoneStatus(t.status);
    var overdue = open && due && due.getTime() < Date.now();
    var dueStr = due ? due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    return '<div class="board-card" draggable="true" data-task-id="' + esc(t.clickup_task_id) + '" data-current-col="' + colKey(t) + '">'
      + '<input type="checkbox" class="ct-select-box board-card-select" data-action="ct-select-row" data-task-id="' + esc(t.clickup_task_id) + '" aria-label="Select task" />'
      + '<div class="board-card-title">' + esc(t.title) + '</div>'
      + '<div class="board-card-meta">'
      +   (t.priority ? '<span class="board-card-pri ' + priorityClass(t.priority) + '">' + esc(t.priority) + '</span>' : '')
      +   (dueStr ? '<span class="board-card-due' + (overdue ? ' is-overdue' : '') + '">' + (overdue ? '⚠ ' : '') + esc(dueStr) + '</span>' : '')
      + '</div>'
      + (t.contact && t.contact.id
          ? '<a class="board-card-contact" href="/admin/lead-detail.html?contact_id=' + esc(t.contact.id) + '" onclick="event.stopPropagation()">' + esc(t.contact.name) + '</a>'
          : '')
      + '</div>';
  }

  function renderBoard(tasks) {
    var board = document.querySelector('[data-target=ct-board]');
    if (!board) return;
    var groups = { todo: [], inprogress: [], done: [] };
    tasks.forEach(function (t) { groups[colKey(t)].push(t); });
    var titles = { todo: 'To Do', inprogress: 'In Progress', done: 'Complete' };
    var cols = ['todo', 'inprogress', 'done'];
    board.innerHTML = cols.map(function (c) {
      return '<div class="board-col" data-col="' + c + '">'
        + '<div class="board-col-header">'
        +   '<span class="board-col-icon"></span>'
        +   '<span>' + titles[c] + '</span>'
        +   '<span class="board-col-count">' + groups[c].length + '</span>'
        + '</div>'
        + '<div class="board-col-body" data-drop-col="' + c + '">'
        +   (groups[c].length === 0
              ? '<div class="board-empty">— Drop tasks here —</div>'
              : groups[c].map(boardCardHtml).join(''))
        + '</div>'
        + '</div>';
    }).join('');
    attachDragHandlers();
    updateSelectionUI();
  }

  function attachDragHandlers() {
    var draggingTaskId = null;
    var draggingFromCol = null;

    [].slice.call(document.querySelectorAll('[data-target=ct-board] .board-card[draggable]')).forEach(function (card) {
      card.addEventListener('dragstart', function (e) {
        draggingTaskId = card.dataset.taskId;
        draggingFromCol = card.dataset.currentCol;
        card.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', draggingTaskId); } catch (err) {}
      });
      card.addEventListener('dragend', function () { card.classList.remove('is-dragging'); });
      card.addEventListener('click', function (e) {
        // Don't open modal when clicking the select checkbox on the card.
        if (e.target.closest('.ct-select-box')) return;
        var task = taskCache.find(function (t) { return t.clickup_task_id === card.dataset.taskId; });
        if (task) openModal(task);
      });
    });

    [].slice.call(document.querySelectorAll('[data-target=ct-board] [data-drop-col]')).forEach(function (col) {
      col.addEventListener('dragover', function (e) { e.preventDefault(); col.classList.add('is-drop-target'); });
      col.addEventListener('dragleave', function () { col.classList.remove('is-drop-target'); });
      col.addEventListener('drop', async function (e) {
        e.preventDefault();
        col.classList.remove('is-drop-target');
        var targetCol = col.dataset.dropCol;
        if (!draggingTaskId || targetCol === draggingFromCol) return;
        var safeId = String(draggingTaskId).replace(/"/g, '\\"');
        var card = document.querySelector('[data-target=ct-board] .board-card[data-task-id="' + safeId + '"]');
        if (card) col.appendChild(card);
        var tid = draggingTaskId;
        try {
          if (targetCol === 'done') {
            await api('/task/complete', { method: 'POST', body: JSON.stringify({ clickup_task_id: tid }) });
          } else if (targetCol === 'todo') {
            await api('/task/reopen', { method: 'POST', body: JSON.stringify({ clickup_task_id: tid }) });
          } else if (targetCol === 'inprogress') {
            await api('/task/update', { method: 'POST', body: JSON.stringify({ clickup_task_id: tid, status: 'in progress' }) });
          }
          await loadTasks();
        } catch (err) {
          alert('Move failed: ' + (err.message || 'unknown'));
          await loadTasks();
        }
      });
    });
  }

  // ── Calendar renderer ──────────────────────────────────────────
  function calDayHtml(d, tasks, today, isOtherMonth) {
    var isToday = d.getTime() === today.getTime();
    var dayKey = d.toISOString().substring(0, 10);
    var visible = tasks.slice(0, 3);
    var overflow = tasks.length - visible.length;
    var pillsHtml = visible.map(function (t) {
      var isDone = isDoneStatus(t.status);
      return '<div class="cal-task-pill ' + priorityClass(t.priority || 'normal') + (isDone ? ' is-done' : '')
        + '" data-task-id="' + esc(t.clickup_task_id) + '" title="' + esc(t.title) + '">' + esc(t.title) + '</div>';
    }).join('');
    return '<div class="cal-day' + (isToday ? ' is-today' : '') + (isOtherMonth ? ' is-other-month' : '') + '" data-date="' + dayKey + '">'
      + '<div class="cal-day-num">' + d.getDate() + '</div>'
      + pillsHtml
      + (overflow > 0 ? '<div class="cal-task-overflow">+' + overflow + ' more</div>' : '')
      + '</div>';
  }

  function renderCalendar(tasks) {
    var cal = document.querySelector('[data-target=ct-calendar]');
    if (!cal) return;
    var ref = new Date(calendarRefDate.getFullYear(), calendarRefDate.getMonth(), 1);
    var monthName = ref.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    var startWeekday = ref.getDay();
    var daysInMonth = new Date(ref.getFullYear(), ref.getMonth() + 1, 0).getDate();
    var today = new Date(); today.setHours(0,0,0,0);

    var tasksByDate = {};
    tasks.forEach(function (t) {
      if (!t.due_date) return;
      var k = new Date(t.due_date).toISOString().substring(0, 10);
      (tasksByDate[k] = tasksByDate[k] || []).push(t);
    });

    var html = '<div class="cal-header">'
      + '<button class="cal-nav-btn" data-action="cal-prev">‹ Prev</button>'
      + '<span class="cal-month-title">' + monthName + '</span>'
      + '<button class="cal-nav-btn" data-action="cal-today">Today</button>'
      + '<button class="cal-nav-btn" data-action="cal-next">Next ›</button>'
      + '</div>'
      + '<div class="cal-grid">'
      + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(function (d) { return '<div class="cal-dow">' + d + '</div>'; }).join('');

    for (var i = 0; i < startWeekday; i++) {
      var d = new Date(ref); d.setDate(d.getDate() - (startWeekday - i));
      html += calDayHtml(d, tasksByDate[d.toISOString().substring(0,10)] || [], today, true);
    }
    for (var day = 1; day <= daysInMonth; day++) {
      var d2 = new Date(ref.getFullYear(), ref.getMonth(), day);
      html += calDayHtml(d2, tasksByDate[d2.toISOString().substring(0,10)] || [], today, false);
    }
    var totalCells = startWeekday + daysInMonth;
    var trailing = (7 - (totalCells % 7)) % 7;
    for (var j = 1; j <= trailing; j++) {
      var d3 = new Date(ref.getFullYear(), ref.getMonth() + 1, j);
      html += calDayHtml(d3, tasksByDate[d3.toISOString().substring(0,10)] || [], today, true);
    }
    html += '</div>';
    cal.innerHTML = html;

    cal.querySelector('[data-action=cal-prev]').addEventListener('click', function () {
      calendarRefDate = new Date(calendarRefDate.getFullYear(), calendarRefDate.getMonth() - 1, 1);
      dispatchRender(taskCache);
    });
    cal.querySelector('[data-action=cal-next]').addEventListener('click', function () {
      calendarRefDate = new Date(calendarRefDate.getFullYear(), calendarRefDate.getMonth() + 1, 1);
      dispatchRender(taskCache);
    });
    cal.querySelector('[data-action=cal-today]').addEventListener('click', function () {
      calendarRefDate = new Date();
      dispatchRender(taskCache);
    });

    [].slice.call(cal.querySelectorAll('.cal-task-pill')).forEach(function (pill) {
      pill.addEventListener('click', function (e) {
        e.stopPropagation();
        var task = taskCache.find(function (t) { return t.clickup_task_id === pill.dataset.taskId; });
        if (task) openModal(task);
      });
    });
    [].slice.call(cal.querySelectorAll('.cal-day')).forEach(function (day) {
      day.addEventListener('click', function () {
        openModal(null);
        var dueInput = document.querySelector('[data-field=ct-due-date]');
        if (dueInput && day.dataset.date) dueInput.value = day.dataset.date;
      });
    });
  }

  // ── View switcher wiring ───────────────────────────────────────
  function syncBodyViewClass() {
    // Read whichever sub-panel is currently visible — that's what the
    // body class should reflect (so the sort dropdown only shows when
    // the *active* sub-panel is in list view).
    var active = document.querySelector('.task-subpanel:not([hidden])');
    document.body.classList.toggle('view-list-active', !!active && active.dataset.currentView === 'list');
  }

  function applyViewToDom() {
    var panel = document.querySelector('[data-subpanel=clickup]');
    if (panel) panel.dataset.currentView = currentView;
    // CSS visibility is driven by data-view on the container — no [hidden] toggling.
    var container = document.querySelector('[data-target=ct-view-container]');
    if (container) container.dataset.view = currentView;
    [].slice.call(document.querySelectorAll('[data-subpanel=clickup] .view-btn')).forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === currentView);
    });
    syncBodyViewClass();
  }
  // Expose so admin-dashboard.js can re-sync after CRM-side view changes.
  window.__rrSyncTasksBodyClass = syncBodyViewClass;

  function wireViewSwitcher() {
    [].slice.call(document.querySelectorAll('[data-subpanel=clickup] .view-btn')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentView = btn.dataset.view;
        localStorage.setItem('rr_view_clickup', currentView);
        applyViewToDom();
        dispatchRender(taskCache);
      });
    });
    var sortSel = document.querySelector('[data-subpanel=clickup] [data-target=ct-sort]');
    if (sortSel) {
      sortSel.value = currentSort;
      sortSel.addEventListener('change', function (e) {
        currentSort = e.target.value;
        localStorage.setItem('rr_sort_clickup', currentSort);
        dispatchRender(taskCache);
      });
    }
    applyViewToDom();
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
      dispatchRender(taskCache);
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
    // Optimistic flip — instant red→green / green→red on the row so the
    // user gets the satisfying click feedback before the network round-trip.
    var safeId = String(taskId).replace(/"/g, '\\"');
    var row = document.querySelector('.ct-row[data-task-id="' + safeId + '"]');
    if (row) row.classList.toggle('is-done');
    try {
      await api(open ? '/task/complete' : '/task/reopen', {
        method: 'POST',
        body: JSON.stringify({ clickup_task_id: taskId }),
      });
      // Brief delay so the green-check satisfaction registers, THEN reload
      // (which moves the row into the right section and refreshes counts).
      setTimeout(function () { loadTasks(); }, 350);
    } catch (e) {
      // Network/auth failure — revert the optimistic flip.
      if (row) row.classList.toggle('is-done');
      alert('Update failed: ' + (e.message || 'unknown'));
    }
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

  // ── Multi-select + bulk actions ─────────────────────────────────
  function updateSelectionUI() {
    [].slice.call(document.querySelectorAll('[data-subpanel=clickup] .ct-row, [data-subpanel=clickup] .board-card')).forEach(function (row) {
      var tid = row.dataset.taskId;
      if (!tid) return;
      var sel = selectedIds.has(tid);
      row.classList.toggle('is-selected', sel);
      var cb = row.querySelector('.ct-select-box');
      if (cb) cb.checked = sel;
    });
    var bar = document.querySelector('[data-target=ct-bulk-bar]');
    if (bar) {
      if (selectedIds.size > 0) {
        bar.hidden = false;
        var countEl = bar.querySelector('[data-target=ct-bulk-count]');
        if (countEl) countEl.textContent = String(selectedIds.size);
      } else {
        bar.hidden = true;
      }
    }
    [].slice.call(document.querySelectorAll('[data-subpanel=clickup] .ct-select-all')).forEach(function (sa) {
      var section = sa.dataset.section;
      var sectionRows = [].slice.call(document.querySelectorAll('.ct-section[data-section="' + section + '"] .ct-row'));
      if (sectionRows.length === 0) { sa.checked = false; sa.indeterminate = false; return; }
      var all = sectionRows.every(function (r) { return selectedIds.has(r.dataset.taskId); });
      var some = sectionRows.some(function (r) { return selectedIds.has(r.dataset.taskId); });
      sa.checked = all;
      sa.indeterminate = !all && some;
    });
  }

  async function bulkApply(perTaskFn) {
    var ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    var bar = document.querySelector('[data-target=ct-bulk-bar]');
    if (bar) bar.style.opacity = '0.6';
    var done = 0, failed = 0;
    for (var i = 0; i < ids.length; i++) {
      try { await perTaskFn(ids[i]); done++; }
      catch (e) { failed++; console.error('[ct-bulk] failed for', ids[i], e); }
    }
    if (bar) bar.style.opacity = '1';
    if (failed > 0) alert(done + ' updated, ' + failed + ' failed. Check console for details.');
    selectedIds.clear();
    await loadTasks();
    updateSelectionUI();
  }

  async function bulkSetDueDate() {
    var date = prompt('Set due date for ' + selectedIds.size + ' task(s) (YYYY-MM-DD), or leave blank to clear:');
    if (date === null) return;
    var isoDate = null;
    if (date.trim()) {
      var d = new Date(date.trim() + 'T09:00:00');
      if (isNaN(d.getTime())) { alert('Invalid date — use YYYY-MM-DD'); return; }
      isoDate = d.toISOString();
    }
    await bulkApply(function (tid) {
      return api('/task/update', { method: 'POST', body: JSON.stringify({ clickup_task_id: tid, due_date: isoDate }) });
    });
  }

  async function bulkSetPriority() {
    var choice = prompt('Set priority for ' + selectedIds.size + ' task(s): urgent / high / normal / low / none');
    if (!choice) return;
    var v = String(choice).trim().toLowerCase();
    if (['urgent','high','normal','low','none'].indexOf(v) === -1) { alert('Invalid priority'); return; }
    var p = v === 'none' ? null : v;
    await bulkApply(function (tid) {
      return api('/task/update', { method: 'POST', body: JSON.stringify({ clickup_task_id: tid, priority: p }) });
    });
  }

  async function bulkAssignContact() {
    var contacts;
    try {
      var res = await fetch(SUPABASE_URL + '/rest/v1/contacts?select=id,first_name,last_name&order=first_name&limit=500', {
        headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY }
      });
      contacts = await res.json();
    } catch (e) { alert('Could not load contacts: ' + (e.message || 'unknown')); return; }
    if (!Array.isArray(contacts)) { alert('Could not load contacts'); return; }
    var lines = contacts.map(function (c, i) {
      var name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || '(unnamed)';
      return (i + 1) + '. ' + name;
    }).join('\n');
    var idx = prompt('Assign ' + selectedIds.size + ' task(s) to which lead?\n0 = unlink (no lead)\n' + lines + '\n\nEnter number:');
    if (idx === null) return;
    var n = parseInt(idx, 10);
    if (isNaN(n) || n < 0 || n > contacts.length) { alert('Invalid choice'); return; }
    var cid = n === 0 ? null : contacts[n - 1].id;
    await bulkApply(function (tid) {
      return api('/task/relink', { method: 'POST', body: JSON.stringify({ clickup_task_id: tid, contact_id: cid }) });
    });
  }

  async function bulkComplete() {
    if (!confirm('Mark ' + selectedIds.size + ' task(s) complete?')) return;
    await bulkApply(function (tid) {
      return api('/task/complete', { method: 'POST', body: JSON.stringify({ clickup_task_id: tid }) });
    });
  }

  async function bulkReopen() {
    if (!confirm('Reopen ' + selectedIds.size + ' task(s)?')) return;
    await bulkApply(function (tid) {
      return api('/task/reopen', { method: 'POST', body: JSON.stringify({ clickup_task_id: tid }) });
    });
  }

  async function bulkDelete() {
    if (!confirm('PERMANENTLY DELETE ' + selectedIds.size + ' task(s) from ClickUp? Cannot be undone.')) return;
    await bulkApply(function (tid) {
      return api('/task/delete', { method: 'POST', body: JSON.stringify({ clickup_task_id: tid }) });
    });
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
        // Body class follows whichever sub-panel just became visible.
        syncBodyViewClass();
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

    // Delegated row click + complete toggle + section accordion. Scoped to
    // #tab-tasks so we don't intercept clicks elsewhere on the page.
    var tasksTab = document.getElementById('tab-tasks');
    if (tasksTab) {
      tasksTab.addEventListener('click', function (e) {
        // Bulk-bar actions
        if (e.target.closest('[data-action=ct-bulk-clear]')) { selectedIds.clear(); updateSelectionUI(); return; }
        if (e.target.closest('[data-action=ct-bulk-due]')) { bulkSetDueDate(); return; }
        if (e.target.closest('[data-action=ct-bulk-priority]')) { bulkSetPriority(); return; }
        if (e.target.closest('[data-action=ct-bulk-contact]')) { bulkAssignContact(); return; }
        if (e.target.closest('[data-action=ct-bulk-complete]')) { bulkComplete(); return; }
        if (e.target.closest('[data-action=ct-bulk-reopen]')) { bulkReopen(); return; }
        if (e.target.closest('[data-action=ct-bulk-delete]')) { bulkDelete(); return; }

        // Select-all in section header — checked BEFORE section toggle so the
        // checkbox click doesn't also collapse the section.
        var selectAll = e.target.closest('.ct-select-all');
        if (selectAll) {
          e.stopPropagation();
          var sec = selectAll.dataset.section;
          var sectionRows = [].slice.call(document.querySelectorAll('.ct-section[data-section="' + sec + '"] .ct-row'));
          sectionRows.forEach(function (r) {
            if (selectAll.checked) selectedIds.add(r.dataset.taskId);
            else selectedIds.delete(r.dataset.taskId);
          });
          updateSelectionUI();
          return;
        }

        // Per-row select checkbox
        var selBox = e.target.closest('[data-action=ct-select-row]');
        if (selBox) {
          e.stopPropagation();
          var tid = selBox.dataset.taskId;
          if (selBox.checked) selectedIds.add(tid);
          else selectedIds.delete(tid);
          updateSelectionUI();
          return;
        }

        // Section accordion toggle — checked first so it doesn't get
        // pre-empted by the row handlers below.
        var sectionToggle = e.target.closest('[data-action=ct-toggle-section]');
        if (sectionToggle) {
          var section = sectionToggle.closest('.ct-section');
          if (section) {
            section.dataset.collapsed = section.dataset.collapsed === 'true' ? 'false' : 'true';
          }
          return;
        }
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

    wireViewSwitcher();

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
