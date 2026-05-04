/**
 * Insights tab module — replaces the old Chart.js Analytics dashboard.
 *
 * Renders the deployed insights-data v2 edge function output:
 *   - Top overview strip (always visible) with 8 KPI cards
 *   - 5 sub-tabs: money / funnel / real_estate / marketing / activity
 *   - Each sub-tab renders KPIs + SVG charts + tables
 *
 * Init is lazy + idempotent — admin-dashboard.js's `case "analytics"` calls
 * window.initInsights() when the user clicks the Insights nav button. The
 * module remembers it's been wired and only re-fetches data on subsequent
 * activations (range/tab clicks fetch on demand).
 */
(function () {
  'use strict';

  var SUPABASE_URL = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_URL) || 'https://ljywhvbmsibwnssxpesh.supabase.co';
  var ANON_KEY = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_ANON_KEY) || '';

  var currentReport = 'money';
  var currentRange = '90d';
  var wired = false;
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

  // Preferred admin-session token; falls back to anon. The deployed function
  // accepts either, but using the session lets the server log/auth properly.
  async function fetchInsights(report, range) {
    var headers = { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY };
    var client = getClient();
    if (client) {
      try {
        var sess = await client.auth.getSession();
        var token = sess && sess.data && sess.data.session && sess.data.session.access_token;
        if (token) headers.Authorization = 'Bearer ' + token;
      } catch (e) { /* anon fallback */ }
    }
    var url = SUPABASE_URL + '/functions/v1/insights-data?report=' + encodeURIComponent(report)
      + (range ? '&range=' + encodeURIComponent(range) : '');
    var res = await fetch(url, { headers: headers });
    if (!res.ok) {
      var body = '';
      try { body = await res.text(); } catch (e) {}
      throw new Error('insights-data ' + res.status + (body ? ': ' + body.slice(0, 120) : ''));
    }
    return res.json();
  }

  function kpiCardHtml(k) {
    var accent = k.accent || 'default';
    return '<div class="insights-kpi-card kpi-' + esc(accent) + '">'
      + '<div class="insights-kpi-label">' + esc(k.label) + '</div>'
      + '<div class="insights-kpi-value">' + esc(String(k.value)) + '</div>'
      + (k.sub ? '<div class="insights-kpi-sub">' + esc(k.sub) + '</div>' : '')
      + '</div>';
  }

  function renderKpis(kpis, target) {
    if (!kpis || !kpis.length) {
      target.innerHTML = '<div class="insights-kpi-card"><div class="insights-kpi-label">No data</div><div class="insights-kpi-value">—</div></div>';
      return;
    }
    target.innerHTML = kpis.map(kpiCardHtml).join('');
  }

  function tableHtml(t) {
    return '<div class="insights-table-card" data-table-name="' + esc(t.name) + '">'
      + '<div class="insights-table-header">'
      +   '<h3 class="insights-table-title">' + esc(t.title) + '</h3>'
      +   '<button class="insights-icon-btn" data-action="export-table" data-table="' + esc(t.name) + '" title="Export this table to CSV"><i class="fas fa-download"></i></button>'
      + '</div>'
      + '<div class="insights-table-scroll">'
      +   '<table class="insights-data-table">'
      +     '<thead><tr>' + (t.columns || []).map(function (c) {
            return '<th>' + esc(String(c).replace(/_/g, ' ')) + '</th>';
          }).join('') + '</tr></thead>'
      +     '<tbody>' + ((!t.rows || !t.rows.length)
            ? '<tr><td colspan="' + (t.columns || []).length + '" class="insights-empty-row">No data in range</td></tr>'
            : t.rows.map(function (row) {
                return '<tr>' + (t.columns || []).map(function (c) {
                  var v = row[c];
                  return '<td>' + esc(v == null ? '—' : String(v)) + '</td>';
                }).join('') + '</tr>';
              }).join('')) + '</tbody>'
      +   '</table>'
      + '</div>'
      + '</div>';
  }

  function chartCardHtml(s) {
    // Stash data on the element via dataset so renderChart can read it after
    // the DOM lands. JSON.stringify needs to survive HTML attribute escaping
    // — esc() handles &/<>/"/'.
    return '<div class="insights-chart-card" data-chart="' + esc(s.name) + '">'
      + '<h3 class="insights-chart-title">' + esc(s.title) + '</h3>'
      + '<div class="insights-chart-body" data-chart-type="' + esc(s.type || 'bar') + '" data-format="' + esc(s.format || '') + '" data-chart-data="' + esc(JSON.stringify(s.data || [])) + '"></div>'
      + '</div>';
  }

  function renderChart(el) {
    var data;
    try { data = JSON.parse(el.dataset.chartData); }
    catch (e) { el.innerHTML = '<div class="insights-chart-empty">Bad data</div>'; return; }
    var type = el.dataset.chartType || 'bar';
    var format = el.dataset.format || '';
    if (!data || !data.length) { el.innerHTML = '<div class="insights-chart-empty">No data in range</div>'; return; }

    var w = el.offsetWidth || 600;
    var h = 220;
    var pad = { top: 20, right: 20, bottom: 50, left: 60 };
    var cw = w - pad.left - pad.right;
    var ch = h - pad.top - pad.bottom;
    var maxVal = Math.max.apply(null, data.map(function (d) { return d.value || 0; })) || 1;

    function fmt(v) {
      if (format === 'currency') return '$' + Number(v).toLocaleString();
      if (format === 'percent') return Number(v).toFixed(1) + '%';
      return Number(v).toLocaleString();
    }
    function compactNum(v) {
      var n = Number(v);
      if (!isFinite(n)) return '';
      if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
      if (Math.abs(n) >= 1000) return Math.round(n / 1000) + 'k';
      return String(n);
    }

    var parts = ['<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">'];
    parts.push('<text x="' + (pad.left - 8) + '" y="' + (pad.top + 4) + '" fill="#888" font-size="10" text-anchor="end">' + fmt(maxVal) + '</text>');
    parts.push('<text x="' + (pad.left - 8) + '" y="' + (pad.top + ch) + '" fill="#888" font-size="10" text-anchor="end">0</text>');

    if (type === 'line') {
      var pts = data.map(function (d, i) {
        var x = pad.left + (i / Math.max(data.length - 1, 1)) * cw;
        var y = pad.top + ch - ((d.value || 0) / maxVal) * ch;
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      parts.push('<polyline points="' + pts + '" fill="none" stroke="#C9A84C" stroke-width="2.5"/>');
      data.forEach(function (d, i) {
        var x = pad.left + (i / Math.max(data.length - 1, 1)) * cw;
        var y = pad.top + ch - ((d.value || 0) / maxVal) * ch;
        parts.push('<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3" fill="#C9A84C"><title>' + esc(d.label) + ': ' + fmt(d.value) + '</title></circle>');
      });
      var stride = data.length > 14 ? Math.ceil(data.length / 8) : 1;
      data.forEach(function (d, i) {
        if (i % stride !== 0 && i !== data.length - 1) return;
        var x = pad.left + (i / Math.max(data.length - 1, 1)) * cw;
        parts.push('<text x="' + x.toFixed(1) + '" y="' + (h - 8) + '" fill="#888" font-size="10" text-anchor="middle">' + esc(String(d.label)) + '</text>');
      });
    } else {
      var slot = cw / data.length;
      var barW = Math.max(8, slot - 6);
      data.forEach(function (d, i) {
        var x = pad.left + i * slot + (slot - barW) / 2;
        var v = d.value || 0;
        var bh = (v / maxVal) * ch;
        var y = pad.top + ch - bh;
        parts.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="#C9A84C" rx="2"><title>' + esc(d.label) + ': ' + fmt(v) + '</title></rect>');
        var labelStride = data.length > 14 ? Math.ceil(data.length / 8) : 1;
        if (i % labelStride === 0 || i === data.length - 1) {
          parts.push('<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (h - 8) + '" fill="#888" font-size="10" text-anchor="middle">' + esc(String(d.label).substring(0, 10)) + '</text>');
        }
        if (v > 0) {
          parts.push('<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (y - 4).toFixed(1) + '" fill="#C9A84C" font-size="10" text-anchor="middle">' + esc(compactNum(v)) + '</text>');
        }
      });
    }
    parts.push('</svg>');
    el.innerHTML = parts.join('');
  }

  async function loadOverview() {
    var target = document.querySelector('[data-target=insights-overview-kpis]');
    if (!target) return;
    try {
      var data = await fetchInsights('overview', currentRange);
      renderKpis(data.kpis, target);
    } catch (e) {
      console.error('[insights] overview failed:', e);
      target.innerHTML = '<div class="insights-error">Overview failed: ' + esc(e.message || 'unknown') + '</div>';
    }
  }

  async function loadReport(report, range) {
    var panel = document.querySelector('[data-target=insights-active-panel]');
    if (!panel) return;
    panel.innerHTML = '<div class="insights-loading"><i class="fas fa-spinner fa-spin"></i> Loading ' + esc(report) + '…</div>';
    try {
      var data = await fetchInsights(report, range);
      var meta = data.generated_at
        ? '<div class="insights-report-meta">Generated ' + esc(new Date(data.generated_at).toLocaleString()) + ' · Range: ' + esc(data.range || range) + '</div>'
        : '';
      var kpisHtml = (data.kpis && data.kpis.length)
        ? '<div class="insights-kpi-grid">' + data.kpis.map(kpiCardHtml).join('') + '</div>'
        : '';
      var seriesHtml = (data.series && data.series.length)
        ? '<div class="insights-charts-grid">' + data.series.map(chartCardHtml).join('') + '</div>'
        : '';
      var tablesHtml = (data.tables && data.tables.length)
        ? '<div class="insights-tables-stack">' + data.tables.map(tableHtml).join('') + '</div>'
        : '';
      var emptyHtml = (!data.kpis || !data.kpis.length) && (!data.series || !data.series.length) && (!data.tables || !data.tables.length)
        ? '<div class="insights-loading">No data available for this report yet.</div>'
        : '';
      panel.innerHTML = meta + kpisHtml + seriesHtml + tablesHtml + emptyHtml;
      panel.querySelectorAll('.insights-chart-body').forEach(function (el) { renderChart(el); });
    } catch (e) {
      console.error('[insights] ' + report + ' failed:', e);
      panel.innerHTML = '<div class="insights-error">Failed to load ' + esc(report) + ': ' + esc(e.message || 'unknown') + '</div>';
    }
  }

  function exportTableCard(card) {
    var name = card.dataset.tableName || 'table';
    var headers = [].slice.call(card.querySelectorAll('thead th')).map(function (th) { return th.textContent.trim(); });
    var rows = [].slice.call(card.querySelectorAll('tbody tr')).map(function (tr) {
      if (tr.querySelector('.insights-empty-row')) return null;
      return [].slice.call(tr.querySelectorAll('td')).map(function (td) {
        return '"' + td.textContent.trim().replace(/"/g, '""') + '"';
      }).join(',');
    }).filter(Boolean);
    if (!rows.length) return;
    var csv = headers.join(',') + '\n' + rows.join('\n');
    var blob = new Blob([csv], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name + '-' + new Date().toISOString().substring(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function wireOnce() {
    if (wired) return;
    wired = true;

    document.querySelectorAll('.insights-subtabs .insights-subtab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.insights-subtabs .insights-subtab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        currentReport = tab.dataset.report;
        loadReport(currentReport, currentRange);
      });
    });

    document.querySelectorAll('[data-field=insights-range] button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('[data-field=insights-range] button').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        currentRange = btn.dataset.range;
        loadOverview();
        loadReport(currentReport, currentRange);
      });
    });

    var refreshBtn = document.querySelector('[data-action=insights-refresh]');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        var b = this;
        b.disabled = true;
        Promise.all([loadOverview(), loadReport(currentReport, currentRange)])
          .then(function () { b.disabled = false; }, function () { b.disabled = false; });
      });
    }

    var exportAllBtn = document.querySelector('[data-action=insights-export-all]');
    if (exportAllBtn) {
      exportAllBtn.addEventListener('click', function () {
        var cards = document.querySelectorAll('[data-target=insights-active-panel] .insights-table-card');
        if (!cards.length) { alert('No tables to export on the current tab.'); return; }
        cards.forEach(exportTableCard);
      });
    }

    // Per-table export — delegated since tables re-render
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action=export-table]');
      if (!btn) return;
      // Only handle clicks within an Insights table-card so we don't collide
      // with any other [data-action=export-table] elsewhere on the page.
      var card = btn.closest('.insights-table-card');
      if (card) exportTableCard(card);
    });

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        document.querySelectorAll('.insights-chart-body').forEach(function (el) { renderChart(el); });
      }, 200);
    });
  }

  function initInsights() {
    if (!document.querySelector('[data-target=insights-active-panel]')) return;
    wireOnce();
    loadOverview();
    loadReport(currentReport, currentRange);
  }

  // Public hook so admin-dashboard.js's tab router can fire us when the
  // user clicks Insights. Idempotent — safe to call repeatedly.
  window.initInsights = initInsights;

  // Self-firing init — DO NOT depend on the SPA dispatcher.
  // The host page's renderActiveTab() bails early when dashboardData is null
  // (initial-load race), and that silently swallows our trigger. So we
  // listen for hashchange + DOMContentLoaded ourselves; whenever the
  // analytics/insights/reports hash is active and the markup is on the
  // page, we init regardless of whether the SPA has loaded its data.
  function maybeAutoInit() {
    var hash = (location.hash || '').replace(/^#/, '');
    if (hash === 'reports') { location.hash = '#analytics'; return; }
    if (hash !== 'analytics' && hash !== 'insights') return;
    // Wait one tick so the SPA's navigateTo has flipped the section's
    // is-active class before we measure offsetWidth on chart bodies.
    setTimeout(initInsights, 60);
  }
  window.addEventListener('hashchange', maybeAutoInit);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeAutoInit);
  } else {
    maybeAutoInit();
  }
})();
