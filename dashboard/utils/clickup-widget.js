/**
 * ClickUp "Today's Tasks" dashboard widget — self-firing.
 *
 * Reads from the cached clickup-bridge endpoint (no JWT, anon-readable).
 * Splits results into Overdue (red) + Due Today (purple) sections.
 * Each row is a link that opens the task in ClickUp in a new tab.
 *
 * Init pattern matches insights.js / calendar.js — self-fires on
 * hashchange to #overview and on DOMContentLoaded so it doesn't depend
 * on the SPA's renderOverview() dispatcher (which is gated by
 * dashboardData being loaded).
 */
(function () {
  'use strict';

  var SUPABASE_URL = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_URL) || 'https://ljywhvbmsibwnssxpesh.supabase.co';
  var ANON_KEY = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_ANON_KEY) || '';
  var lastLoadedAt = 0;
  var IN_FLIGHT_MS = 60000; // throttle re-loads to once a minute

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function priorityClass(p) {
    if (p === 'urgent') return 'pri-urgent';
    if (p === 'high') return 'pri-high';
    if (p === 'low') return 'pri-low';
    return ''; // normal / null → default purple
  }

  function taskRowHtml(t, isOverdue) {
    var contact = t.contact_name || (t.contact && t.contact_name) || '';
    var priLabel = t.priority || 'normal';
    return '<a href="' + esc(t.url) + '" target="_blank" rel="noopener" class="cu-task' + (isOverdue ? ' is-overdue' : '') + '">'
      + '<span class="cu-task-title">' + esc(t.title) + '</span>'
      + (contact ? '<span class="cu-task-contact">' + esc(contact) + '</span>' : '')
      + '<span class="cu-task-pri ' + priorityClass(t.priority) + '">' + esc(priLabel) + '</span>'
      + '</a>';
  }

  async function loadTodaysClickupTasks() {
    var target = document.querySelector('[data-target=clickup-today-widget]');
    if (!target) return;
    // Throttle re-loads triggered by repeated #overview hash entries.
    if (Date.now() - lastLoadedAt < IN_FLIGHT_MS && target.dataset.loaded === '1') return;
    target.innerHTML = '<div class="cu-mini-loading">Loading…</div>';
    try {
      var res = await fetch(SUPABASE_URL + '/functions/v1/clickup-bridge/tasks?status=open&limit=20', {
        headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY }
      });
      if (!res.ok) throw new Error(res.status);
      var data = await res.json();
      var tasks = (data && data.tasks) || [];

      var todayStr = new Date().toDateString();
      var now = Date.now();
      var dueToday = tasks.filter(function (t) {
        return t.due_date && new Date(t.due_date).toDateString() === todayStr;
      });
      var overdue = tasks.filter(function (t) {
        if (!t.due_date) return false;
        var d = new Date(t.due_date);
        return d.getTime() < now && d.toDateString() !== todayStr;
      });

      if (!dueToday.length && !overdue.length) {
        target.innerHTML = '<div class="cu-mini-empty">🎉 No tasks due today</div>';
        target.dataset.loaded = '1';
        lastLoadedAt = Date.now();
        return;
      }

      var html = '';
      if (overdue.length) {
        html += '<div class="cu-section">'
          + '<div class="cu-section-label is-overdue">⚠ Overdue (' + overdue.length + ')</div>'
          + overdue.slice(0, 5).map(function (t) { return taskRowHtml(t, true); }).join('')
          + '</div>';
      }
      if (dueToday.length) {
        html += '<div class="cu-section">'
          + '<div class="cu-section-label">Due Today (' + dueToday.length + ')</div>'
          + dueToday.map(function (t) { return taskRowHtml(t, false); }).join('')
          + '</div>';
      }
      target.innerHTML = html;
      target.dataset.loaded = '1';
      lastLoadedAt = Date.now();
    } catch (e) {
      console.warn('[clickup-widget] load failed:', e);
      target.innerHTML = '<div class="cu-mini-empty">ClickUp unavailable</div>';
    }
  }

  window.loadClickupTodayWidget = loadTodaysClickupTasks;

  function maybeAutoInit() {
    // The Overview tab uses hash="" (default) OR "#overview". Either
    // counts as "show the dashboard widget."
    var h = location.hash;
    if (h && h !== '#overview' && h !== '#') return;
    setTimeout(loadTodaysClickupTasks, 80);
  }

  window.addEventListener('hashchange', maybeAutoInit);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeAutoInit);
  } else {
    maybeAutoInit();
  }
})();
