// admin-dashboard.js v20260411g
// Config fallback — ensures Supabase works even if env.js loads late
(function() {
  if (!window.APP_CONFIG || !window.APP_CONFIG.SUPABASE_URL) {
    window.APP_CONFIG = window.APP_CONFIG || {};
    window.APP_CONFIG.SUPABASE_URL = 'https://ljywhvbmsibwnssxpesh.supabase.co';
    // Key will be set by env.js — if missing, fetch will fail with 401
  }
})();

// Module-level cache — getSupabaseConfig() is called from many renderers;
// read window.APP_CONFIG once and reuse the result.
let _cachedSupabaseConfig = null;
function getSupabaseConfig() {
  if (!_cachedSupabaseConfig || !_cachedSupabaseConfig.key) {
    _cachedSupabaseConfig = {
      url: window.APP_CONFIG?.SUPABASE_URL || 'https://ljywhvbmsibwnssxpesh.supabase.co',
      key: window.APP_CONFIG?.SUPABASE_ANON_KEY
    };
  }
  // contacts/uploaded_documents are RLS-locked to logged-in users, so reads must carry
  // the user's session JWT (stored by the login page), not the anon key.
  var _auth = _cachedSupabaseConfig.key;
  try {
    var _s = JSON.parse(localStorage.getItem('sb_session') || 'null');
    if (_s && _s.access_token) _auth = _s.access_token;
  } catch (e) {}
  return { url: _cachedSupabaseConfig.url, key: _cachedSupabaseConfig.key, auth: _auth };
}

import { requireAdmin } from "/api/auth-api.js";
import {
  addLeadNote, calculateLeadScore, completeTask, createAppointment, createLead, createTask,
  getActivityFeed, getAdminDashboardData, getAnalyticsData,
  getAppointments, getCommunications, getLeadDetail, getLoanTypes,
  updateLead, updateLeadStage, updateLeadStatus, updateLeadScore, getAllTasks,
  updateTaskStatus, updateTask, deleteTask
} from "/api/admin-api-v2.js?v=20260504e";
import { summarizeLead, draftEmail, draftSMS, chatWithAI } from "/api/ai-api.js";
import { currency, formatDate, renderEmptyState, setMessage } from "/components/ui.js";

// ── STATE ─────────────────────────────────────────────────────────────────────
let dashboardData = null;
let activeTab = "overview";
let openLeadId = null;
let calendarDate = new Date();

// ── Calendar integrations state (Google sync + ClickUp task overlay) ──
let clickupTasks = [];
let clickupTasksEnabled = localStorage.getItem('clickup_overlay_enabled') === '1';

function calToast(msg, tone) {
  const el = document.createElement('div');
  el.textContent = msg;
  const accent = tone === 'error' ? 'rgba(255,90,90,0.45)' : tone === 'info' ? 'rgba(140,180,255,0.35)' : 'rgba(201,168,76,0.45)';
  const color  = tone === 'error' ? '#ffb0b0' : tone === 'info' ? '#bcd2ff' : '#f2cf85';
  el.style.cssText = `position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:rgba(20,20,20,0.98);border:1px solid ${accent};color:${color};padding:10px 22px;border-radius:999px;font-size:0.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,0.4);`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function syncGoogleCalendarAll() {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) { calToast('Config missing', 'error'); return; }
  calToast('Syncing with Google Calendar…', 'info');
  try {
    const res = await fetch(`${cfg.url}/functions/v1/google-calendar-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key, apikey: cfg.key },
      body: JSON.stringify({ action: 'sync_all' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      calToast('Sync failed: ' + (data.error || res.status), 'error');
      return;
    }
    calToast('✓ Synced with Google Calendar');
    // Refetch appointments + rerender if we're still on the calendar tab
    if (typeof loadDashboard === 'function') {
      try { await loadDashboard(); } catch (e) {}
    }
    if (activeTab === 'calendar') renderCalendar();
  } catch (e) {
    calToast('Sync failed: ' + (e.message || e), 'error');
  }
}

async function fetchClickupTasks({ force } = {}) {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) return [];
  const lastSync = parseInt(localStorage.getItem('clickup_last_sync') || '0', 10);
  const oneDayAgo = Date.now() - 86400000;
  const cached = localStorage.getItem('clickup_tasks_cache');
  if (!force && cached && lastSync > oneDayAgo) {
    try { clickupTasks = JSON.parse(cached); return clickupTasks; } catch (e) {}
  }
  try {
    const res = await fetch(`${cfg.url}/functions/v1/clickup-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key, apikey: cfg.key },
      body: JSON.stringify({ action: 'fetch_incomplete_tasks' })
    });
    const data = await res.json().catch(() => ({}));
    if (data.success && Array.isArray(data.tasks)) {
      clickupTasks = data.tasks;
      localStorage.setItem('clickup_tasks_cache', JSON.stringify(clickupTasks));
      localStorage.setItem('clickup_last_sync', String(Date.now()));
      return clickupTasks;
    }
  } catch (e) {
    console.warn('[clickup] fetch failed', e);
  }
  return clickupTasks;
}

function updateClickupBadge() {
  const badge = document.getElementById('clickup-task-badge');
  const btn = document.getElementById('clickup-toggle-btn');
  if (badge) {
    if (clickupTasks.length) {
      badge.textContent = String(clickupTasks.length);
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
  if (btn) {
    btn.style.background = clickupTasksEnabled ? 'rgba(255,140,0,0.25)' : 'rgba(255,140,0,0.08)';
    btn.style.borderColor = clickupTasksEnabled ? 'rgba(255,140,0,0.75)' : 'rgba(255,140,0,0.45)';
  }
}

async function toggleClickupOverlay() {
  clickupTasksEnabled = !clickupTasksEnabled;
  localStorage.setItem('clickup_overlay_enabled', clickupTasksEnabled ? '1' : '0');
  if (clickupTasksEnabled && !clickupTasks.length) {
    calToast('Loading ClickUp tasks…', 'info');
    await fetchClickupTasks({ force: true });
  }
  updateClickupBadge();
  if (activeTab === 'calendar') renderCalendar();
}
let allAppointments = [];
let drawerActiveTab = "details";
let allTasks = [];
let loanTypeGroups = {};

// ── INIT ──────────────────────────────────────────────────────────────────────
initializeAdminDashboard();

async function initializeAdminDashboard() {
  try {
    await requireAdmin();
    bindSidebarNav();
    bindDrawer();
    bindModals();
    bindAIChat();
    await loadAll();
  } catch (error) {
    console.error('Dashboard init error:', error.message, error.stack);
    document.querySelector(".crm-main")?.insertAdjacentHTML("afterbegin", `
      <div class="panel" style="margin-bottom:24px;">
        <p class="kicker">Access Restricted</p>
        <h2>CRM access is limited to your internal team.</h2>
        <p style="color:var(--muted);">Add your email to <code>/api/env.js</code> ADMIN_EMAILS and sign in with that account.</p>
        <p style="color:var(--muted);font-size:0.8rem;margin-top:8px;">Debug: ${error.message || error}</p>
      </div>
    `);
  }
}

async function loadAll() {
  try {
    [dashboardData, allAppointments, allTasks, loanTypeGroups] = await Promise.all([
      getAdminDashboardData(),
      getAppointments(),
      getAllTasks(),
      getLoanTypes()
    ]);
    populateLoanTypeSelect();
    renderActiveTab();
  } catch (err) {
    console.error("Dashboard load error full:", err.message, err.stack, err);
  }
}

// ── NAVIGATION ────────────────────────────────────────────────────────────────
function bindSidebarNav() {
  document.querySelectorAll("[data-crm-nav]").forEach((btn) => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.crmNav));
  });
  // Restore active section from hash or localStorage
  const hashSection = window.location.hash ? window.location.hash.replace("#", "") : "";
  const savedSection = hashSection || (function() { try { return localStorage.getItem('activeSection'); } catch(e) { return ''; } })();
  if (savedSection) navigateTo(savedSection);

  document.getElementById("refresh-btn")?.addEventListener("click", loadAll);
  document.getElementById("sidebar-signout-btn")?.addEventListener("click", async () => {
    const { supabase } = await import("/api/supabase-client.js");
    await supabase.auth.signOut();
    // Clear any leftover borrower/portal session so staff don't inherit it.
    try {
      // Clear borrower-portal keys (portal_ or portal-) AND any leftover
      // Supabase auth token so staff never inherit a stale session.
      Object.keys(localStorage)
        .filter((k) => /^portal[_-]/.test(k) || /^sb-.*-auth-token$/.test(k))
        .forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* ignore storage errors */ }
    window.location.href = "/auth/admin-login.html";
  });
}

function navigateTo(tabKey) {
  // Tear down any active File Vault realtime channel before switching tabs.
  // No-op when nothing is subscribed. _fvSelectBorrower will resubscribe if
  // the user lands back on documents and picks a borrower again.
  if (typeof _fvUnsubscribeContactUploads === "function") {
    try { _fvUnsubscribeContactUploads(); } catch (_) {}
  }
  activeTab = tabKey;
  // Persist active tab
  window.location.hash = tabKey;
  try { localStorage.setItem('activeSection', tabKey); } catch(e) {}
  document.querySelectorAll("[data-crm-nav]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.crmNav === tabKey);
  });
  document.querySelectorAll(".crm-tab-panel").forEach((p) => p.classList.remove("is-active"));
  const target = document.getElementById(`tab-${tabKey}`);
  if (target) target.classList.add("is-active");
  window.crmNavigateTo = navigateTo;
  // Scans tab runs the CRM health check on open (defined in admin.html).
  if (tabKey === "scans" && typeof window.runCrmScan === "function") window.runCrmScan();
  renderActiveTab();
}

function renderActiveTab() {
  if (!dashboardData) return;
  switch (activeTab) {
    case "overview": renderOverview(); break;
    case "leads": renderLeadsTable(dashboardData.leads); break;
    case "pipeline": if (typeof window.loadPipelineBoard === 'function') window.loadPipelineBoard(); break;
    case "contacts": renderContacts(dashboardData.contacts); break;
    case "calendar": renderCalendar(); break;
    case "tasks": renderAllTasksTable(allTasks); break;
    case "communications": renderCommunications(); break;
    case "activity": renderActivityFeed(); break;
    case "analytics": renderAnalytics(); break;
    case "applications":
      console.log('about to call loadApplications, cached:', dashboardData.applications?.length);
      loadApplications();
      break;
    case "documents": renderDocuments(); break;
  }
}

// ── OVERVIEW ──────────────────────────────────────────────────────────────────
async function renderOverview() {
  if (!dashboardData) return;
  const { leads, tasks, applications } = dashboardData;

  // Get analytics
  const data = await getAnalyticsData(leads, tasks, applications);
  const todayStr = new Date().toISOString().split("T")[0];
  const todayAppts = allAppointments.filter((a) => (a.scheduled_at || "").startsWith(todayStr)).length;

  // 6 stat cards
  const summary = document.getElementById("admin-summary");
  if (summary) {
    summary.innerHTML = `
      <article class="metric-card">
        <strong>${data.totalLeads}</strong>
        <span>Total Leads</span>
      </article>
      <article class="metric-card metric-card-gold">
        <strong>${data.newThisWeek}</strong>
        <span>New This Week</span>
        <div class="metric-delta up">↑ last 7 days</div>
      </article>
      <article class="metric-card metric-card-red">
        <strong>${data.hotLeads}</strong>
        <span>Hot Leads</span>
        <div class="metric-delta" style="color:var(--red);">Score 70+</div>
      </article>
      <article class="metric-card metric-card-green">
        <strong>${data.closedThisMonth}</strong>
        <span>Closed This Month</span>
      </article>
      <article class="metric-card">
        <strong>${data.conversionRate}%</strong>
        <span>Conversion Rate</span>
      </article>
      <article class="metric-card metric-card-blue">
        <strong>${todayAppts}</strong>
        <span>Appointments Today</span>
      </article>
    `;
  }

  // Pipeline stage strip
  const pipelineRoot = document.getElementById("lead-pipeline");
  if (pipelineRoot) {
    const { supabase } = await import("/api/supabase-client.js");
    const OVERVIEW_STAGES = [
      { key: 'New Lead',       label: 'NEW',           color: '#6B6B7A' },
      { key: 'Contacted',      label: 'CONTACTED',     color: '#5AA0E0' },
      { key: 'Pre-Approved',   label: 'PRE-APPROVED',  color: '#C9A84C' },
      { key: 'Under Contract', label: 'UNDER CONTRACT',color: '#AB7FE0' },
      { key: 'Processing',     label: 'PROCESSING',    color: '#E07F50' },
      { key: 'Clear to Close', label: 'CLEAR TO CLOSE',color: '#52C87A' },
      { key: 'Closed',         label: 'CLOSED',        color: '#3AB06A' },
      { key: 'Lost',           label: 'LOST',          color: '#E05252' },
    ];
    const { data: pipelineContacts } = await supabase
      .from('contacts')
      .select('pipeline_status');
    const countByStage = {};
    OVERVIEW_STAGES.forEach(s => countByStage[s.key] = 0);
    (pipelineContacts || []).forEach(c => {
      const key = c.pipeline_status || 'New Lead';
      if (countByStage[key] !== undefined) countByStage[key]++;
      else countByStage['New Lead']++;
    });
    pipelineRoot.innerHTML = OVERVIEW_STAGES.map((s) => `
      <div class="pipeline-column" onclick="navigateTo('pipeline')" style="cursor:pointer;">
        <p class="kicker" style="font-size:0.65rem;color:${s.color};">${s.label}</p>
        <div class="pipeline-count">${countByStage[s.key]}</div>
      </div>
    `).join("");
  }

  // Bar chart — leads by status
  const barRoot = document.getElementById("overview-bar-root");
  if (barRoot) {
    barRoot.innerHTML = renderInlineBarChart(data.byStage, ["new","contacted","prequalified","preapproved","in_process","closed"]);
  }

  // Pie chart — leads by source
  const pieRoot = document.getElementById("overview-pie-root");
  if (pieRoot) {
    pieRoot.innerHTML = renderInlinePieChart(data.bySource);
  }

  // Recent leads table
  const tbody = document.getElementById("overview-lead-tbody");
  if (tbody) {
    tbody.innerHTML = leads.slice(0, 8).map((lead) => {
      const c = lead.contacts || {};
      const name = `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Unknown";
      const detailHref = lead.contact_id ? `../admin/lead-detail.html?contact_id=${lead.contact_id}` : `../admin/lead-detail.html?lead_id=${lead.id}`;
      const calcScore = lead.score || calculateLeadScore(lead, c).score;
      const calcTier = lead.score_tier || calculateLeadScore(lead, c).tier;
      return `
        <tr class="lead-row" style="cursor:pointer;" data-lead-id="${lead.id}" data-detail-href="${detailHref}" onclick="window.location.href='${detailHref}'">
          <td class="lead-name-cell"><span class="lead-name-link" style="cursor:pointer;">${name}</span><span>${c.email || ""}</span></td>
          <td>${lead.loan_type || "—"}</td>
          <td>${scoreBadge(calcScore, calcTier)}</td>
          <td><span class="status-pill ${statusPillClass(lead.status)}">${lead.status || "new"}</span></td>
          <td>${formatDate(lead.created_at)}</td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--muted);">No leads yet.</td></tr>`;
    bindLeadRowClicks("#overview-lead-tbody");
  }

  // Activity feed
  const actFeed = document.getElementById("overview-activity-feed");
  if (actFeed) {
    const events = await getActivityFeed();
    actFeed.innerHTML = renderActivityItems(events.slice(0, 12));
  }

  // Upcoming appointments
  const apptEl = document.getElementById("overview-appointments");
  if (apptEl) renderUpcomingAppointmentsInEl(apptEl);
}

// ── LEADS TABLE ───────────────────────────────────────────────────────────────
function renderLeadsTable(leads) {
  const tbody = document.getElementById("all-leads-tbody");
  if (!tbody) return;
  renderLeadsTableBody(leads, tbody);

  const searchInput = document.getElementById("lead-search");
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = "1";
    searchInput.addEventListener("input", () => filterLeadsTable(leads));
  }

  // Bind status filter chips
  document.querySelectorAll("[data-filter-status]").forEach((chip) => {
    if (chip.dataset.filterBound) return;
    chip.dataset.filterBound = "1";
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-filter-status],[data-filter-tier]").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      const status = chip.dataset.filterStatus;
      const filtered = status === "all" ? leads : leads.filter((l) => (l.status || "new") === status);
      renderLeadsTableBody(filtered, tbody);
    });
  });

  // Bind tier filter chips
  document.querySelectorAll("[data-filter-tier]").forEach((chip) => {
    if (chip.dataset.filterBound) return;
    chip.dataset.filterBound = "1";
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-filter-status],[data-filter-tier]").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      const tier = chip.dataset.filterTier;
      const filtered = tier === "all" ? leads : leads.filter((l) => {
        const t = l.score_tier || calculateLeadScore(l, l.contacts || {}).tier;
        return t === tier;
      });
      renderLeadsTableBody(filtered, tbody);
    });
  });
}

function renderLeadsTableBody(leads, tbody) {
  if (!leads.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--muted);">No leads match this filter.</td></tr>`;
    return;
  }
  // Sort by score desc by default
  const sorted = [...leads].sort((a, b) => {
    const sa = a.score || calculateLeadScore(a, a.contacts || {}).score;
    const sb = b.score || calculateLeadScore(b, b.contacts || {}).score;
    return sb - sa;
  });
  tbody.innerHTML = sorted.map((lead) => {
    const c = lead.contacts || {};
    const name = `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Unknown";
    const detailHref = lead.contact_id ? `../admin/lead-detail.html?contact_id=${lead.contact_id}` : `../admin/lead-detail.html?lead_id=${lead.id}`;
    const calcScore = lead.score || calculateLeadScore(lead, c).score;
    const calcTier = lead.score_tier || calculateLeadScore(lead, c).tier;
    return `
      <tr class="lead-row" style="cursor:pointer;" data-lead-id="${lead.id}" data-detail-href="${detailHref}" onclick="window.location.href='${detailHref}'">
        <td class="lead-name-cell"><span class="lead-name-link" style="cursor:pointer;">${name}</span></td>
        <td>${c.email || "—"}</td>
        <td>${c.phone || "—"}</td>
        <td>${lead.loan_type || "—"}</td>
        <td>${scoreBadge(calcScore, calcTier)}</td>
        <td><span class="status-pill ${statusPillClass(lead.status)}">${lead.status || "new"}</span></td>
        <td>${lead.source || "website"}</td>
        <td>${formatDate(lead.created_at)}</td>
      </tr>
    `;
  }).join("");
  bindLeadRowClicks(tbody);
}

function filterLeadsTable(allLeads) {
  const term = (document.getElementById("lead-search")?.value || "").toLowerCase();
  const tbody = document.getElementById("all-leads-tbody");
  if (!tbody) return;
  const filtered = allLeads.filter((l) => {
    const c = l.contacts || {};
    return (
      (c.first_name || "").toLowerCase().includes(term) ||
      (c.last_name || "").toLowerCase().includes(term) ||
      (c.email || "").toLowerCase().includes(term) ||
      (c.phone || "").toLowerCase().includes(term)
    );
  });
  renderLeadsTableBody(filtered, tbody);
}

// ── KANBAN ────────────────────────────────────────────────────────────────────
const KANBAN_STAGES = [
  { key: "new", label: "New Lead" },
  { key: "contacted", label: "Contacted" },
  { key: "prequalified", label: "Prequalified" },
  { key: "preapproved", label: "Preapproved" },
  { key: "in_process", label: "In Process" },
  { key: "in_escrow", label: "In Escrow" },
  { key: "closed", label: "Closed" },
  { key: "lost", label: "Lost" }
];

function renderKanban(leads) {
  const board = document.getElementById("kanban-board");
  if (!board) return;

  board.innerHTML = KANBAN_STAGES.map((stage) => {
    const stageLeads = leads.filter((l) => (l.status || "new") === stage.key);
    const cards = stageLeads.map((lead) => {
      const c = lead.contacts || {};
      const name = `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Unknown";
      const loanAmt = lead.loan_amount ? currency(lead.loan_amount) : "—";
      const timeline = lead.timeline ? `<span class="kanban-tag">${lead.timeline.replace("_", " ")}</span>` : "";
      return `
        <div class="kanban-card" draggable="true" data-lead-id="${lead.id}" data-lead-stage="${stage.key}">
          <div class="kanban-card-top">
            <div class="kanban-card-name">${name}</div>
            ${scoreBadge(lead.score)}
          </div>
          <div class="kanban-card-sub">${lead.loan_type || "—"}</div>
          <div class="kanban-card-footer">
            <span class="kanban-card-amount">${loanAmt}</span>
            ${timeline}
          </div>
        </div>
      `;
    }).join("");

    return `
      <div class="kanban-col kanban-col-${stage.key}" data-stage="${stage.key}">
        <div class="kanban-col-header">
          <span class="kanban-col-name">${stage.label}</span>
          <span class="kanban-col-count">${stageLeads.length}</span>
        </div>
        <div class="kanban-cards">
          ${cards || `<div class="kanban-empty">No leads</div>`}
        </div>
      </div>
    `;
  }).join("");

  bindKanbanDragDrop(board);
  board.querySelectorAll(".kanban-card").forEach((card) => {
    card.addEventListener("click", () => openLeadDrawer(card.dataset.leadId));
  });
}

function bindKanbanDragDrop(board) {
  let draggingLeadId = null;

  board.querySelectorAll(".kanban-card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      draggingLeadId = card.dataset.leadId;
      card.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
  });

  board.querySelectorAll(".kanban-col").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const newStage = col.dataset.stage;
      if (!draggingLeadId || !newStage) return;
      try {
        await updateLeadStage(draggingLeadId, newStage);
        const lead = dashboardData?.leads.find((l) => String(l.id) === String(draggingLeadId));
        if (lead) lead.status = newStage;
        renderKanban(dashboardData?.leads || []);
      } catch (err) {
        console.error("Stage update failed:", err);
      }
      draggingLeadId = null;
    });
  });
}

// ── CONTACTS ─────────────────────────────────────────────────────────────────
function renderContacts(contacts) {
  const tbody = document.getElementById("contacts-tbody");
  if (!tbody) return;

  const renderRows = (list) => {
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--muted);">No contacts yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map((c) => `
      <tr>
        <td class="lead-name-cell">${c.first_name || ""} ${c.last_name || ""}<span>${c.email || ""}</span></td>
        <td>${c.email || "—"}</td>
        <td>${c.phone || "—"}</td>
        <td>${c.credit_score ? `<span class="score-badge ${creditScoreClass(c.credit_score)}">${c.credit_score}</span>` : "—"}</td>
        <td>${c.employer_name || "—"}</td>
        <td>${c.source || "—"}</td>
        <td>${formatDate(c.created_at)}</td>
        <td>
          <div class="flex-gap" style="gap:6px;">
            <button class="btn btn-ghost btn-xs" data-contact-detail="${c.id}">View</button>
          </div>
        </td>
      </tr>
    `).join("");

    tbody.querySelectorAll("[data-contact-detail]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const contact = contacts.find((c) => String(c.id) === String(btn.dataset.contactDetail));
        if (contact) showContactDetail(contact);
      });
    });
  };

  renderRows(contacts);

  const searchInput = document.getElementById("contact-search");
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = "1";
    searchInput.addEventListener("input", () => {
      const term = searchInput.value.toLowerCase();
      const filtered = contacts.filter((c) =>
        (c.first_name || "").toLowerCase().includes(term) ||
        (c.last_name || "").toLowerCase().includes(term) ||
        (c.email || "").toLowerCase().includes(term) ||
        (c.phone || "").toLowerCase().includes(term) ||
        (c.employer_name || "").toLowerCase().includes(term)
      );
      renderRows(filtered);
    });
  }
}

function showContactDetail(contact) {
  window.location.href = `../admin/lead-detail.html?contact_id=${contact.id}`;
}

function creditScoreClass(score) {
  if (score >= 740) return "score-green";
  if (score >= 680) return "score-yellow";
  return "score-red";
}

// ── TASKS (List / Board / Calendar) ───────────────────────────────────────────
let crmCurrentView = (typeof localStorage !== "undefined" && localStorage.getItem("rr_view_crm_tasks")) || "list";
let crmCurrentSort = (typeof localStorage !== "undefined" && localStorage.getItem("rr_sort_crm_tasks")) || "due_asc";
let crmCalRefDate = new Date();
let crmActiveFilter = "open";
let crmTasksRef = [];

function crmEsc(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function crmIsDone(s) { return s === "completed"; }

function crmColKey(t) {
  if (t.status === "completed") return "done";
  if (t.status === "in_progress") return "inprogress";
  return "todo";
}

function crmPriClass(p) {
  if (p === "urgent") return "pri-urgent";
  if (p === "high") return "pri-high";
  if (p === "low") return "pri-low";
  return "pri-normal";
}

function crmContactName(t) {
  const c = t.contacts || {};
  if (c.first_name) return `${c.first_name} ${c.last_name || ""}`.trim();
  if (t.related_id) return `Lead ${t.related_id.substring(0, 8)}`;
  return "";
}

function crmFilterTasks(tasks) {
  const now = new Date();
  if (crmActiveFilter === "open") return tasks.filter((t) => t.status === "open" || t.status === null);
  if (crmActiveFilter === "in_progress") return tasks.filter((t) => t.status === "in_progress");
  if (crmActiveFilter === "completed") return tasks.filter((t) => t.status === "completed");
  if (crmActiveFilter === "overdue") return tasks.filter((t) => t.due_date && new Date(t.due_date) < now && t.status !== "completed");
  return tasks;
}

function crmSortTasks(tasks) {
  const sorted = tasks.slice();
  const priWeight = { urgent: 1, high: 2, normal: 3, low: 4 };
  sorted.sort((a, b) => {
    switch (crmCurrentSort) {
      case "due_asc": {
        if (!a.due_date && !b.due_date) return 0;
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return new Date(a.due_date) - new Date(b.due_date);
      }
      case "due_desc": {
        if (!a.due_date && !b.due_date) return 0;
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return new Date(b.due_date) - new Date(a.due_date);
      }
      case "created_desc": return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      case "created_asc":  return new Date(a.created_at || 0) - new Date(b.created_at || 0);
      case "priority":     return (priWeight[a.priority] || 99) - (priWeight[b.priority] || 99);
      case "title_asc":    return (a.title || "").localeCompare(b.title || "");
      default: return 0;
    }
  });
  return sorted;
}

function crmRenderList(tasks) {
  const tbody = document.getElementById("tasks-tbody");
  if (!tbody) return;
  if (!tasks.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--muted);">No tasks.</td></tr>`;
    crmUpdateSelectionUI();
    return;
  }
  const now = new Date();
  tbody.innerHTML = tasks.map((task) => {
    const leadName = crmContactName(task) || "—";
    const isOverdue = task.due_date && new Date(task.due_date) < now && task.status !== "completed";
    const priorityClass = { high: "status-pill-orange", urgent: "status-pill-red", normal: "" }[task.priority || "normal"] || "";
    return `
      <tr data-task-id="${crmEsc(task.id)}">
        <td><input type="checkbox" class="ct-select-box" data-action="cm-select-row" data-task-id="${crmEsc(task.id)}" aria-label="Select task" /></td>
        <td><strong style="font-size:0.9rem;">${crmEsc(task.title || "Task")}</strong></td>
        <td style="font-size:0.82rem;color:var(--muted);">${crmEsc(leadName)}</td>
        <td><span class="status-pill ${priorityClass}" style="font-size:0.75rem;">${crmEsc(task.priority || "normal")}</span></td>
        <td style="font-size:0.82rem;${isOverdue ? "color:var(--red);" : "color:var(--muted);"}">${task.due_date ? formatDate(task.due_date) : "—"}${isOverdue ? " ⚠" : ""}</td>
        <td><span class="status-pill ${task.status === "completed" ? "status-pill-green" : isOverdue ? "status-pill-red" : ""}">${crmEsc(task.status || "open")}</span></td>
        <td>
          ${task.status !== "completed" ? `<button class="btn btn-success btn-xs" data-complete-task="${crmEsc(task.id)}">Done</button>` : ""}
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll("[data-complete-task]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      await completeTask(btn.dataset.completeTask);
      allTasks = await getAllTasks();
      renderAllTasksTable(allTasks);
    });
  });
  crmUpdateSelectionUI();
}

function crmBoardCardHtml(t) {
  const due = t.due_date ? new Date(t.due_date) : null;
  const overdue = due && t.status !== "completed" && due.getTime() < Date.now();
  const dueStr = due ? due.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  const contact = crmContactName(t);
  const contactId = t.contact_id || (t.contacts && t.contacts.id) || "";
  return `<div class="board-card" draggable="true" data-task-id="${crmEsc(t.id)}" data-current-col="${crmColKey(t)}">
    <input type="checkbox" class="ct-select-box board-card-select" data-action="cm-select-row" data-task-id="${crmEsc(t.id)}" aria-label="Select task" />
    <div class="board-card-title">${crmEsc(t.title || "")}</div>
    <div class="board-card-meta">
      ${t.priority ? `<span class="board-card-pri ${crmPriClass(t.priority)}">${crmEsc(t.priority)}</span>` : ""}
      ${dueStr ? `<span class="board-card-due${overdue ? " is-overdue" : ""}">${overdue ? "⚠ " : ""}${crmEsc(dueStr)}</span>` : ""}
    </div>
    ${contact && contactId ? `<a class="board-card-contact" href="/admin/lead-detail.html?contact_id=${crmEsc(contactId)}" onclick="event.stopPropagation()">${crmEsc(contact)}</a>` : (contact ? `<span class="board-card-contact">${crmEsc(contact)}</span>` : "")}
  </div>`;
}

function crmRenderBoard(tasks) {
  const board = document.querySelector('[data-target="cm-board"]');
  if (!board) return;
  const groups = { todo: [], inprogress: [], done: [] };
  tasks.forEach((t) => groups[crmColKey(t)].push(t));
  const titles = { todo: "To Do", inprogress: "In Progress", done: "Complete" };
  board.innerHTML = ["todo", "inprogress", "done"].map((col) => `
    <div class="board-col" data-col="${col}">
      <div class="board-col-header">
        <span class="board-col-icon"></span>
        <span>${titles[col]}</span>
        <span class="board-col-count">${groups[col].length}</span>
      </div>
      <div class="board-col-body" data-drop-col="${col}">
        ${groups[col].length === 0 ? `<div class="board-empty">— Drop tasks here —</div>` : groups[col].map(crmBoardCardHtml).join("")}
      </div>
    </div>
  `).join("");
  crmAttachDragHandlers();
  crmUpdateSelectionUI();
}

function crmAttachDragHandlers() {
  let draggingId = null;
  let draggingFromCol = null;
  document.querySelectorAll('[data-target="cm-board"] .board-card[draggable]').forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      draggingId = card.dataset.taskId;
      draggingFromCol = card.dataset.currentCol;
      card.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", draggingId); } catch (err) {}
    });
    card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
  });
  document.querySelectorAll('[data-target="cm-board"] [data-drop-col]').forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("is-drop-target"); });
    col.addEventListener("dragleave", () => col.classList.remove("is-drop-target"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("is-drop-target");
      const targetCol = col.dataset.dropCol;
      if (!draggingId || targetCol === draggingFromCol) return;
      const card = document.querySelector(`[data-target="cm-board"] .board-card[data-task-id="${CSS.escape(draggingId)}"]`);
      if (card) col.appendChild(card);
      const newStatus = targetCol === "done" ? "completed" : targetCol === "inprogress" ? "in_progress" : "open";
      try {
        await updateTaskStatus(draggingId, newStatus);
        allTasks = await getAllTasks();
        renderAllTasksTable(allTasks);
      } catch (err) {
        alert("Move failed: " + (err.message || "unknown"));
        renderAllTasksTable(allTasks);
      }
    });
  });
}

function crmCalDayHtml(d, tasks, today, isOtherMonth) {
  const isToday = d.getTime() === today.getTime();
  const dayKey = d.toISOString().substring(0, 10);
  const visible = tasks.slice(0, 3);
  const overflow = tasks.length - visible.length;
  const pillsHtml = visible.map((t) => {
    const isDone = crmIsDone(t.status);
    return `<div class="cal-task-pill ${crmPriClass(t.priority || "normal")}${isDone ? " is-done" : ""}" data-task-id="${crmEsc(t.id)}" title="${crmEsc(t.title || "")}">${crmEsc(t.title || "")}</div>`;
  }).join("");
  return `<div class="cal-day${isToday ? " is-today" : ""}${isOtherMonth ? " is-other-month" : ""}" data-date="${dayKey}">
    <div class="cal-day-num">${d.getDate()}</div>
    ${pillsHtml}
    ${overflow > 0 ? `<div class="cal-task-overflow">+${overflow} more</div>` : ""}
  </div>`;
}

function crmRenderCalendar(tasks) {
  const cal = document.querySelector('[data-target="cm-calendar"]');
  if (!cal) return;
  const ref = new Date(crmCalRefDate.getFullYear(), crmCalRefDate.getMonth(), 1);
  const monthName = ref.toLocaleString("en-US", { month: "long", year: "numeric" });
  const startWeekday = ref.getDay();
  const daysInMonth = new Date(ref.getFullYear(), ref.getMonth() + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const tasksByDate = {};
  tasks.forEach((t) => {
    if (!t.due_date) return;
    const k = new Date(t.due_date).toISOString().substring(0, 10);
    (tasksByDate[k] = tasksByDate[k] || []).push(t);
  });

  let html = `<div class="cal-header">
    <button class="cal-nav-btn" data-action="cm-cal-prev">‹ Prev</button>
    <span class="cal-month-title">${monthName}</span>
    <button class="cal-nav-btn" data-action="cm-cal-today">Today</button>
    <button class="cal-nav-btn" data-action="cm-cal-next">Next ›</button>
  </div><div class="cal-grid">${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => `<div class="cal-dow">${d}</div>`).join("")}`;

  for (let i = 0; i < startWeekday; i++) {
    const d = new Date(ref); d.setDate(d.getDate() - (startWeekday - i));
    html += crmCalDayHtml(d, tasksByDate[d.toISOString().substring(0, 10)] || [], today, true);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(ref.getFullYear(), ref.getMonth(), day);
    html += crmCalDayHtml(d, tasksByDate[d.toISOString().substring(0, 10)] || [], today, false);
  }
  const totalCells = startWeekday + daysInMonth;
  const trailing = (7 - (totalCells % 7)) % 7;
  for (let j = 1; j <= trailing; j++) {
    const d = new Date(ref.getFullYear(), ref.getMonth() + 1, j);
    html += crmCalDayHtml(d, tasksByDate[d.toISOString().substring(0, 10)] || [], today, true);
  }
  html += `</div>`;
  cal.innerHTML = html;

  cal.querySelector('[data-action="cm-cal-prev"]').addEventListener("click", () => {
    crmCalRefDate = new Date(crmCalRefDate.getFullYear(), crmCalRefDate.getMonth() - 1, 1);
    crmDispatchView();
  });
  cal.querySelector('[data-action="cm-cal-next"]').addEventListener("click", () => {
    crmCalRefDate = new Date(crmCalRefDate.getFullYear(), crmCalRefDate.getMonth() + 1, 1);
    crmDispatchView();
  });
  cal.querySelector('[data-action="cm-cal-today"]').addEventListener("click", () => {
    crmCalRefDate = new Date();
    crmDispatchView();
  });

  cal.querySelectorAll(".cal-day").forEach((day) => {
    day.addEventListener("click", () => {
      openModal("task-modal");
      const dueInput = document.querySelector('#task-modal-form input[name="due_date"]');
      if (dueInput && day.dataset.date) dueInput.value = day.dataset.date;
    });
  });
}

function crmDispatchView() {
  const filtered = crmFilterTasks(crmTasksRef);
  const sorted = crmSortTasks(filtered);
  if (crmCurrentView === "list") crmRenderList(sorted);
  else if (crmCurrentView === "board") crmRenderBoard(sorted);
  else if (crmCurrentView === "calendar") crmRenderCalendar(sorted);
}

function crmApplyViewToDom() {
  const panel = document.querySelector('[data-subpanel="crm"]');
  if (panel) panel.dataset.currentView = crmCurrentView;
  // CSS visibility is driven by data-view on the container — no [hidden] toggling.
  const container = document.querySelector('[data-target="cm-view-container"]');
  if (container) container.dataset.view = crmCurrentView;
  document.querySelectorAll('[data-subpanel="crm"] .view-btn').forEach((b) => {
    b.classList.toggle("active", b.dataset.view === crmCurrentView);
  });
  // Toggle body.view-list-active so .view-sort visibility tracks the active sub-panel.
  if (typeof window.__rrSyncTasksBodyClass === "function") window.__rrSyncTasksBodyClass();
  else {
    const active = document.querySelector(".task-subpanel:not([hidden])");
    document.body.classList.toggle("view-list-active", !!active && active.dataset.currentView === "list");
  }
}

// ── CRM multi-select + bulk actions ─────────────────────────────────────────
const crmSelectedIds = new Set();
let crmBulkWired = false;

function crmUpdateSelectionUI() {
  document.querySelectorAll('[data-subpanel="crm"] tr[data-task-id], [data-subpanel="crm"] .board-card[data-task-id]').forEach((row) => {
    const tid = row.dataset.taskId;
    const sel = crmSelectedIds.has(tid);
    row.classList.toggle("is-selected", sel);
    const cb = row.querySelector(".ct-select-box");
    if (cb) cb.checked = sel;
  });
  const bar = document.querySelector('[data-target="cm-bulk-bar"]');
  if (bar) {
    if (crmSelectedIds.size > 0) {
      bar.hidden = false;
      const c = bar.querySelector('[data-target="cm-bulk-count"]');
      if (c) c.textContent = String(crmSelectedIds.size);
    } else {
      bar.hidden = true;
    }
  }
  // Header "select all" checkbox in CRM list table
  const sa = document.querySelector('[data-target="cm-select-all-table"]');
  if (sa) {
    const rows = document.querySelectorAll('#tasks-tbody tr[data-task-id]');
    if (rows.length === 0) { sa.checked = false; sa.indeterminate = false; }
    else {
      const all = Array.from(rows).every((r) => crmSelectedIds.has(r.dataset.taskId));
      const some = Array.from(rows).some((r) => crmSelectedIds.has(r.dataset.taskId));
      sa.checked = all;
      sa.indeterminate = !all && some;
    }
  }
}

async function crmBulkApply(perTaskFn) {
  const ids = Array.from(crmSelectedIds);
  if (ids.length === 0) return;
  const bar = document.querySelector('[data-target="cm-bulk-bar"]');
  if (bar) bar.style.opacity = "0.6";
  let done = 0, failed = 0;
  for (const tid of ids) {
    try { await perTaskFn(tid); done++; }
    catch (e) { failed++; console.error("[cm-bulk] failed for", tid, e); }
  }
  if (bar) bar.style.opacity = "1";
  if (failed > 0) alert(`${done} updated, ${failed} failed. Check console for details.`);
  crmSelectedIds.clear();
  allTasks = await getAllTasks();
  renderAllTasksTable(allTasks);
}

function crmBulkSetDueDate() {
  if (!window.__rrPickers) { console.error("[cm-bulk] picker module not loaded"); return; }
  const trigger = document.querySelector('[data-subpanel="crm"] [data-action="cm-bulk-due"]');
  window.__rrPickers.due(trigger, crmSelectedIds.size, (isoDate) => {
    crmBulkApply((tid) => updateTask(tid, { due_date: isoDate }));
  });
}

function crmBulkSetPriority() {
  if (!window.__rrPickers) { console.error("[cm-bulk] picker module not loaded"); return; }
  const trigger = document.querySelector('[data-subpanel="crm"] [data-action="cm-bulk-priority"]');
  window.__rrPickers.priority(trigger, crmSelectedIds.size, (priority) => {
    crmBulkApply((tid) => updateTask(tid, { priority }));
  });
}

function crmBulkAssignContact() {
  if (!window.__rrPickers) { console.error("[cm-bulk] picker module not loaded"); return; }
  const trigger = document.querySelector('[data-subpanel="crm"] [data-action="cm-bulk-contact"]');
  window.__rrPickers.lead(trigger, crmSelectedIds.size, (cid) => {
    crmBulkApply((tid) => updateTask(tid, { contact_id: cid, related_id: cid }));
  });
}

async function crmBulkComplete() {
  if (!confirm(`Mark ${crmSelectedIds.size} task(s) complete?`)) return;
  await crmBulkApply((tid) => completeTask(tid));
}

async function crmBulkReopen() {
  if (!confirm(`Reopen ${crmSelectedIds.size} task(s)?`)) return;
  await crmBulkApply((tid) => updateTaskStatus(tid, "open"));
}

async function crmBulkDelete() {
  if (!confirm(`PERMANENTLY DELETE ${crmSelectedIds.size} task(s)? Cannot be undone.`)) return;
  await crmBulkApply((tid) => deleteTask(tid));
}

function wireCrmBulkActions() {
  if (crmBulkWired) return;
  crmBulkWired = true;
  // Delegated click on the CRM sub-panel — handles per-row select, select-all,
  // and the bulk action bar buttons.
  document.addEventListener("click", (e) => {
    const inCrm = e.target.closest('[data-subpanel="crm"]');
    if (!inCrm) return;

    if (e.target.closest('[data-action="cm-bulk-clear"]')) { crmSelectedIds.clear(); crmUpdateSelectionUI(); return; }
    if (e.target.closest('[data-action="cm-bulk-due"]')) { crmBulkSetDueDate(); return; }
    if (e.target.closest('[data-action="cm-bulk-priority"]')) { crmBulkSetPriority(); return; }
    if (e.target.closest('[data-action="cm-bulk-contact"]')) { crmBulkAssignContact(); return; }
    if (e.target.closest('[data-action="cm-bulk-complete"]')) { crmBulkComplete(); return; }
    if (e.target.closest('[data-action="cm-bulk-reopen"]')) { crmBulkReopen(); return; }
    if (e.target.closest('[data-action="cm-bulk-delete"]')) { crmBulkDelete(); return; }

    const tableSelectAll = e.target.closest('[data-target="cm-select-all-table"]');
    if (tableSelectAll) {
      e.stopPropagation();
      const rows = document.querySelectorAll('#tasks-tbody tr[data-task-id]');
      rows.forEach((r) => {
        if (tableSelectAll.checked) crmSelectedIds.add(r.dataset.taskId);
        else crmSelectedIds.delete(r.dataset.taskId);
      });
      crmUpdateSelectionUI();
      return;
    }

    const selBox = e.target.closest('[data-action="cm-select-row"]');
    if (selBox) {
      e.stopPropagation();
      const tid = selBox.dataset.taskId;
      if (selBox.checked) crmSelectedIds.add(tid);
      else crmSelectedIds.delete(tid);
      crmUpdateSelectionUI();
      return;
    }
  });
}

function renderAllTasksTable(tasks) {
  const tbody = document.getElementById("tasks-tbody");
  if (!tbody) return;
  crmTasksRef = tasks || [];

  // Filter chips — bind once
  document.querySelectorAll("[data-task-filter]").forEach((chip) => {
    if (chip.dataset.taskFilterBound) return;
    chip.dataset.taskFilterBound = "1";
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-task-filter]").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      crmActiveFilter = chip.dataset.taskFilter;
      crmDispatchView();
    });
  });

  // View switcher + sort dropdown — bind once
  document.querySelectorAll('[data-subpanel="crm"] .view-btn').forEach((btn) => {
    if (btn.dataset.viewBtnBound) return;
    btn.dataset.viewBtnBound = "1";
    btn.addEventListener("click", () => {
      crmCurrentView = btn.dataset.view;
      localStorage.setItem("rr_view_crm_tasks", crmCurrentView);
      crmApplyViewToDom();
      crmDispatchView();
    });
  });
  const sortSel = document.querySelector('[data-subpanel="crm"] [data-target="cm-sort"]');
  if (sortSel && !sortSel.dataset.sortBound) {
    sortSel.dataset.sortBound = "1";
    sortSel.value = crmCurrentSort;
    sortSel.addEventListener("change", (e) => {
      crmCurrentSort = e.target.value;
      localStorage.setItem("rr_sort_crm_tasks", crmCurrentSort);
      crmDispatchView();
    });
  }

  wireCrmBulkActions();
  crmApplyViewToDom();
  crmDispatchView();
}

// ── CALENDAR ─────────────────────────────────────────────────────────────────
function renderCalendar() {
  // Calendar implementation moved to /dashboard/utils/calendar.js. The
  // module self-fires on hashchange independent of the dashboardData
  // gate, but we also expose initCalendar so this dispatcher can poke it
  // when the user clicks the sidebar Calendar button after data loads.
  if (typeof window.initCalendar === 'function') {
    window.initCalendar();
  } else {
    var root = document.querySelector('[data-target=cal-main]');
    if (root) root.innerHTML = '<div class="cal-error">calendar.js failed to load — refresh the page.</div>';
  }
}

// Overdue / no-due-date ClickUp task sidebar — only shown when overlay is on.
function renderClickupSidebar(root) {
  const existing = document.getElementById('clickup-sidebar');
  if (existing) existing.remove();
  if (!clickupTasksEnabled || !clickupTasks.length) return;

  const now = Date.now();
  const overdue = clickupTasks.filter((t) => t.due_date && new Date(t.due_date).getTime() < now);
  const noDue = clickupTasks.filter((t) => !t.due_date);
  if (!overdue.length && !noDue.length) return;

  const row = (t) => {
    const safeUrl = String(t.url || '').replace(/"/g, '&quot;');
    const due = t.due_date ? new Date(t.due_date).toLocaleDateString('en-US') : '—';
    const priColor = t.priority_label === 'high' ? '#ff5555' : '#ffb347';
    return `<a href="${safeUrl}" target="_blank" rel="noopener" class="list-item" style="display:flex;align-items:center;gap:10px;text-decoration:none;color:inherit;padding:8px 10px;border-left:2px solid ${priColor};">
      <span style="font-size:0.64rem;font-weight:700;text-transform:uppercase;color:${priColor};letter-spacing:0.5px;">TASK</span>
      <span style="flex:1;font-size:0.82rem;">${(t.name || '').slice(0, 60)}</span>
      <span style="color:var(--muted);font-size:0.72rem;">${due}</span>
    </a>`;
  };

  const section = document.createElement('div');
  section.id = 'clickup-sidebar';
  section.style.cssText = 'margin-top:20px;';
  section.innerHTML = `
    <div class="panel" style="padding:14px 16px;">
      <p class="kicker" style="color:#ff8c00;">ClickUp · Overdue / No Due Date</p>
      ${overdue.length ? `<div style="font-size:0.72rem;text-transform:uppercase;color:#ff5555;font-weight:700;margin:10px 0 4px;letter-spacing:0.5px;">Overdue (${overdue.length})</div>${overdue.map(row).join('')}` : ''}
      ${noDue.length ? `<div style="font-size:0.72rem;text-transform:uppercase;color:var(--muted);font-weight:700;margin:10px 0 4px;letter-spacing:0.5px;">No Due Date (${noDue.length})</div>${noDue.map(row).join('')}` : ''}
    </div>
  `;
  root.appendChild(section);
}

function renderUpcomingAppointmentsInEl(el) {
  if (!el) return;
  const now = new Date().toISOString();
  const upcoming = allAppointments
    .filter((a) => (a.scheduled_at || "") >= now)
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))
    .slice(0, 8);

  if (!upcoming.length) {
    el.innerHTML = `<div class="panel" style="padding:20px;"><p style="color:var(--muted);font-size:0.88rem;">No upcoming appointments.</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="panel">
      <p class="kicker">Upcoming Appointments</p>
      <div class="admin-stack">
        ${upcoming.map((a) => `
          <div class="list-item crm-list-item" style="display:flex;gap:14px;align-items:center;">
            <div style="flex:1;">
              <strong style="font-size:0.9rem;">${a.title || "Appointment"}</strong>
              <span style="color:var(--muted);font-size:0.8rem;display:block;">
                ${new Date(a.scheduled_at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <span class="status-pill ${a.type === "call" ? "status-pill-blue" : ""}">${a.type || "appointment"}</span>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

// ── COMMUNICATIONS ────────────────────────────────────────────────────────────
async function renderCommunications() {
  const root = document.getElementById("comm-feed-root");
  if (!root) return;
  root.innerHTML = `<p style="color:var(--muted);">Loading communications...</p>`;
  const comms = await getCommunications();
  if (!comms.length) {
    root.innerHTML = `<div class="list-item"><span style="color:var(--muted)">No communications logged yet.</span></div>`;
    return;
  }
  const renderComms = (list) => list.map((c) => {
    const icon = { sms: "💬", email: "✉", call: "📞" }[c.type] || "📞";
    const iconClass = { sms: "comm-icon-sms", email: "comm-icon-email", call: "comm-icon-call" }[c.type] || "";
    const dirClass = c.direction === "inbound" ? "comm-direction-in" : "comm-direction-out";
    return `
      <div class="comm-item">
        <div class="comm-icon ${iconClass}">${icon}</div>
        <div class="comm-body">
          <div class="comm-meta">
            <span class="comm-contact">${c.contact_name || "Contact"}</span>
            <span class="comm-direction ${dirClass}">${c.direction === "inbound" ? "↙ Inbound" : "↗ Outbound"}</span>
            <span class="comm-time">${formatDate(c.created_at)}</span>
          </div>
          <div class="comm-text">${c.body || ""}</div>
        </div>
      </div>
    `;
  }).join("");

  root.innerHTML = renderComms(comms);
  document.querySelectorAll("[data-comm-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-comm-filter]").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      const filter = chip.dataset.commFilter;
      root.innerHTML = renderComms(filter === "all" ? comms : comms.filter((c) => c.type === filter));
    });
  });
}

// ── ACTIVITY FEED ─────────────────────────────────────────────────────────────
async function renderActivityFeed(leadId = null) {
  const root = document.getElementById("activity-feed-root");
  if (!root) return;
  // Defer to the rich loader in admin.html when it's available (handles the
  // top-level Activity tab with names, contact info, and click-through).
  // The old renderer below is kept for per-lead drill-downs that pass leadId.
  if (!leadId && typeof window.loadActivityFeed === "function") {
    window.loadActivityFeed();
    return;
  }
  root.innerHTML = `<p style="color:var(--muted);">Loading activity...</p>`;
  const events = await getActivityFeed(leadId);
  root.innerHTML = renderActivityItems(events);
}

function renderActivityItems(events) {
  if (!events.length) return `<p style="color:var(--muted);">No activity yet.</p>`;
  const iconMap = {
    lead_created: { icon: "✦", cls: "activity-dot-gold" },
    status_changed: { icon: "⇄", cls: "activity-dot-blue" },
    note_added: { icon: "✎", cls: "activity-dot" },
    task_created: { icon: "☐", cls: "activity-dot" },
    task_completed: { icon: "✓", cls: "activity-dot-green" },
    appointment_booked: { icon: "◷", cls: "activity-dot-gold" },
    document_uploaded: { icon: "⬆", cls: "activity-dot-blue" },
    email_sent: { icon: "✉", cls: "activity-dot" },
    sms_sent: { icon: "💬", cls: "activity-dot" },
    call_logged: { icon: "📞", cls: "activity-dot" }
  };
  const linkify = window.linkifyText || ((s) => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))));
  const chip = window.renderActivityChip || (() => '');
  return events.map((e) => {
    const m = iconMap[e.type] || { icon: "•", cls: "activity-dot" };
    const titleText = e.description || e.type || '';
    return `
      <div class="activity-item">
        <div class="activity-dot ${m.cls}">${m.icon}</div>
        <div class="activity-content">
          <div class="activity-title">${linkify(titleText)}${chip(e.metadata)}</div>
          <div class="activity-time">${formatDate(e.created_at)}</div>
        </div>
      </div>
    `;
  }).join("");
}

// ── INSIGHTS (was Analytics) ───────────────────────────────────────────
// Implementation moved to /dashboard/utils/insights.js. The old
// loadAnalyticsDashboard() that drove the Pipeline Funnel / Leads by
// Source / Loan Type / etc. Chart.js panels has been removed entirely
// (server-aggregated insights-data v2 replaces it). renderAnalytics()
// stays as the single hook our tab router calls when the user clicks
// the sidebar Insights button — we forward to the module.
function renderAnalytics() {
  if (typeof window.initInsights === "function") {
    window.initInsights();
  } else {
    var panel = document.querySelector("[data-target=insights-active-panel]");
    if (panel) panel.innerHTML = '<div class="insights-error">insights.js failed to load — refresh the page.</div>';
  }
}

// ── APPLICATIONS & DOCUMENTS ──────────────────────────────────────────────────
let _allApplications = [];

async function loadApplications(forceRefresh) {
  const SUPABASE_URL = window.APP_CONFIG?.SUPABASE_URL;
  const SUPABASE_KEY = window.APP_CONFIG?.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('APP_CONFIG missing — URL:', !!SUPABASE_URL, 'KEY:', !!SUPABASE_KEY);
    return;
  }

  // Use cached data if available and not forcing refresh
  if (!forceRefresh && dashboardData?.applications?.length) {
    console.log('loadApplications: using cached data,', dashboardData.applications.length, 'apps');
    renderApplications(dashboardData.applications);
    return;
  }

  const container = document.getElementById('application-table');
  if (container) container.innerHTML = '<div style="padding:40px;text-align:center;color:rgba(255,255,255,0.3)">Loading...</div>';

  console.log('loadApplications firing, URL:', SUPABASE_URL?.slice(0, 40));

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/mortgage_applications?select=id,loan_type,loan_amount,status,updated_at,property_address_street,property_address_city,property_value,contact_id,contacts!mortgage_applications_contact_id_fkey(id,first_name,last_name,email,phone,credit_score,monthly_income,pipeline_status)&order=updated_at.desc`,
      { headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      }}
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error('Applications fetch error:', res.status, errText);
      if (container) container.innerHTML = `<div style="padding:40px;text-align:center;color:#f87171">Error loading: ${res.status}</div>`;
      return;
    }

    const apps = await res.json();
    console.log('Applications loaded:', Array.isArray(apps) ? apps.length : 'not array');
    if (Array.isArray(apps)) { dashboardData.applications = apps; renderApplications(apps); }
    else { console.error('loadApplications: unexpected response', apps); renderApplications([]); }
  } catch(e) {
    console.error('loadApplications exception:', e);
    if (container) container.innerHTML = `<div style="padding:40px;text-align:center;color:#f87171">Error: ${e.message}</div>`;
  }
}
window.loadApplications = loadApplications;

function renderApplications(applications) {
  console.log('renderApplications called, count:', (applications||[]).length, 'first app:', JSON.stringify((applications||[])[0]));
  _allApplications = (applications || []).map(app => {
    // Normalize contacts — could be object, array, or null
    const c = Array.isArray(app.contacts) ? app.contacts[0] : app.contacts;
    return { ...app, _contact: c || {} };
  });
  renderAppStats(_allApplications);
  filterApplications();
}

function renderAppStats(apps) {
  const el = document.getElementById("app-stats-row");
  if (!el) return;
  const total = apps.length;
  const active = apps.filter(a => (a.status || 'draft') === 'active').length;
  const amounts = apps.map(a => a.loan_amount || 0).filter(a => a > 0);
  const avg = amounts.length ? amounts.reduce((s,a) => s+a, 0) / amounts.length : 0;
  const pipeline = apps.reduce((s,a) => s + (a.loan_amount || 0), 0);
  const fmtBig = n => { if (n >= 1000000) return '$'+(n/1000000).toFixed(1)+'M'; if (n >= 1000) return '$'+(n/1000).toFixed(0)+'K'; return '$'+Math.round(n); };
  const cardStyle = 'background:#141414;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px;text-align:center;';
  const numStyle = 'font-size:22px;font-weight:800;color:#c9a84c;';
  const lblStyle = 'font-size:10px;color:rgba(255,255,255,0.38);text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;';
  el.innerHTML = `
    <div style="${cardStyle}"><div style="${numStyle}">${total}</div><div style="${lblStyle}">Total Apps</div></div>
    <div style="${cardStyle}"><div style="${numStyle}">${active}</div><div style="${lblStyle}">Active</div></div>
    <div style="${cardStyle}"><div style="${numStyle}">${fmtBig(avg)}</div><div style="${lblStyle}">Avg Loan</div></div>
    <div style="${cardStyle}"><div style="${numStyle}">${fmtBig(pipeline)}</div><div style="${lblStyle}">Pipeline</div></div>`;
}

function filterApplications() {
  const el = document.getElementById("application-table");
  console.log('filterApplications: container found:', !!el, 'apps count:', _allApplications.length);
  if (_allApplications.length) console.log('filterApplications: first app:', JSON.stringify(_allApplications[0]).substring(0, 300));
  if (!el) { console.warn('filterApplications: #application-table element not found in DOM'); return; }
  const q = (document.getElementById("appSearchInput")?.value || "").toLowerCase();
  const statusF = document.getElementById("appStatusFilter")?.value || "";
  const sortBy = document.getElementById("appSortBy")?.value || "newest";

  let filtered = _allApplications.filter(app => {
    if (statusF && (app.status || "draft").toLowerCase() !== statusF.toLowerCase()) return false;
    if (q) {
      const c = app._contact || {};
      const hay = `${c.first_name||""} ${c.last_name||""} ${c.email||""} ${app.property_address_street||""} ${app.property_address_city||""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (sortBy === "loan_amount") return (b.loan_amount||0) - (a.loan_amount||0);
    if (sortBy === "credit_score") return ((b._contact?.credit_score||0) - (a._contact?.credit_score||0));
    return new Date(b.updated_at||0) - new Date(a.updated_at||0);
  });

  const countEl = document.getElementById("appResultsCount");
  if (countEl) countEl.textContent = `${filtered.length} of ${_allApplications.length} applications`;

  if (!filtered.length) {
    el.innerHTML = `<div style="text-align:center;padding:48px;color:rgba(255,255,255,0.3);">
      <div style="font-size:40px;margin-bottom:10px;">📋</div>
      <div style="font-size:14px;font-weight:600;margin-bottom:6px;">No applications yet</div>
      <div style="font-size:12px;">Import a MISMO 3.4 file to get started.</div>
    </div>`;
    return;
  }

  const AV_BG = ['rgba(201,168,76,0.2)','rgba(80,200,120,0.2)','rgba(96,160,255,0.2)','rgba(192,132,240,0.2)','rgba(251,146,60,0.2)'];
  const AV_FG = ['#c9a84c','#50c878','#60a0ff','#c084f0','#fb923c'];
  const _isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const _leadBase = _isLocal ? `${window.location.origin}/admin/lead-detail.html` : '/admin/lead-detail.html';

  el.innerHTML = filtered.map(app => {
    const c = app.contacts || {};
    const name = `${c.first_name||""} ${c.last_name||""}`.trim() || "Unknown Borrower";
    const initials = `${(c.first_name||"?")[0]}${(c.last_name||"")[0]||""}`.toUpperCase();
    const avIdx = (name.charCodeAt(0) || 0) % 5;
    const email = c.email || "";
    const phone = c.phone || "";
    const contactLine = [email, phone].filter(Boolean).join(" · ") || "No contact info";

    const loanType = app.loan_type ? app.loan_type.charAt(0).toUpperCase() + app.loan_type.slice(1) : "—";
    const loanAmt = app.loan_amount ? "$" + Number(app.loan_amount).toLocaleString() : "—";
    const propAddr = [app.property_address_street, app.property_address_city].filter(Boolean).join(", ") || app.property_address || "No property address";
    const ltv = (app.loan_amount && app.property_value && app.property_value > 0) ? Math.round(app.loan_amount / app.property_value * 100) + "%" : "—";

    const credit = c.credit_score;
    let creditColor = "rgba(255,255,255,0.25)";
    let creditBg = "rgba(255,255,255,0.06)";
    if (credit >= 760) { creditColor = "#50c878"; creditBg = "rgba(80,200,120,0.12)"; }
    else if (credit >= 720) { creditColor = "#c9a84c"; creditBg = "rgba(201,168,76,0.12)"; }
    else if (credit >= 680) { creditColor = "#fb923c"; creditBg = "rgba(251,146,60,0.12)"; }
    else if (credit > 0) { creditColor = "#f87171"; creditBg = "rgba(248,113,113,0.12)"; }
    const creditDisplay = credit > 0 ? credit : "—";

    const monthlyInc = c.monthly_income ? "$" + Number(c.monthly_income).toLocaleString() + "/mo" : "—";
    const pipeline = c.pipeline_status || "New Lead";
    const pipeColor = {"New Lead":"rgba(255,255,255,0.5)","Contacted":"#facc15","Qualified":"#50c878","Pre-Qualified":"#50c878","Application":"#60a0ff","Processing":"#c084f0","Closed":"#c9a84c"}[pipeline] || "rgba(255,255,255,0.5)";

    const status = app.status || "draft";
    const statusColors = {draft:"rgba(255,255,255,0.06);color:rgba(255,255,255,0.4)",active:"rgba(201,168,76,0.12);color:#c9a84c",submitted:"rgba(96,160,255,0.12);color:#60a0ff",approved:"rgba(80,200,120,0.12);color:#50c878",closed:"rgba(80,200,120,0.15);color:#3da06a",denied:"rgba(248,113,113,0.12);color:#f87171"};
    const sBadge = statusColors[status] || statusColors.draft;

    const updated = app.updated_at ? new Date(app.updated_at).toLocaleDateString("en-US",{month:"short",day:"numeric"}) : "—";

    const hasContact = app.contact_id && app.contact_id !== "null";
    const navUrl = `${_leadBase}?id=${app.contact_id}`;
    const clickHandler = hasContact ? `console.log('Navigating to:','${navUrl}');window.location.href='${navUrl}'` : `alert('No contact linked to this application.')`;

    return `<div style="background:#111;border:1px solid rgba(255,255,255,0.06);border-radius:12px;overflow:hidden;cursor:pointer;transition:border-color .15s,box-shadow .15s;"
      onclick="${clickHandler}"
      onmouseenter="this.style.borderColor='rgba(201,168,76,0.3)';this.style.boxShadow='0 4px 20px rgba(0,0,0,0.4)'"
      onmouseleave="this.style.borderColor='rgba(255,255,255,0.06)';this.style.boxShadow='none'">
      <div style="display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.04);">
        <div style="width:38px;height:38px;border-radius:50%;background:${AV_BG[avIdx]};color:${AV_FG[avIdx]};font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${initials}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:700;${!hasContact?'color:rgba(255,255,255,0.4);':''}">${name}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${contactLine}</div>
        </div>
        <span style="padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700;text-transform:uppercase;background:${sBadge}">${status}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0;border-bottom:1px solid rgba(255,255,255,0.04);">
        <div style="padding:10px 18px;"><div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:3px;">Loan Type</div><div style="font-size:13px;font-weight:600;">${loanType}</div></div>
        <div style="padding:10px 18px;"><div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:3px;">Loan Amount</div><div style="font-size:13px;font-weight:700;color:#c9a84c;">${loanAmt}</div></div>
        <div style="padding:10px 18px;"><div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:3px;">Property</div><div style="font-size:12px;color:rgba(255,255,255,0.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${propAddr}</div></div>
        <div style="padding:10px 18px;"><div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:3px;">LTV</div><div style="font-size:13px;font-weight:600;">${ltv}</div></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0;">
        <div style="padding:10px 18px;"><div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:3px;">Credit</div><div><span style="padding:2px 8px;border-radius:8px;font-size:12px;font-weight:700;background:${creditBg};color:${creditColor};">${creditDisplay}</span></div></div>
        <div style="padding:10px 18px;"><div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:3px;">Income</div><div style="font-size:12px;color:rgba(255,255,255,0.6);">${monthlyInc}</div></div>
        <div style="padding:10px 18px;"><div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:3px;">Pipeline</div><div><span style="padding:2px 8px;border-radius:8px;font-size:10px;font-weight:600;background:rgba(255,255,255,0.06);color:${pipeColor};">${pipeline}</span></div></div>
        <div style="padding:10px 18px;display:flex;align-items:flex-end;justify-content:space-between;"><div><div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:3px;">Updated</div><div style="font-size:12px;color:rgba(255,255,255,0.5);">${updated}</div></div>${hasContact?`<span style="font-size:11px;color:rgba(201,168,76,0.7);font-weight:600;">View →</span>`:`<span style="font-size:10px;color:rgba(248,113,113,0.5);">No contact</span>`}</div>
      </div>
    </div>`;
  }).join("");
}

// Expose to global scope for inline HTML event handlers
window.filterApplications = function() { filterApplications(); };

// ── FILE VAULT (Documents tab) ────────────────────────────────────
const GDRIVE_BORROWERS_ROOT = "11OLUA6Fu3tNrzWP8O1v_pFjl-UGbzos6";
const GDRIVE_OAUTH_CLIENT_ID = "17691954677-9e7d3rjur37pt5uvb3joordt5qs1usl1.apps.googleusercontent.com";
const GDRIVE_OAUTH_SCOPE = "https://www.googleapis.com/auth/drive";

let _fvContacts = [];
let _fvFilter = "";               // borrower search
let _fvFileFilter = "";           // doc-type filter pill (empty = All)
let _fvSelectedContactId = null;  // currently-selected borrower in left column
let _fvFolderStack = [];          // breadcrumb: [{id, name}, ...]
let _fvFileCounts = {};
let _fvFiles = {};
let _fvFolderCounts = {};          // subfolderId → document count (lazy-loaded, shown as 📄 N)
let _fvViewerState = null; // { contactId, files, index, keyHandler }

// ── Batch tooling state (Convert all / AI Scan / Review & Approve) ──
let _fvBatchBusy = false;          // guards against overlapping batch runs
let _fvReviewQueue = [];           // [{ file, originalName, suggestedName, docType, category, fields, jobId, flagged, ext, contactId, approved }]
let _fvReviewIndex = 0;            // current item in the Review & Approve modal
let _fvReviewBlobUrl = null;       // object URL for the current review preview (revoked on nav/close)
let _fvSelectedIds = new Set();    // file ids the user has checked in the current folder (controls scan/convert scope)

// ── OAUTH (Google Identity Services) ──────────────────────────────
// Returns a fresh OAuth access token scoped to Drive. On first call within
// a tab session this opens the Google consent popup; subsequent calls reuse
// the sessionStorage-cached token until it's within 60s of expiry.
function _fvCachedToken() {
  try {
    const tok = sessionStorage.getItem("gdriveOAuthToken");
    const exp = Number(sessionStorage.getItem("gdriveOAuthExpiry") || 0);
    if (tok && exp > Date.now() + 60000) return tok;
  } catch (_) {}
  return null;
}

function _fvEnsureToken() {
  const cached = _fvCachedToken();
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    if (!(window.google && window.google.accounts && window.google.accounts.oauth2)) {
      return reject(new Error("Google Identity Services not loaded — reload the page"));
    }
    try {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: GDRIVE_OAUTH_CLIENT_ID,
        scope: GDRIVE_OAUTH_SCOPE,
        callback: (resp) => {
          if (resp.error) return reject(new Error(resp.error));
          if (!resp.access_token) return reject(new Error("No access token returned"));
          try {
            sessionStorage.setItem("gdriveOAuthToken", resp.access_token);
            sessionStorage.setItem(
              "gdriveOAuthExpiry",
              String(Date.now() + (Number(resp.expires_in) || 3600) * 1000)
            );
          } catch (_) {}
          resolve(resp.access_token);
        },
        error_callback: (err) => reject(new Error((err && err.message) || "OAuth popup failed"))
      });
      tc.requestAccessToken({ prompt: "" });
    } catch (e) {
      reject(e);
    }
  });
}

async function _fvAuthHeaders(extra) {
  const token = await _fvEnsureToken();
  return Object.assign({ Authorization: "Bearer " + token }, extra || {});
}

// On auth failure (401/403), clear cache so the next call re-prompts.
function _fvClearToken() {
  try {
    sessionStorage.removeItem("gdriveOAuthToken");
    sessionStorage.removeItem("gdriveOAuthExpiry");
  } catch (_) {}
}

async function renderDocuments() {
  const el = document.getElementById("admin-document-table");
  if (!el) return;

  // One-time style block.
  if (!document.getElementById("fv-styles")) {
    const s = document.createElement("style");
    s.id = "fv-styles";
    s.textContent = `
      .fv-pill{background:transparent;border:1px solid #2a2a2a;color:#555;font-size:11px;padding:3px 10px;border-radius:20px;cursor:pointer;white-space:nowrap;transition:all .15s;font-family:inherit;}
      .fv-pill:hover{border-color:#C9A84C55;color:#999;}
      .fv-pill.active{background:#C9A84C1a;border-color:#C9A84C;color:#C9A84C;}
      .fv-borrower-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:10px;cursor:pointer;margin-bottom:6px;border:1px solid transparent;transition:all .15s;background:#111;}
      .fv-borrower-card:hover{background:#161616!important;border-color:#C9A84C44!important;}
      .fv-borrower-card.active{border-color:#C9A84C!important;background:#1a1a14!important;}
      .fv-file-row{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #161616;cursor:pointer;transition:background .1s;border-left:2px solid transparent;}
      .fv-file-row:hover{background:#161616!important;}
      .fv-file-row.active{background:#1a1a14;border-left-color:#C9A84C;}
      @keyframes fvSpin{to{transform:rotate(360deg);}}
      #fv-borrower-list::-webkit-scrollbar,#fv-file-list::-webkit-scrollbar{width:4px;}
      #fv-borrower-list::-webkit-scrollbar-thumb,#fv-file-list::-webkit-scrollbar-thumb{background:#2a2a2a;border-radius:2px;}
      /* Adobe-style PDF toolbar */
      .fv-pdf-tb{display:none;align-items:center;gap:2px;height:36px;padding:0 10px;background:#2D2D2D;border-bottom:1px solid #1a1a1a;flex-shrink:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;}
      .fv-tb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:26px;min-width:26px;padding:0 7px;background:transparent;border:1px solid transparent;border-radius:4px;color:#d8d8d8;cursor:pointer;font-family:inherit;font-size:12px;line-height:1;transition:background .12s,border-color .12s,color .12s;}
      .fv-tb-btn:hover{background:#3d3d3d;color:#fff;}
      .fv-tb-btn:active{background:#454545;}
      .fv-tb-btn.is-active{background:#454545;border-color:#5a5a5a;color:#fff;}
      .fv-tb-btn-save{display:none;background:#1f7a3f;border-color:#268a48;color:#fff;}
      .fv-tb-btn-save:hover{background:#268a48;color:#fff;}
      .fv-tb-btn-ghost{display:none;}
      .fv-tb-label{font-size:11px;font-weight:600;letter-spacing:.2px;}
      .fv-tb-zoom{height:24px;width:54px;padding:0 6px;background:#1f1f1f;border:1px solid #4a4a4a;border-radius:3px;color:#e8e8e8;font-family:inherit;font-size:11px;text-align:center;outline:none;margin:0 2px;}
      .fv-tb-zoom:focus{border-color:#7a7a7a;background:#252525;}
      .fv-tb-sep{display:inline-block;width:1px;height:18px;background:#4a4a4a;margin:0 6px;}
    `;
    document.head.appendChild(s);
  }

  // 2-panel shell: left borrowers (320px) + right panel that toggles between
  // file-list view and viewer view. Viewer chrome is pre-mounted so element
  // lookups never fail on file click.
  el.className = "";
  el.innerHTML = `
    <div id="fv-root" style="display:flex;height:calc(100vh - 80px);min-height:560px;background:#0a0a0a;border-radius:12px;overflow:hidden;border:1px solid #1e1e1e;">

      <!-- LEFT: borrowers (320px) -->
      <div id="fv-panel-left" style="width:320px;flex-shrink:0;border-right:1px solid #1e1e1e;display:flex;flex-direction:column;overflow:hidden;">
        <div style="padding:14px 16px;border-bottom:1px solid #1e1e1e;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span style="color:#C9A84C;font-size:11px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;flex-shrink:0;">File Vault</span>
          <input id="fv-search" type="text" placeholder="Search borrowers..." style="background:#161616;border:1px solid #2a2a2a;color:#ccc;font-size:12px;padding:4px 10px;border-radius:6px;width:160px;outline:none;font-family:inherit;">
        </div>
        <div id="fv-borrower-list" style="flex:1;overflow-y:auto;padding:10px;"></div>
        <div style="padding:10px;border-top:1px solid #1e1e1e;flex-shrink:0;">
          <div id="fv-drop-target" style="border:1.5px dashed #C9A84C33;border-radius:8px;padding:16px;text-align:center;cursor:pointer;background:#0d0d0d;transition:border-color .2s;">
            <div style="font-size:11px;color:#555;">&#8613; Drop files or <span style="color:#C9A84C;cursor:pointer;text-decoration:underline;">browse</span><span style="color:#444;"> · PDF JPG PNG</span></div>
          </div>
          <div id="fv-upload-status" style="margin-top:6px;"></div>
          <input type="file" id="fv-file-input" multiple accept=".pdf,image/*" style="display:none;">
        </div>
      </div>

      <!-- RIGHT: panel with two views (list / viewer) -->
      <div id="fv-panel-right" style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;background:#0a0a0a;">

        <!-- VIEW A: FILE LIST -->
        <div id="fv-view-list" style="display:flex;flex-direction:column;flex:1;overflow:hidden;">
          <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #1e1e1e;flex-shrink:0;flex-wrap:wrap;">
            <button id="fv-folder-back" style="display:none;background:transparent;border:1px solid #2a2a2a;color:#C9A84C;font-size:12px;padding:4px 12px;border-radius:6px;cursor:pointer;align-items:center;gap:4px;white-space:nowrap;flex-shrink:0;font-family:inherit;">&#8592; Back</button>
            <div id="fv-filter-pills" style="display:flex;gap:6px;flex-wrap:wrap;flex:1;min-width:0;">
              <button class="fv-pill active" data-fv-pill="">All</button>
              <button class="fv-pill" data-fv-pill="Pay Stubs">Pay Stubs</button>
              <button class="fv-pill" data-fv-pill="W-2 / Tax Returns">W-2</button>
              <button class="fv-pill" data-fv-pill="Bank Statements">Bank Stmts</button>
              <button class="fv-pill" data-fv-pill="Photo ID">Gov ID</button>
              <button class="fv-pill" data-fv-pill="Insurance Policy">Insurance</button>
              <button class="fv-pill" data-fv-pill="Credit Report">Credit</button>
              <button class="fv-pill" data-fv-pill="Other">Other</button>
            </div>
            <label id="fv-select-all-wrap" title="Select / deselect all files in this folder" style="display:flex;align-items:center;gap:6px;flex-shrink:0;color:#999;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;">
              <input type="checkbox" id="fv-select-all" style="accent-color:#C9A84C;width:14px;height:14px;cursor:pointer;">
              <span>Select all</span>
              <span id="fv-sel-count" style="color:#C9A84C;font-size:11px;"></span>
            </label>
            <div style="display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap;">
              <button id="fv-convert-all" title="Convert non-PDF files to PDF (selected files only if any are checked)" style="background:#1a1a1a;border:1px solid #C9A84C44;color:#C9A84C;font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer;font-family:inherit;white-space:nowrap;">&#128196; Convert all to PDF</button>
              <button id="fv-ai-scan" title="OCR every file and suggest clean names" style="background:#1a1a1a;border:1px solid #C9A84C44;color:#C9A84C;font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer;font-family:inherit;white-space:nowrap;">&#10024; AI Scan &amp; Rename</button>
              <button id="fv-review" title="Review &amp; approve the AI-suggested names" style="background:#1a1a1a;border:1px solid #C9A84C44;color:#C9A84C;font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer;font-family:inherit;white-space:nowrap;">&#9745; Review</button>
              <button id="fv-upload-btn" style="background:#C9A84C;border:none;color:#000;font-size:12px;font-weight:700;padding:6px 14px;border-radius:6px;cursor:pointer;font-family:inherit;">+ Upload</button>
              <a id="fv-open-drive-link" href="#" target="_blank" rel="noopener" style="background:#1a1a1a;border:1px solid #C9A84C44;color:#C9A84C;font-size:12px;padding:6px 12px;border-radius:6px;text-decoration:none;white-space:nowrap;">&#128193; Drive</a>
            </div>
          </div>
          <div id="fv-file-list" style="flex:1;overflow-y:auto;">
            <div style="padding:48px 20px;text-align:center;color:#444;font-size:13px;">Select a borrower to view files</div>
          </div>
        </div>

        <!-- VIEW B: VIEWER (hidden by default) -->
        <div id="fv-view-viewer" style="display:none;flex-direction:column;flex:1;overflow:hidden;">
          <div id="fv-viewer-header" style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:#111;border-bottom:1px solid #222;flex-shrink:0;">
            <button id="fv-viewer-back" title="Back to file list" style="background:transparent;border:1px solid #2a2a2a;color:#888;cursor:pointer;font-size:12px;padding:4px 12px;border-radius:6px;flex-shrink:0;white-space:nowrap;font-family:inherit;">&#8592; Files</button>
            <span id="fv-viewer-title" style="color:#C9A84C;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;"></span>
            <button id="fv-viewer-rename" title="Rename file" style="background:transparent;border:none;color:#C9A84C;cursor:pointer;font-size:17px;padding:0 6px;line-height:1;flex-shrink:0;font-family:inherit;">&#9998;</button>
            <span id="fv-viewer-saving" style="display:none;width:12px;height:12px;border:2px solid #C9A84C;border-top-color:transparent;border-radius:50%;animation:fvSpin .7s linear infinite;flex-shrink:0;"></span>
            <select id="fv-doc-type" style="background:#1a1a1a;border:1px solid #C9A84C44;color:#C9A84C;font-size:11px;border-radius:20px;padding:3px 10px;cursor:pointer;outline:none;max-width:140px;flex-shrink:0;font-family:inherit;">
              <option value="">-- Type --</option>
              <option>Pay Stubs</option>
              <option>W-2 / Tax Returns</option>
              <option>Bank Statements</option>
              <option>1099 / Self-Employed</option>
              <option>Credit Report</option>
              <option>Photo ID</option>
              <option>Insurance Policy</option>
              <option>Purchase Agreement</option>
              <option>Title / Escrow</option>
              <option>Appraisal</option>
              <option>HOA Docs</option>
              <option>Loan Application</option>
              <option>Gift Letter</option>
              <option>VOE / Employment Letter</option>
              <option>Other</option>
            </select>
            <button id="fv-viewer-download" title="Download" style="background:#1a1a1a;border:1px solid #2a2a2a;color:#C9A84C;cursor:pointer;font-size:15px;padding:4px 10px;border-radius:6px;flex-shrink:0;font-family:inherit;">&#8681;</button>
            <button id="fv-viewer-openlink" title="Open in Drive" style="background:#1a1a1a;border:1px solid #2a2a2a;color:#C9A84C;cursor:pointer;font-size:15px;padding:4px 10px;border-radius:6px;flex-shrink:0;font-family:inherit;">&#8599;</button>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 16px;background:#0d0d0d;border-bottom:1px solid #1a1a1a;flex-shrink:0;">
            <button id="fv-viewer-prev" style="background:transparent;border:1px solid #2a2a2a;color:#666;cursor:pointer;padding:4px 16px;border-radius:6px;font-size:13px;font-family:inherit;">&#8592; Prev</button>
            <span id="fv-viewer-counter" style="color:#444;font-size:12px;"></span>
            <button id="fv-viewer-next" style="background:transparent;border:1px solid #2a2a2a;color:#666;cursor:pointer;padding:4px 16px;border-radius:6px;font-size:13px;font-family:inherit;">Next &#8594;</button>
          </div>
          <!-- PDF editing toolbar — Adobe Acrobat style, only visible when a PDF is loaded -->
          <div id="fv-pdf-toolbar" class="fv-pdf-tb">
            <button id="fv-pdf-zoom-out" type="button" class="fv-tb-btn" title="Zoom out" aria-label="Zoom out"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="8" x2="13" y2="8"/></svg></button>
            <input id="fv-pdf-zoom-level" class="fv-tb-zoom" type="text" value="100%" title="Click to enter a zoom percentage">
            <button id="fv-pdf-zoom-in" type="button" class="fv-tb-btn" title="Zoom in" aria-label="Zoom in"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="8" x2="13" y2="8"/><line x1="8" y1="3" x2="8" y2="13"/></svg></button>
            <span class="fv-tb-sep"></span>
            <button id="fv-pdf-rotate-btn" type="button" class="fv-tb-btn" title="Rotate 90&deg; clockwise" aria-label="Rotate 90 degrees"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><polyline points="13.5 2.5 13.5 5 11 5"/></svg></button>
            <button id="fv-pdf-save-rot-btn" type="button" class="fv-tb-btn fv-tb-btn-save" title="Save rotation to file" aria-label="Save rotation"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5h-9a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-9z"/><polyline points="4 1.5 4 5.5 10 5.5 10 1.5"/><rect x="4" y="9" width="8" height="5"/></svg><span class="fv-tb-label">Save</span></button>
            <span class="fv-tb-sep"></span>
            <button id="fv-pdf-crop-btn" type="button" class="fv-tb-btn" title="Crop page" aria-label="Crop"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1v10a1 1 0 0 0 1 1h10"/><path d="M1 4h10a1 1 0 0 1 1 1v10"/></svg></button>
            <button id="fv-pdf-crop-apply-btn" type="button" class="fv-tb-btn fv-tb-btn-save" title="Apply crop"><span class="fv-tb-label">Apply</span></button>
            <button id="fv-pdf-crop-cancel-btn" type="button" class="fv-tb-btn fv-tb-btn-ghost" title="Cancel crop"><span class="fv-tb-label">Cancel</span></button>
          </div>
          <div id="fv-viewer-host" style="flex:1;overflow:auto;background:#0a0a0a;position:relative;">
            <div id="fv-viewer-canvas-wrap" style="display:none;padding:16px;position:relative;"></div>
            <iframe id="fv-viewer-iframe" style="width:100%;height:100%;border:none;display:block;" src="about:blank"></iframe>
          </div>
        </div>
      </div>
    </div>
  `;

  _fvBindSearch();
  _fvBindPanels();

  // Diagnostic — confirm the pencil button made it into the DOM (always should).
  const _dbgRename = document.getElementById("fv-viewer-rename");
  console.log("[FileVault][debug] rename btn after shell mount:", _dbgRename);
  if (!_dbgRename) {
    console.error("[FileVault] fv-viewer-rename button NOT FOUND after shell render — DOM template failed.");
  }

  await _fvLoadContacts();
  _fvRenderBorrowerList();

  // Lazy-refresh file counts so each borrower card shows accurate badge.
  _fvContacts.forEach((c) => {
    if (c.gdrive_folder_id && _fvFileCounts[c.gdrive_folder_id] == null) {
      _fvRefreshCount(c.id, c.gdrive_folder_id);
    }
  });
}

// Wire every interactive element in the 2-panel shell ONCE at mount. All
// .onclick assignments so re-wiring replaces the slot, no stacking.
function _fvBindPanels() {
  // Upload button (top of the right panel file-list view) + dropzone + file
  // input all trigger uploads for the currently-selected borrower.
  const uploadBtn = document.getElementById("fv-upload-btn");
  const dropTarget = document.getElementById("fv-drop-target");
  const input = document.getElementById("fv-file-input");

  // Back button — switches from viewer view to file-list view.
  const backBtn = document.getElementById("fv-viewer-back");
  if (backBtn) backBtn.onclick = _fvShowFileList;

  // Folder breadcrumb back button — pops up one level in the folder stack.
  const folderBackBtn = document.getElementById("fv-folder-back");
  if (folderBackBtn) folderBackBtn.onclick = _fvFolderBack;

  const pickFiles = () => {
    if (!_fvSelectedContactId) { _fvShowToast("Pick a borrower first"); return; }
    if (input) input.click();
  };
  if (uploadBtn) uploadBtn.onclick = pickFiles;
  if (dropTarget) dropTarget.onclick = pickFiles;

  // Batch tools — Convert all to PDF / AI Scan & Rename / Review & Approve.
  const convertAllBtn = document.getElementById("fv-convert-all");
  if (convertAllBtn) convertAllBtn.onclick = _fvConvertAllToPdf;
  const aiScanBtn = document.getElementById("fv-ai-scan");
  if (aiScanBtn) aiScanBtn.onclick = _fvScanAndRename;
  const reviewBtn = document.getElementById("fv-review");
  if (reviewBtn) reviewBtn.onclick = _fvOpenReviewModal;
  // Select all / none toggle (operates on the non-folder files in the current view).
  const selAll = document.getElementById("fv-select-all");
  if (selAll) selAll.onchange = () => {
    const files = _fvCurrentFileObjects();
    if (selAll.checked) files.forEach((f) => _fvSelectedIds.add(f.id));
    else files.forEach((f) => _fvSelectedIds.delete(f.id));
    document.querySelectorAll(".fv-row-check").forEach((cb) => { cb.checked = _fvSelectedIds.has(cb.dataset.id); });
    _fvUpdateSelectionUI();
  };

  if (dropTarget) {
    dropTarget.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropTarget.style.borderColor = "#C9A84C";
      dropTarget.style.background = "rgba(201,168,76,0.08)";
    });
    dropTarget.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dropTarget.style.borderColor = "#C9A84C33";
      dropTarget.style.background = "#0d0d0d";
    });
    dropTarget.addEventListener("drop", (e) => {
      e.preventDefault();
      dropTarget.style.borderColor = "#C9A84C33";
      dropTarget.style.background = "#0d0d0d";
      if (!_fvSelectedContactId) { _fvShowToast("Pick a borrower first"); return; }
      const contact = _fvContacts.find((c) => c.id === _fvSelectedContactId);
      if (contact && e.dataTransfer && e.dataTransfer.files.length) {
        _fvUploadFiles(contact, e.dataTransfer.files);
      }
    });
  }

  if (input) {
    input.onchange = () => {
      if (!_fvSelectedContactId) return;
      const contact = _fvContacts.find((c) => c.id === _fvSelectedContactId);
      if (contact && input.files && input.files.length) {
        _fvUploadFiles(contact, input.files);
      }
      input.value = "";
    };
  }

  // Filter pills (inside the file-list view)
  document.querySelectorAll("[data-fv-pill]").forEach((pill) => {
    pill.onclick = () => {
      _fvFileFilter = pill.dataset.fvPill;
      document.querySelectorAll("[data-fv-pill]").forEach((p) => p.classList.toggle("active", p === pill));
      const contact = _fvContacts.find((c) => c.id === _fvSelectedContactId);
      if (contact) _fvRenderFileListPanel(contact);
    };
  });

  // Viewer header buttons — wired ONCE, read the current file from state.
  const renameBtn = document.getElementById("fv-viewer-rename");
  if (renameBtn) {
    renameBtn.onclick = () => {
      if (!_fvViewerState) return;
      const f = _fvViewerState.files[_fvViewerState.index];
      if (f) _fvStartRenameInViewer(f);
    };
  }
  const downloadBtn = document.getElementById("fv-viewer-download");
  if (downloadBtn) {
    downloadBtn.onclick = () => {
      if (!_fvViewerState) return;
      const f = _fvViewerState.files[_fvViewerState.index];
      if (f) window.open((window.pinGoogleUrl ? window.pinGoogleUrl : (u)=>u)(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(f.id)}`), "_blank", "noopener");
    };
  }
  const openlinkBtn = document.getElementById("fv-viewer-openlink");
  if (openlinkBtn) {
    openlinkBtn.onclick = () => {
      if (!_fvViewerState) return;
      const f = _fvViewerState.files[_fvViewerState.index];
      if (f) window.open((window.pinGoogleUrl ? window.pinGoogleUrl : (u)=>u)(f.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(f.id)}/view`), "_blank", "noopener");
    };
  }
  const prevBtn = document.getElementById("fv-viewer-prev");
  if (prevBtn) prevBtn.onclick = _fvViewerPrev;
  const nextBtn = document.getElementById("fv-viewer-next");
  if (nextBtn) nextBtn.onclick = _fvViewerNext;

  // PDF editing toolbar
  const zoomOut = document.getElementById("fv-pdf-zoom-out");
  if (zoomOut) zoomOut.onclick = () => _fvPdfZoom(-0.2);
  const zoomIn = document.getElementById("fv-pdf-zoom-in");
  if (zoomIn) zoomIn.onclick = () => _fvPdfZoom(0.2);
  const zoomInput = document.getElementById("fv-pdf-zoom-level");
  if (zoomInput) {
    zoomInput.onfocus = () => zoomInput.select();
    const commit = () => {
      const raw = (zoomInput.value || "").replace(/[^0-9.]/g, "");
      const pct = parseFloat(raw);
      if (Number.isFinite(pct) && pct > 0) _fvPdfZoomTo(pct);
      else _fvSyncZoomInput();
    };
    zoomInput.onblur = commit;
    zoomInput.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); zoomInput.blur(); }
      else if (e.key === "Escape") { _fvSyncZoomInput(); zoomInput.blur(); }
    };
  }
  const rotateBtn = document.getElementById("fv-pdf-rotate-btn");
  if (rotateBtn) rotateBtn.onclick = _fvPdfRotate;
  const saveRotBtn = document.getElementById("fv-pdf-save-rot-btn");
  if (saveRotBtn) saveRotBtn.onclick = _fvPdfSaveRotation;
  const cropBtn = document.getElementById("fv-pdf-crop-btn");
  if (cropBtn) cropBtn.onclick = _fvPdfToggleCrop;
  const cropApply = document.getElementById("fv-pdf-crop-apply-btn");
  if (cropApply) cropApply.onclick = _fvPdfApplyCrop;
  const cropCancel = document.getElementById("fv-pdf-crop-cancel-btn");
  if (cropCancel) cropCancel.onclick = _fvPdfExitCropMode;

  const typeSel = document.getElementById("fv-doc-type");
  if (typeSel) {
    typeSel.onchange = (e) => {
      if (!_fvViewerState) return;
      const f = _fvViewerState.files[_fvViewerState.index];
      if (f) _fvSaveDocType(e, f);
    };
  }

  // Open in Drive link in the file-list header — folder URL for selected borrower.
  const openDriveLink = document.getElementById("fv-open-drive-link");
  if (openDriveLink) {
    openDriveLink.onclick = (e) => {
      const contact = _fvContacts.find((c) => c.id === _fvSelectedContactId);
      if (!contact || !contact.gdrive_folder_url) { e.preventDefault(); _fvShowToast("No folder linked"); }
    };
  }

  // Keyboard navigation — only fires when the viewer view is shown.
  if (!document._fvKeyBound) {
    document._fvKeyBound = true;
    document.addEventListener("keydown", (e) => {
      const viewerView = document.getElementById("fv-view-viewer");
      if (!viewerView || viewerView.style.display !== "flex") return;
      if (e.key === "Escape") _fvShowFileList();
      else if (e.key === "ArrowLeft") _fvViewerPrev();
      else if (e.key === "ArrowRight") _fvViewerNext();
    });
  }
}

async function _fvLoadContacts() {
  const { url, key, auth } = getSupabaseConfig();
  try {
    const res = await fetch(
      `${url}/rest/v1/contacts?select=id,first_name,last_name,email,pipeline_status,gdrive_folder_id,gdrive_folder_url&order=last_name.asc.nullslast`,
      { headers: { apikey: key, Authorization: `Bearer ${auth}` } }
    );
    const data = await res.json();
    _fvContacts = Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("[FileVault] contacts load failed:", e);
    _fvContacts = [];
  }
}

function _fvBindSearch() {
  const inp = document.getElementById("fv-search");
  if (!inp || inp._fvBound) return;
  inp._fvBound = true;
  inp.addEventListener("input", (e) => {
    _fvFilter = (e.target.value || "").trim().toLowerCase();
    _fvRenderBorrowerList();
  });
}

function _fvFiltered() {
  if (!_fvFilter) return _fvContacts;
  return _fvContacts.filter((c) => {
    const name = `${c.first_name || ""} ${c.last_name || ""}`.toLowerCase();
    const email = (c.email || "").toLowerCase();
    return name.includes(_fvFilter) || email.includes(_fvFilter);
  });
}

function _fvPipelineColor(status) {
  const m = {
    "New Lead": "#6B6B7A", "Contacted": "#5AA0E0", "Pre-Approved": "#C9A84C",
    "Under Contract": "#AB7FE0", "Processing": "#E07F50", "Clear to Close": "#52C87A",
    "Closed": "#3AB06A", "Lost": "#E05252"
  };
  return m[status] || "#6B6B7A";
}

function _fvInitials(c) {
  return (((c.first_name || "").charAt(0) + (c.last_name || "").charAt(0)).toUpperCase()) || "?";
}

function _fvRenderBorrowerList() {
  const listEl = document.getElementById("fv-borrower-list");
  if (!listEl) return;
  const summary = document.getElementById("fv-summary");
  if (summary) {
    const withFolder = _fvContacts.filter((c) => c.gdrive_folder_id).length;
    const without = _fvContacts.length - withFolder;
    summary.innerHTML = `
      <span><strong style="color:#eee;">${_fvContacts.length}</strong> borrowers</span>
      <span><strong style="color:#C9A84C;">${withFolder}</strong> with folders</span>
      <span><strong style="color:#E05252;">${without}</strong> no folder</span>
    `;
  }
  const list = _fvFiltered();
  if (!list.length) {
    listEl.innerHTML = '<div style="padding:24px 8px;text-align:center;color:#555;font-size:.85rem;">No borrowers match your search.</div>';
    return;
  }
  listEl.innerHTML = list.map(_fvBorrowerCardHtml).join("");
  listEl.querySelectorAll("[data-fv-borrower]").forEach((card) => {
    card.onclick = (e) => {
      // Let the Drive-folder link handle its own click and stop propagation
      if (e.target && e.target.closest && e.target.closest("[data-fv-drive-link]")) return;
      const id = card.dataset.fvBorrower;
      const contact = _fvContacts.find((c) => String(c.id) === String(id));
      if (contact) _fvSelectBorrower(contact);
    };
  });
  listEl.querySelectorAll("[data-fv-create]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.fvCreate;
      const contact = _fvContacts.find((c) => String(c.id) === String(id));
      if (contact) _fvCreateFolder(contact, btn);
    };
  });
}

function _fvBorrowerCardHtml(c) {
  const name = `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Unnamed";
  const initials = _fvInitials(c);
  const pipeline = c.pipeline_status || "New Lead";
  const pipeColor = _fvPipelineColor(pipeline);
  const hasFolder = !!c.gdrive_folder_id;
  const count = hasFolder ? (_fvFileCounts[c.gdrive_folder_id] ?? "…") : 0;
  const isActive = String(c.id) === String(_fvSelectedContactId);

  const folderLink = c.gdrive_folder_url
    ? `<a href="${_fvEscape((window.pinGoogleUrl ? window.pinGoogleUrl : (u)=>u)(c.gdrive_folder_url))}" target="_blank" rel="noopener" data-fv-drive-link onclick="event.stopPropagation()" style="color:#C9A84C77;font-size:16px;text-decoration:none;flex-shrink:0;padding:4px;" title="Open Drive folder">&#128193;</a>`
    : `<button type="button" data-fv-create="${_fvEscape(c.id)}" title="Create folder" style="background:transparent;border:1px solid #C9A84C44;color:#C9A84C;font-size:10px;padding:3px 8px;border-radius:12px;cursor:pointer;flex-shrink:0;font-family:inherit;">+ folder</button>`;

  return `
    <div class="fv-borrower-card${isActive ? ' active' : ''}" data-fv-borrower="${_fvEscape(c.id)}" style="background:#161616;border:1px solid #2a2a2a;border-radius:10px;padding:14px;margin-bottom:8px;cursor:pointer;transition:border-color .15s;display:flex;align-items:center;gap:12px;">
      <div style="width:40px;height:40px;border-radius:50%;background:#C9A84C22;border:1px solid #C9A84C44;display:flex;align-items:center;justify-content:center;color:#C9A84C;font-size:13px;font-weight:600;flex-shrink:0;">${_fvEscape(initials)}</div>
      <div style="flex:1;min-width:0;">
        <div style="color:#e8e8e8;font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_fvEscape(name)}</div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:3px;">
          <span style="font-size:10px;padding:2px 7px;border-radius:20px;background:${pipeColor}22;color:${pipeColor};font-weight:500;text-transform:uppercase;letter-spacing:.4px;">${_fvEscape(pipeline)}</span>
          <span class="fv-borrower-count" data-fv-count="${_fvEscape(c.id)}" style="font-size:11px;color:#555;">${hasFolder ? count + ' files' : 'no folder'}</span>
        </div>
      </div>
      ${folderLink}
    </div>
  `;
}

// Click handler: select a borrower → load files → populate file-list view.
// Always switches the right panel back to the list view (even if the viewer
// was open on another file).
async function _fvSelectBorrower(contact) {
  _fvSelectedContactId = contact.id;
  _fvFileFilter = "";
  _fvSelectedIds.clear(); // selection is per-folder; reset when switching borrowers
  _fvFolderStack = [];
  _fvUpdateBreadcrumb();
  _fvShowFileList();
  // Reset filter pill active state
  document.querySelectorAll("[data-fv-pill]").forEach((p) => p.classList.toggle("active", p.dataset.fvPill === ""));
  // Highlight the active borrower card
  document.querySelectorAll(".fv-borrower-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.fvBorrower === String(contact.id));
  });
  // Open-in-drive link in the file-list header
  const openDriveLink = document.getElementById("fv-open-drive-link");
  if (openDriveLink) openDriveLink.href = contact.gdrive_folder_url ? (window.pinGoogleUrl ? window.pinGoogleUrl(contact.gdrive_folder_url) : contact.gdrive_folder_url) : "#";

  const fileListEl = document.getElementById("fv-file-list");
  if (!fileListEl) return;

  if (!contact.gdrive_folder_id) {
    fileListEl.innerHTML = '<div style="padding:40px 20px;text-align:center;color:#555;font-size:12px;">No Drive folder for this borrower.<br>Click <strong style="color:#C9A84C;">+ folder</strong> on the card to create one.</div>';
    return;
  }

  fileListEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;padding:40px 20px;color:#666;font-size:12px;"><span style="width:14px;height:14px;border:2px solid #C9A84C;border-top-color:transparent;border-radius:50%;animation:fvSpin .7s linear infinite;margin-right:8px;"></span>Loading files…</div>`;
  await _fvLoadFiles(contact.gdrive_folder_id);
  _fvRenderFileListPanel(contact);

  const countSpan = document.querySelector(`[data-fv-count="${contact.id}"]`);
  if (countSpan) countSpan.textContent = (_fvFileCounts[contact.gdrive_folder_id] || 0) + " files";

  // Subscribe to borrower-portal uploads for this contact so the file list
  // refreshes the moment they push something new — no manual refresh needed.
  _fvSubscribeContactUploads(contact);
}

// ── REALTIME: borrower portal uploads ──────────────────────────────────
// Listens to INSERTs on uploaded_documents filtered by contact_id. On hit:
// toast, refetch Drive folder, refresh file list + borrower badge counts.
// Only one channel is active at a time — switching borrowers (or closing
// the vault) tears down the previous subscription first.
let _fvRealtimeChannel = null;

async function _fvSubscribeContactUploads(contact) {
  if (!contact || !contact.id) return;
  await _fvUnsubscribeContactUploads();
  try {
    const { supabase } = await import("/api/supabase-client.js");
    const channelName = "fv-uploads-" + contact.id;
    _fvRealtimeChannel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "uploaded_documents",
          filter: `contact_id=eq.${contact.id}`,
        },
        async (payload) => {
          // Stale-callback guard: the user may have switched borrowers
          // between subscribe() and the first event firing.
          if (String(_fvSelectedContactId) !== String(contact.id)) return;
          const docName = (payload && payload.new && (payload.new.file_name || payload.new.name)) || "a file";
          const borrowerName =
            contact.name ||
            [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() ||
            contact.email ||
            "borrower";
          _fvShowToast("📄 New document uploaded by " + borrowerName + ": " + docName);
          if (contact.gdrive_folder_id) {
            await _fvLoadFiles(contact.gdrive_folder_id);
            _fvRenderFileListPanel(contact);
            _fvRenderBorrowerList();
          }
        }
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("[FileVault][realtime] channel status:", status);
        }
      });
  } catch (e) {
    console.warn("[FileVault][realtime] subscribe failed:", e);
    _fvRealtimeChannel = null;
  }
}

async function _fvUnsubscribeContactUploads() {
  if (!_fvRealtimeChannel) return;
  const ch = _fvRealtimeChannel;
  _fvRealtimeChannel = null;
  try {
    const { supabase } = await import("/api/supabase-client.js");
    await supabase.removeChannel(ch);
  } catch (e) {
    console.warn("[FileVault][realtime] unsubscribe failed:", e);
  }
}

// Upload a File/Blob directly to Drive using the OAuth token (no proxy).
// Builds a multipart/related body by hand: JSON metadata + raw file bytes.
async function _fvUploadOne(folderId, file, nameOverride) {
  const fileName = nameOverride || file.name || "upload";
  console.log("[FileVault][uploadOne] called", fileName, file.type, file.size, "folder:", folderId);
  try {
    const token = await _fvEnsureToken();
    const boundary = "fv_" + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const encoder = new TextEncoder();
    const head = encoder.encode(
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      metadata + `\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${file.type || "application/octet-stream"}\r\n\r\n`
    );
    const tail = encoder.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + fileBytes.length + tail.length);
    body.set(head, 0);
    body.set(fileBytes, head.length);
    body.set(tail, head.length + fileBytes.length);

    const res = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,webContentLink,size,modifiedTime",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": `multipart/related; boundary=${boundary}`
        },
        body
      }
    );
    if (res.status === 401 || res.status === 403) _fvClearToken();
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) {
      const msg = (data.error && data.error.message) || `HTTP ${res.status}`;
      return { ok: false, name: fileName, error: msg };
    }
    return { ok: true, name: fileName, file: data };
  } catch (e) {
    return { ok: false, name: fileName, error: e.message || "network error" };
  }
}

// Convert an image File to a PDF via the convert-to-pdf edge function, then
// upload the PDF to Drive. Falls back to uploading the raw image if the
// edge function fails for any reason.
async function _fvHandleImageFile(file, folderId) {
  const originalName = file.name || "upload";
  try {
    _fvShowToast(`Converting ${originalName} to PDF...`);
    console.log("[FileVault][imgUpload] start", originalName, file.type, file.size);

    // Read the image as base64 (strip the data URL prefix).
    const b64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || "");
        const comma = s.indexOf(",");
        resolve(comma >= 0 ? s.slice(comma + 1) : s);
      };
      r.onerror = () => reject(r.error || new Error("image read failed"));
      r.readAsDataURL(file);
    });

    const res = await fetch(
      "https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/convert-to-pdf",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_base64: b64,
          file_name: originalName,
          mime_type: file.type || "application/octet-stream",
        }),
      }
    );
    if (!res.ok) throw new Error(`convert-to-pdf HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.pdf_base64) throw new Error("convert-to-pdf returned no pdf_base64");

    // Decode base64 → bytes.
    const bin = atob(data.pdf_base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const uploadName = originalName.replace(/\.[a-zA-Z0-9]{1,6}$/, "") + ".pdf";
    const uploadFile = new File([bytes], uploadName, { type: "application/pdf" });
    console.log("[FileVault][imgUpload] uploading as", uploadName, "size", bytes.length);

    const result = await _fvUploadOne(folderId, uploadFile);
    console.log("[FileVault][imgUpload] upload result", result);
    if (result && result.ok) {
      _fvShowToast(`✓ ${uploadName} uploaded`);
      return result;
    }
    throw new Error((result && result.error) || "upload failed");
  } catch (err) {
    console.warn("[FileVault][imgUpload] convert failed, uploading original:", err);
    _fvShowToast(`Conversion failed, uploading original...`);
    try {
      const result = await _fvUploadOne(folderId, file);
      if (result && result.ok) {
        _fvShowToast(`✓ ${originalName} uploaded (original)`);
        return result;
      }
      return result || { ok: false, name: originalName, error: "upload failed" };
    } catch (e2) {
      _fvShowToast(`Upload failed: ${e2.message || e2}`);
      return { ok: false, name: originalName, error: e2.message || String(e2) };
    }
  }
}

async function _fvUploadFiles(contact, files, targetFolderId) {
  if (!contact.gdrive_folder_id) { _fvShowToast("No folder yet — create one first"); return; }
  if (!files || !files.length) return;

  // Destination priority: explicit target (folder-row drop) → folder currently open → borrower root.
  const folderId = targetFolderId || window._fvCurrentFolderId || contact.gdrive_folder_id;
  delete _fvFolderCounts[folderId]; // force the 📄 badge to refresh after this upload

  // Acquire the Google Drive token now, while we still have the user gesture from the
  // drop/click, so a blocked or expired consent popup fails loudly instead of silently per file.
  try {
    await _fvEnsureToken();
  } catch (e) {
    _fvShowToast("Google Drive access needed — allow the popup, then drop again");
    return;
  }
  // Single upload-status element in the left panel.
  const status = document.getElementById("fv-upload-status");

  const list = Array.from(files);
  const rowIds = list.map((_, i) => `fv-u-${contact.id}-${Date.now()}-${i}`);
  if (status) {
    status.innerHTML = list.map((f, i) => `
      <div id="${rowIds[i]}" style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04);border-radius:6px;margin-bottom:4px;font-size:.72rem;color:#eee;">
        <span style="width:10px;height:10px;border:2px solid #C9A84C;border-top-color:transparent;border-radius:50%;animation:fvSpin .7s linear infinite;flex-shrink:0;"></span>
        <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Uploading ${(f.name || "file").replace(/</g, "&lt;")}…</span>
      </div>
    `).join("");
  }

  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const isImage = (file.type || "").startsWith("image/");
    let result;
    if (isImage) {
      result = await _fvHandleImageFile(file, folderId);
    } else {
      _fvShowToast(`Uploading ${file.name}...`);
      result = await _fvUploadOne(folderId, file);
    }

    const row = document.getElementById(rowIds[i]);
    if (row) {
      if (result && result.ok) {
        row.innerHTML = `
          <span style="color:#52C87A;flex-shrink:0;">✓</span>
          <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#cfe7d7;">${((result.name) || file.name || "file").replace(/</g, "&lt;")}</span>
        `;
      } else {
        const errMsg = (result && result.error) || "unknown";
        row.innerHTML = `
          <span style="color:#E05252;flex-shrink:0;">✗</span>
          <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#f0bdbd;" title="${String(errMsg).replace(/"/g, "&quot;")}">${(file.name || "file").replace(/</g, "&lt;")}</span>
        `;
      }
    }
    if (result && result.ok) okCount++;
    else {
      failCount++;
      console.error("[FileVault] upload failed:", file.name, result && result.error);
    }

    // Refresh the Drive listing + right panel after each file.
    await _fvLoadFiles(folderId);
    if (String(_fvSelectedContactId) === String(contact.id)) {
      _fvRenderRightFileList(contact);
    }
  }

  _fvShowToast(failCount ? `${okCount} uploaded, ${failCount} failed` : `${okCount} uploaded ✓`);

  // Update left-list file count pill for this borrower.
  const countSpan = document.querySelector(`[data-fv-count="${contact.id}"]`);
  if (countSpan) countSpan.textContent = (_fvFileCounts[folderId] || 0) + " files";
}

// Dropzone is wired once in _fvBindPanels() against the single #fv-drop-target
// in Panel 2. No per-card dropzones.
function _fvBindDropzone(_contact) { /* no-op — see _fvBindPanels() */ }

// Creates a GDrive folder for a contact via the n8n webhook. The workflow
// creates the folder in Google Drive and writes gdrive_folder_id +
// gdrive_folder_url back to the contacts row. We poll Supabase for up to
// 10 seconds waiting for the writeback.
async function _fvCreateFolder(contact, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    const res = await fetch("https://ratesandrealty.app.n8n.cloud/webhook/contact-folder-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact_id: contact.id,
        first_name: contact.first_name || "",
        last_name: contact.last_name || ""
      })
    });
    if (!res.ok) throw new Error("Webhook failed: HTTP " + res.status);

    // Poll for the writeback — n8n creates the folder and PATCHes contacts.
    const { url, key, auth } = getSupabaseConfig();
    let folderId = null, folderUrl = null;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const pollRes = await fetch(
        `${url}/rest/v1/contacts?id=eq.${encodeURIComponent(contact.id)}&select=gdrive_folder_id,gdrive_folder_url`,
        { headers: { apikey: key, Authorization: "Bearer " + auth } }
      );
      const rows = await pollRes.json();
      if (rows && rows[0] && rows[0].gdrive_folder_id) {
        folderId = rows[0].gdrive_folder_id;
        folderUrl = rows[0].gdrive_folder_url;
        break;
      }
    }

    if (folderId) {
      contact.gdrive_folder_id = folderId;
      contact.gdrive_folder_url = folderUrl;
      _fvFileCounts[folderId] = 0;
      _fvFiles[folderId] = [];
      _fvRenderBorrowerList();
      _fvSelectBorrower(contact);
      _fvShowToast("✓ Drive folder created!");
    } else {
      _fvShowToast("Folder created — refreshing…");
      setTimeout(() => window.location.reload(), 2000);
    }
  } catch (e) {
    console.error("[FileVault] create folder failed:", e);
    if (btn) { btn.disabled = false; btn.textContent = "+ folder"; }
    _fvShowToast("Failed to create folder: " + (e.message || "unknown"));
  }
}

// Legacy shim — old borrower card had an expand toggle. The new flow is
// direct: click the borrower card → select it → load + show files.
async function _fvToggleFiles(contact) { return _fvSelectBorrower(contact); }

async function _fvLoadFiles(folderId) {
  // Store globally so row action handlers (PDF convert, etc) can find the
  // current folder without needing the contact plumbed through.
  window._fvCurrentFolderId = folderId;
  try {
    const headers = await _fvAuthHeaders();
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const fields = encodeURIComponent(
      "files(id,name,mimeType,webViewLink,webContentLink,size,createdTime,modifiedTime,iconLink,thumbnailLink,parents,appProperties)"
    );
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=500&orderBy=name`,
      { headers }
    );
    if (res.status === 401 || res.status === 403) { _fvClearToken(); throw new Error("Drive auth failed — retry upload to re-auth"); }
    const data = await res.json();
    const files = Array.isArray(data.files) ? data.files : [];
    _fvFiles[folderId] = files;
    _fvFileCounts[folderId] = files.length;
  } catch (e) {
    console.error("[FileVault] list files failed:", e);
    _fvFiles[folderId] = _fvFiles[folderId] || [];
    _fvFileCounts[folderId] = _fvFileCounts[folderId] ?? 0;
  }
}

async function _fvRefreshCount(contactId, folderId) {
  await _fvLoadFiles(folderId);
  const countSpan = document.querySelector(`[data-fv-count="${contactId}"]`);
  if (countSpan) countSpan.textContent = (_fvFileCounts[folderId] || 0) + " files";
}

// Label for a folder row's subtitle: 📄 N once counted, "Folder" until then.
function _fvFolderCountLabel(n) {
  if (typeof n !== "number") return "Folder";
  return "📄 " + n; // 📄 N
}

// Count the documents inside each given subfolder in ONE Drive query, then paint badges.
async function _fvLoadFolderCounts(folderIds) {
  // Never trigger an OAuth popup from a render — only run if a token is already cached.
  if (typeof _fvCachedToken === "function" && !_fvCachedToken()) return;
  const ids = (folderIds || []).filter((id) => id && typeof _fvFolderCounts[id] !== "number");
  if (!ids.length) return;
  try {
    const headers = await _fvAuthHeaders();
    const clause = ids.map((id) => `'${id}' in parents`).join(" or ");
    const q = encodeURIComponent(`(${clause}) and trashed = false`);
    const fields = encodeURIComponent("files(id,parents,mimeType)");
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000`,
      { headers }
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const files = Array.isArray(data.files) ? data.files : [];
    ids.forEach((id) => { _fvFolderCounts[id] = 0; }); // empty folders resolve to 0, not a spinner
    files.forEach((file) => {
      if (file.mimeType === "application/vnd.google-apps.folder") return; // count documents only
      (file.parents || []).forEach((p) => {
        if (typeof _fvFolderCounts[p] === "number" && ids.indexOf(p) !== -1) _fvFolderCounts[p]++;
      });
    });
  } catch (e) {
    console.error("[FileVault] folder counts failed:", e);
  }
  // Paint badges for every folder we now have a number for.
  Object.keys(_fvFolderCounts).forEach((id) => {
    if (typeof _fvFolderCounts[id] !== "number") return;
    document.querySelectorAll(`[data-fv-foldercount="${id}"]`).forEach((el) => {
      el.textContent = _fvFolderCountLabel(_fvFolderCounts[id]);
    });
  });
}

function _fvFileIcon(mime) {
  if (!mime) return "fa-file";
  if (mime.includes("pdf")) return "fa-file-pdf";
  if (mime.includes("image")) return "fa-file-image";
  if (mime.includes("word") || mime.includes("document")) return "fa-file-word";
  if (mime.includes("sheet") || mime.includes("excel") || mime.includes("csv")) return "fa-file-excel";
  if (mime.includes("video")) return "fa-file-video";
  if (mime.includes("audio")) return "fa-file-audio";
  if (mime.includes("zip") || mime.includes("compressed")) return "fa-file-zipper";
  if (mime.includes("folder")) return "fa-folder";
  return "fa-file";
}

function _fvFormatSize(bytes) {
  if (bytes == null) return "—";
  const b = Number(bytes);
  if (!isFinite(b) || b <= 0) return "—";
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + " MB";
  return (b / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function _fvEscape(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Alias so viewer templates that use escapeHtml(...) Just Work.
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _fvIsPdf(f) { return (f.mimeType || "").indexOf("pdf") >= 0; }
function _fvIsGoogleDoc(f) {
  const m = f.mimeType || "";
  return m === "application/vnd.google-apps.document" ||
         m === "application/vnd.google-apps.spreadsheet" ||
         m === "application/vnd.google-apps.presentation" ||
         m === "application/vnd.google-apps.drawing";
}
function _fvGoogleExportMime(mime) {
  if (mime === "application/vnd.google-apps.document") return "application/pdf";
  if (mime === "application/vnd.google-apps.spreadsheet") return "application/pdf";
  if (mime === "application/vnd.google-apps.presentation") return "application/pdf";
  if (mime === "application/vnd.google-apps.drawing") return "application/pdf";
  return null;
}

// Legacy shim — kept as alias so other call sites still compile.
function _fvRenderFileList(contact) { _fvRenderFileListPanel(contact); }
function _fvRenderRightFileList(contact) { _fvRenderFileListPanel(contact); }

// Inline icon helpers for the new file list rows.
function _fvMimeIconEmoji(mime) {
  if (!mime) return "\uD83D\uDCC4"; // 📄
  if (mime === "application/pdf") return "\uD83D\uDCC4";
  if (mime.indexOf("image/") === 0) return "\uD83D\uDDBC\uFE0F"; // 🖼️
  if (mime.indexOf("video/") === 0) return "\uD83C\uDFAC"; // 🎬
  if (mime.indexOf("audio/") === 0) return "\uD83C\uDFB5"; // 🎵
  if (mime.indexOf("word") >= 0 || mime.indexOf("google-apps.document") >= 0) return "\uD83D\uDCDD"; // 📝
  if (mime.indexOf("sheet") >= 0 || mime.indexOf("excel") >= 0 || mime.indexOf("csv") >= 0 || mime.indexOf("google-apps.spreadsheet") >= 0) return "\uD83D\uDCCA"; // 📊
  if (mime.indexOf("zip") >= 0 || mime.indexOf("compressed") >= 0) return "\uD83D\uDDC4\uFE0F"; // 🗄️
  return "\uD83D\uDCC4";
}

// Resolve the borrower currently selected in the left column.
function _fvCurrentContact() {
  return _fvContacts.find((c) => String(c.id) === String(_fvSelectedContactId)) || null;
}

// Attach file drag-and-drop to any element. getFolderId() decides where the files land;
// getContact() supplies the borrower. Highlights with a gold inset ring while hovering.
function _fvBindDrop(el, getFolderId, getContact) {
  if (!el) return;
  el.addEventListener("dragover", (e) => {
    const types = (e.dataTransfer && e.dataTransfer.types) || [];
    if (Array.prototype.indexOf.call(types, "Files") === -1) return;
    e.preventDefault();
    e.stopPropagation();
    try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
    el.style.boxShadow = "inset 0 0 0 2px #C9A84C";
  });
  el.addEventListener("dragleave", (e) => {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    el.style.boxShadow = "";
  });
  el.addEventListener("drop", (e) => {
    el.style.boxShadow = "";
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    e.preventDefault();
    e.stopPropagation();
    const contact = getContact && getContact();
    if (!contact) { _fvShowToast("Select a borrower first"); return; }
    _fvUploadFiles(contact, files, getFolderId ? getFolderId() : undefined);
  });
}

// Render the file list into Panel 2 (#fv-file-list). Filter pills + dropzone
// are permanent siblings and never re-rendered.
function _fvRenderFileListPanel(contact) {
  const host = document.getElementById("fv-file-list");
  if (!host) return;
  // Whole panel is a drop target → files land in the folder currently open. Bound once.
  if (!host.dataset.fvDropBound) {
    _fvBindDrop(
      host,
      () => (window._fvCurrentFolderId || (_fvCurrentContact() && _fvCurrentContact().gdrive_folder_id)),
      () => _fvCurrentContact()
    );
    host.dataset.fvDropBound = "1";
  }
  // Read from the CURRENT folder (which may be a subfolder, not the root).
  const currentFolderId = window._fvCurrentFolderId || contact.gdrive_folder_id;
  const allItems = _fvFiles[currentFolderId] || [];

  // Separate folders from files and show folders first.
  const isFolder = (f) => f.mimeType === "application/vnd.google-apps.folder";
  const folders = allItems.filter(isFolder);
  const docs = allItems.filter((f) => !isFolder(f));
  const filteredDocs = _fvFileFilter
    ? docs.filter((f) => (f.appProperties && f.appProperties.docType) === _fvFileFilter)
    : docs;
  const sorted = [...folders, ...filteredDocs];

  if (!sorted.length) {
    host.innerHTML = `<div style="padding:40px 20px;text-align:center;color:#555;font-size:12px;">${allItems.length ? "No files match this filter" : "No files yet — drop files here"}</div>`;
    _fvUpdateSelectionUI();
    return;
  }
  host.innerHTML = sorted.map((f) => _fvFileRowHtml(f)).join("");

  // Wire row clicks.
  host.querySelectorAll(".fv-file-row").forEach((row) => {
    const fileId = row.dataset.fvRow;
    const f = allItems.find((x) => x.id === fileId);
    if (!f) return;

    if (isFolder(f)) {
      // Folder click — navigate into it.
      row.onclick = () => _fvNavigateIntoFolder(f);
      // Drop files onto this row → upload straight into this folder.
      _fvBindDrop(row, () => f.id, () => contact);
      return;
    }

    // Regular file row.
    row.onclick = (e) => {
      if (e.target && e.target.closest && (e.target.closest(".fv-pdf-btn") || e.target.closest(".fv-dl-btn") || e.target.closest(".fv-convert-btn") || e.target.closest(".fv-row-check"))) return;
      const idx = docs.findIndex((x) => x.id === fileId);
      if (idx >= 0) _fvOpenViewer(contact, docs, idx);
    };

    const check = row.querySelector(".fv-row-check");
    if (check) {
      check.onclick = (e) => e.stopPropagation();
      check.onchange = (e) => {
        e.stopPropagation();
        if (check.checked) _fvSelectedIds.add(fileId); else _fvSelectedIds.delete(fileId);
        _fvUpdateSelectionUI();
      };
    }

    const pdfBtn = row.querySelector(".fv-pdf-btn");
    if (pdfBtn) {
      pdfBtn.onclick = (e) => { e.stopPropagation(); _fvConvertToPdf(f); };
    }
    const convBtn = row.querySelector(".fv-convert-btn");
    if (convBtn) {
      convBtn.onclick = (e) => { e.stopPropagation(); _fvConvertOneFile(f); };
    }
    const dlBtn = row.querySelector(".fv-dl-btn");
    if (dlBtn) {
      dlBtn.onclick = (e) => {
        e.stopPropagation();
        window.open((window.pinGoogleUrl ? window.pinGoogleUrl : (u)=>u)(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(f.id)}`), "_blank", "noopener");
      };
    }
  });

  // Prune any selected ids no longer present in this folder, then refresh the toolbar UI.
  const present = new Set(docs.map((d) => d.id));
  Array.from(_fvSelectedIds).forEach((id) => { if (!present.has(id)) _fvSelectedIds.delete(id); });
  _fvUpdateSelectionUI();

  // Lazy-load document counts for the subfolders shown, then fill in their 📄 badges.
  const _fvSubIds = folders.map((f) => f.id);
  if (_fvSubIds.length) _fvLoadFolderCounts(_fvSubIds);

  // Highlight the active viewer row if still in this folder.
  if (_fvViewerState && String(_fvViewerState.contactId) === String(contact.id)) {
    const activeId = _fvViewerState.files[_fvViewerState.index]?.id;
    if (activeId) {
      const activeRow = host.querySelector(`[data-fv-row="${activeId}"]`);
      if (activeRow) activeRow.classList.add("active");
    }
  }
}

function _fvFileRowHtml(f) {
  const nm = _fvEscape(f.name || "Untitled");

  // Folder rows have a distinct gold style with an arrow affordance.
  if (f.mimeType === "application/vnd.google-apps.folder") {
    return `
      <div class="fv-file-row" data-fv-row="${_fvEscape(f.id)}">
        <div style="width:16px;flex-shrink:0;"></div>
        <div style="font-size:18px;flex-shrink:0;">&#128193;</div>
        <div style="flex:1;min-width:0;">
          <div class="fv-name" style="color:#C9A84C;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${nm}</div>
          <div data-fv-foldercount="${_fvEscape(f.id)}" style="color:#7a6a3a;font-size:11px;margin-top:1px;">${_fvFolderCountLabel(_fvFolderCounts[f.id])}</div>
        </div>
        <div style="color:#C9A84C44;font-size:11px;flex-shrink:0;">&#8594;</div>
      </div>
    `;
  }

  const icon = _fvMimeIconEmoji(f.mimeType || "");
  const size = _fvFormatSize(f.size);
  const date = f.createdTime ? new Date(f.createdTime).toLocaleDateString() : "";
  const docType = (f.appProperties && f.appProperties.docType) || "";
  const isGoogleDoc = (f.mimeType || "").startsWith("application/vnd.google-apps.");
  const isPdf = _fvIsPdf(f) || /\.pdf$/i.test(f.name || "");
  const checked = _fvSelectedIds.has(f.id) ? " checked" : "";
  // A per-row "Convert to PDF" button on every NON-PDF, non-Google-native file.
  const convertBtn = (!isPdf && !isGoogleDoc)
    ? `<button class="fv-convert-btn" title="Convert this file to PDF" style="background:#1a1a1a;border:1px solid #C9A84C44;color:#C9A84C;font-size:10px;padding:2px 7px;border-radius:4px;cursor:pointer;font-family:inherit;white-space:nowrap;">&#128196; PDF</button>`
    : "";
  return `
    <div class="fv-file-row" data-fv-row="${_fvEscape(f.id)}">
      <input type="checkbox" class="fv-row-check" data-id="${_fvEscape(f.id)}"${checked} title="Select this file" style="accent-color:#C9A84C;width:14px;height:14px;flex-shrink:0;cursor:pointer;">
      <div style="font-size:16px;flex-shrink:0;">${icon}</div>
      <div style="flex:1;min-width:0;">
        <div class="fv-name" style="color:#d0d0d0;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${nm}</div>
        <div style="color:#444;font-size:10px;margin-top:1px;">
          ${size || '—'}${date ? ' · ' + date : ''}
        </div>
        ${docType ? `<span class="fv-doc-type-badge" style="font-size:9px;color:#C9A84C88;background:#C9A84C11;padding:1px 5px;border-radius:3px;margin-top:2px;display:inline-block;">${_fvEscape(docType)}</span>` : ''}
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0;align-items:center;">
        ${isGoogleDoc ? `<button class="fv-pdf-btn" title="Export as PDF" style="background:#1a1a1a;border:1px solid #2a2a2a;color:#C9A84C88;font-size:10px;padding:2px 7px;border-radius:4px;cursor:pointer;font-family:inherit;">PDF</button>` : ''}
        ${convertBtn}
        <button class="fv-dl-btn" title="Download" style="background:transparent;border:none;color:#444;cursor:pointer;font-size:14px;padding:2px 4px;font-family:inherit;">&#8681;</button>
      </div>
    </div>
  `;
}

// ── FOLDER NAVIGATION ────────────────────────────────────────────
async function _fvNavigateIntoFolder(folder) {
  _fvSelectedIds.clear(); // selection is per-folder
  // Push the current folder onto the breadcrumb stack.
  _fvFolderStack.push({
    id: window._fvCurrentFolderId,
    name: document.getElementById("fv-panel-title")?.textContent || "Files"
  });
  _fvUpdateBreadcrumb();
  await _fvLoadFiles(folder.id);
  const contact = _fvContacts.find((c) => c.id === _fvSelectedContactId);
  if (contact) _fvRenderFileListPanel(contact);
}

async function _fvFolderBack() {
  if (!_fvFolderStack.length) return;
  _fvSelectedIds.clear(); // selection is per-folder
  const parent = _fvFolderStack.pop();
  _fvUpdateBreadcrumb();
  await _fvLoadFiles(parent.id);
  const contact = _fvContacts.find((c) => c.id === _fvSelectedContactId);
  if (contact) _fvRenderFileListPanel(contact);
}

function _fvUpdateBreadcrumb() {
  const backBtn = document.getElementById("fv-folder-back");
  if (!backBtn) return;
  if (_fvFolderStack.length > 0) {
    const parent = _fvFolderStack[_fvFolderStack.length - 1];
    backBtn.style.display = "inline-flex";
    backBtn.innerHTML = "&#8592; " + _fvEscape(parent.name);
  } else {
    backBtn.style.display = "none";
  }
}

// ── RENAME ────────────────────────────────────────────────────────
function _fvStartRename(contact, fileId) {
  const files = _fvFiles[contact.gdrive_folder_id] || [];
  const file = files.find((f) => f.id === fileId);
  if (!file) return;
  const row = document.querySelector(`[data-fv-row="${fileId}"]`);
  if (!row) return;
  const nameEl = row.querySelector(".fv-name");
  if (!nameEl) return;
  const currentName = file.name || "";
  const input = document.createElement("input");
  input.type = "text";
  input.value = currentName;
  input.style.cssText = "flex:1;background:#1a1a1a;border:1px solid #C9A84C;border-radius:6px;padding:4px 8px;color:#eee;font-size:.82rem;font-family:inherit;outline:none;width:100%;";
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim();
    if (!newName || newName === currentName) { cancel(); return; }
    input.disabled = true;
    input.style.opacity = "0.6";
    try {
      const headers = await _fvAuthHeaders({ "Content-Type": "application/json" });
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name`,
        { method: "PATCH", headers, body: JSON.stringify({ name: newName }) }
      );
      if (res.status === 401 || res.status === 403) _fvClearToken();
      const data = await res.json();
      if (!res.ok || !data.id) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      file.name = data.name;
      _fvShowToast("Renamed ✓");
    } catch (e) {
      console.error("[FileVault] rename failed:", e);
      _fvShowToast("Rename failed");
    }
    _fvRenderFileList(contact);
  };
  const cancel = () => { _fvRenderFileList(contact); };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", commit);
}

// ── DELETE ────────────────────────────────────────────────────────
async function _fvDeleteFile(contact, fileId) {
  const files = _fvFiles[contact.gdrive_folder_id] || [];
  const file = files.find((f) => f.id === fileId);
  if (!file) return;
  if (!confirm(`Delete "${file.name}"? This cannot be undone.`)) return;
  try {
    const headers = await _fvAuthHeaders();
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
      { method: "DELETE", headers }
    );
    if (res.status === 401 || res.status === 403) { _fvClearToken(); throw new Error(`HTTP ${res.status}`); }
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
    _fvFiles[contact.gdrive_folder_id] = files.filter((f) => f.id !== fileId);
    _fvFileCounts[contact.gdrive_folder_id] = _fvFiles[contact.gdrive_folder_id].length;
    _fvShowToast("Deleted ✓");
    _fvRenderRightFileList(contact);
    const countSpan = document.querySelector(`[data-fv-count="${contact.id}"]`);
    if (countSpan) countSpan.textContent = (_fvFileCounts[contact.gdrive_folder_id] || 0) + " files";
  } catch (e) {
    console.error("[FileVault] delete failed:", e);
    _fvShowToast("Delete failed");
  }
}

// ── CONVERT TO PDF ────────────────────────────────────────────────
async function _fvConvertToPdf(file) {
  console.log("[FileVault][convert] start", file.name, file.mimeType);

  const exportable = [
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.spreadsheet",
    "application/vnd.google-apps.presentation",
    "application/vnd.google-apps.drawing"
  ];
  if (!exportable.includes(file.mimeType)) {
    _fvShowToast("Only Google Docs/Sheets/Slides can be converted. For other files, open in Drive → File → Download as PDF.");
    return;
  }

  _fvShowToast("Converting to PDF...");
  try {
    const token = await _fvEnsureToken();
    console.log("[FileVault][convert] token acquired");

    const exportRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=application/pdf`,
      { headers: { Authorization: "Bearer " + token } }
    );
    console.log("[FileVault][convert] export response status", exportRes.status);
    if (exportRes.status === 401 || exportRes.status === 403) _fvClearToken();
    if (!exportRes.ok) {
      const errText = await exportRes.text().catch(() => "");
      console.error("[FileVault][convert] export failed body:", errText);
      _fvShowToast(`Export failed: HTTP ${exportRes.status}`);
      return;
    }
    const blob = await exportRes.blob();
    console.log("[FileVault][convert] blob size/type", blob.size, blob.type);

    const pdfName = (file.name || "document").replace(/\.[a-zA-Z0-9]{1,6}$/, "") + ".pdf";
    console.log("[FileVault][convert] upload filename", pdfName);

    const folderId = window._fvCurrentFolderId;
    if (!folderId) {
      _fvShowToast("No folder selected");
      console.error("[FileVault][convert] window._fvCurrentFolderId is not set");
      return;
    }

    const uploadFile = new File([blob], pdfName, { type: "application/pdf" });
    const result = await _fvUploadOne(folderId, uploadFile);
    console.log("[FileVault][convert] upload result", result);

    if (result && result.ok) {
      _fvShowToast(`✓ ${pdfName} created`);
      await _fvLoadFiles(folderId);
      const contact = _fvContacts.find((c) => c.id === _fvSelectedContactId);
      if (contact) _fvRenderFileListPanel(contact);
    } else {
      _fvShowToast("PDF upload failed: " + ((result && result.error) || "unknown error"));
    }
  } catch (err) {
    console.error("[FileVault][convert] FAILED", err);
    _fvShowToast("Convert failed: " + (err.message || err));
  }
}

/* ══════════════════════════════════════════════════════════════════
   BATCH TOOLS — Convert all to PDF / AI Scan & Rename / Review & Approve
   Operates on the selected borrower's currently-shown file list. Reuses the
   existing Drive helpers (download via alt=media, _fvUploadOne, rename PATCH,
   appProperties for category/review metadata) and the deployed convert-to-pdf
   and textract-ocr edge functions. Storage stays in the borrower's Drive
   folder — no new bucket or upload path.
═══════════════════════════════════════════════════════════════════ */

function _fvFnBase() {
  return (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_URL) || "https://ljywhvbmsibwnssxpesh.supabase.co";
}

// Resolve the folder whose files are currently shown (open subfolder → borrower root).
function _fvCurrentFolderIdResolved() {
  const c = _fvCurrentContact();
  return window._fvCurrentFolderId || (c && c.gdrive_folder_id) || null;
}

// The real files (not subfolders) in the current view.
function _fvCurrentFileObjects() {
  const fid = _fvCurrentFolderIdResolved();
  const all = (fid && _fvFiles[fid]) || [];
  return all.filter((f) => f && f.mimeType !== "application/vnd.google-apps.folder");
}

// The currently-checked files in the open folder.
function _fvSelectedFileObjects() {
  return _fvCurrentFileObjects().filter((f) => _fvSelectedIds.has(f.id));
}

// Refresh the "Select all" checkbox state + selection count in the toolbar.
function _fvUpdateSelectionUI() {
  const files = _fvCurrentFileObjects();
  const total = files.length;
  const sel = files.filter((f) => _fvSelectedIds.has(f.id)).length;
  const countEl = document.getElementById("fv-sel-count");
  if (countEl) countEl.textContent = sel ? `(${sel} selected)` : "";
  const selAll = document.getElementById("fv-select-all");
  if (selAll) {
    selAll.checked = total > 0 && sel === total;
    selAll.indeterminate = sel > 0 && sel < total;
  }
}

// Download a Drive file's bytes (same alt=media path the viewer uses) as a Blob.
async function _fvDownloadBlob(fileId) {
  const token = await _fvEnsureToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true&t=${Date.now()}`,
    { headers: { Authorization: "Bearer " + token, "Cache-Control": "no-cache", Pragma: "no-cache" }, cache: "no-store" }
  );
  if (res.status === 401 || res.status === 403) _fvClearToken();
  if (!res.ok) throw new Error("download HTTP " + res.status);
  return await res.blob();
}

function _fvBlobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result || ""); const c = s.indexOf(","); resolve(c >= 0 ? s.slice(c + 1) : s); };
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

function _fvB64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// convert-to-pdf edge function (same call shape the upload path already uses).
// Throws an error with .status=415 for HEIC / Office docs.
async function _fvCallConvertToPdf(base64, mime, name) {
  const res = await fetch(_fvFnBase() + "/functions/v1/convert-to-pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_base64: base64, mime_type: mime, file_name: name }),
  });
  if (res.status === 415) {
    const j = await res.json().catch(() => ({}));
    const err = new Error((j && j.error) || "Unsupported file type");
    err.status = 415;
    throw err;
  }
  if (!res.ok) throw new Error("convert-to-pdf HTTP " + res.status);
  return await res.json();
}

// Current user's Supabase access token. textract-ocr runs with verify_jwt=true,
// so it 401s without a real session JWT (the anon key alone is rejected). Same
// pattern the lead-detail document OCR uses.
async function _fvUserAccessToken() {
  try {
    const { supabase } = await import("/api/supabase-client.js");
    const { data } = await supabase.auth.getSession();
    return (data && data.session && data.session.access_token) || null;
  } catch (_) { return null; }
}

// textract-ocr edge function (start an OCR job, get flat fields back).
// Must carry the user's JWT (verify_jwt=true). doc_type is omitted when empty so
// the engine auto-detects the document type.
async function _fvCallTextract(base64, name, fileType, contactId, docType) {
  const jwt = await _fvUserAccessToken();
  if (!jwt) throw new Error("Session expired — sign in and retry");
  const anon = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_ANON_KEY) || "";
  const body = { action: "start", file_base64: base64, file_name: name, file_type: fileType, contact_id: contactId };
  if (docType) body.doc_type = docType; // omit when empty → engine auto-detects
  const res = await fetch(_fvFnBase() + "/functions/v1/textract-ocr", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + jwt, "apikey": anon },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("textract-ocr HTTP " + res.status);
  return await res.json();
}

// Rename a Drive file (same PATCH the inline rename uses).
async function _fvRenameDriveFile(fileId, name) {
  const headers = await _fvAuthHeaders({ "Content-Type": "application/json" });
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name&supportsAllDrives=true`,
    { method: "PATCH", headers, body: JSON.stringify({ name }) }
  );
  if (res.status === 401 || res.status === 403) _fvClearToken();
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
  return data;
}

// Delete a Drive file (no confirm — used inside batches that replace originals).
async function _fvDeleteDriveFile(fileId) {
  const headers = await _fvAuthHeaders();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    { method: "DELETE", headers }
  );
  if (res.status === 401 || res.status === 403) { _fvClearToken(); throw new Error("HTTP " + res.status); }
  if (!res.ok && res.status !== 204) throw new Error("HTTP " + res.status);
  return true;
}

// Persist the document category onto a file (same appProperties.docType store).
async function _fvSetAppPropDocType(fileId, docType) {
  const token = await _fvEnsureToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,appProperties`,
    { method: "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ appProperties: { docType: docType } }) }
  );
  if (res.status === 401 || res.status === 403) _fvClearToken();
  if (!res.ok) throw new Error("HTTP " + res.status);
  return true;
}

// Mark a file reviewed (status / reviewedBy / reviewedAt) in appProperties —
// the page's existing per-file metadata store.
async function _fvSetReviewedMeta(fileId, who) {
  const token = await _fvEnsureToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,appProperties`,
    {
      method: "PATCH",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ appProperties: { status: "reviewed", reviewedBy: who || "", reviewedAt: new Date().toISOString() } }),
    }
  );
  if (res.status === 401 || res.status === 403) _fvClearToken();
  if (!res.ok) throw new Error("HTTP " + res.status);
  return true;
}

// Identify the signed-in admin (for reviewed_by) via the shared Supabase client.
async function _fvAdminIdentity() {
  try {
    const { supabase } = await import("/api/supabase-client.js");
    const { data } = await supabase.auth.getSession();
    const u = data && data.session && data.session.user;
    return (u && (u.email || u.id)) || "admin";
  } catch (_) { return "admin"; }
}

/* ── (1) CONVERT TO PDF (per-file + safe Convert all) ─────────────── */
// Convert ONE non-PDF file to PDF via the edge function and replace the original.
// Never touches an existing PDF. Returns { status:'converted'|'skipped'|'noop', name, reason?, warn? }.
async function _fvConvertOneViaFn(f, folderId) {
  // Already a PDF → never modify.
  if (_fvIsPdf(f) || /\.pdf$/i.test(f.name || "")) return { status: "noop", name: f.name };
  // Google-native docs can't be fetched via alt=media — they need the export path.
  if ((f.mimeType || "").indexOf("application/vnd.google-apps") === 0) {
    return { status: "skipped", name: f.name, reason: "Google Doc — open in Drive → File → Download as PDF" };
  }
  const blob = await _fvDownloadBlob(f.id);
  const b64 = await _fvBlobToBase64(blob);
  let resp;
  try {
    resp = await _fvCallConvertToPdf(b64, f.mimeType || "application/octet-stream", f.name || "file");
  } catch (err) {
    if (err && err.status === 415) return { status: "skipped", name: f.name, reason: "HEIC / Office doc — convert on your phone or re-upload as PDF" };
    throw err;
  }
  if (resp && resp.already_pdf) return { status: "noop", name: f.name }; // backend says already PDF
  if (!resp || !resp.pdf_base64) throw new Error("no PDF returned");

  const bytes = _fvB64ToBytes(resp.pdf_base64);
  // Keep the file's current (possibly hand-edited) name — only swap the extension.
  const pdfName = resp.pdf_name || ((f.name || "document").replace(/\.[a-zA-Z0-9]{1,6}$/, "") + ".pdf");
  const pdfFile = new File([bytes], pdfName, { type: "application/pdf" });

  const up = await _fvUploadOne(folderId, pdfFile);
  if (!up || !up.ok) throw new Error((up && up.error) || "upload failed");

  // Preserve the original's document category onto the new PDF.
  const cat = (f.appProperties && f.appProperties.docType) || "";
  if (cat && up.file && up.file.id) { try { await _fvSetAppPropDocType(up.file.id, cat); } catch (_) {} }

  // Replace the original: remove the non-PDF so we don't keep both.
  try { await _fvDeleteDriveFile(f.id); }
  catch (delErr) { return { status: "converted", name: pdfName, warn: "original couldn't be deleted" }; }
  return { status: "converted", name: pdfName };
}

// Per-row "Convert to PDF" button — converts just this one file.
async function _fvConvertOneFile(f) {
  if (_fvBatchBusy) { _fvShowToast("A batch is already running…"); return; }
  if (_fvIsPdf(f) || /\.pdf$/i.test(f.name || "")) { _fvShowToast("Already a PDF"); return; }
  const contact = _fvCurrentContact();
  const folderId = _fvCurrentFolderIdResolved();
  if (!folderId) { _fvShowToast("No folder for this borrower"); return; }
  try { await _fvEnsureToken(); } catch (e) { _fvShowToast("Google Drive access needed — click again to allow"); return; }

  _fvBatchBusy = true;
  _fvShowToast(`Converting ${f.name || "file"}…`);
  let res = null, errMsg = "";
  try { res = await _fvConvertOneViaFn(f, folderId); }
  catch (e) { errMsg = (e && e.message) || String(e); }
  finally { _fvBatchBusy = false; }

  try { await _fvLoadFiles(folderId); if (contact) _fvRenderFileListPanel(contact); } catch (_) {}
  if (errMsg) { _fvShowToast("Convert failed: " + errMsg); return; }
  if (res.status === "skipped") { _fvShowSummary("Convert to PDF", [`Skipped ${res.name}:`, "• " + res.reason]); return; }
  if (res.status === "noop") { _fvShowToast("Already a PDF"); return; }
  _fvShowToast(`Converted to PDF ✓${res.warn ? " (original not removed)" : ""}`);
}

// Convert all — only ever non-PDFs; never touches existing PDFs. Scopes to the
// selected files when any are checked, otherwise everything in the folder.
async function _fvConvertAllToPdf() {
  if (_fvBatchBusy) { _fvShowToast("A batch is already running…"); return; }
  const contact = _fvCurrentContact();
  if (!contact) { _fvShowToast("Pick a borrower first"); return; }
  const folderId = _fvCurrentFolderIdResolved();
  if (!folderId) { _fvShowToast("No folder for this borrower"); return; }

  const scoped = _fvSelectedIds.size ? _fvSelectedFileObjects() : _fvCurrentFileObjects();
  const targets = scoped.filter((f) => !_fvIsPdf(f) && !/\.pdf$/i.test(f.name || ""));
  if (!targets.length) {
    _fvShowToast(_fvSelectedIds.size ? "No non-PDF files selected" : "Everything here is already a PDF ✓");
    return;
  }

  // Grab the Drive token now, under the click gesture, so consent fails loudly.
  try { await _fvEnsureToken(); } catch (e) { _fvShowToast("Google Drive access needed — click again to allow"); return; }

  _fvBatchBusy = true;
  const converted = [], skipped = [], errors = [];
  try {
    for (let i = 0; i < targets.length; i++) {
      const f = targets[i];
      _fvShowToast(`Converting ${i + 1} of ${targets.length}…`);
      try {
        const res = await _fvConvertOneViaFn(f, folderId);
        if (res.status === "converted") { converted.push(res.name); if (res.warn) errors.push(`${res.name}: ${res.warn}`); }
        else if (res.status === "skipped") { skipped.push(`${res.name} (${res.reason})`); }
        // noop → an existing PDF slipped through; leave it untouched
      } catch (e) {
        errors.push(`${f.name || "file"}: ${(e && e.message) || e}`);
      }
    }
  } finally {
    _fvBatchBusy = false;
  }

  // Refresh the list + borrower count.
  try { await _fvLoadFiles(folderId); _fvRenderFileListPanel(contact); } catch (_) {}
  const countSpan = document.querySelector(`[data-fv-count="${contact.id}"]`);
  if (countSpan) countSpan.textContent = (_fvFileCounts[folderId] || 0) + " files";

  _fvShowToast(`Converted ${converted.length} of ${targets.length} ✓`);
  if (skipped.length || errors.length) {
    const lines = [`${converted.length} converted to PDF.`];
    if (skipped.length) { lines.push(`${skipped.length} skipped — convert these on your phone or re-upload as PDF:`); skipped.forEach((s) => lines.push("• " + s)); }
    if (errors.length) { lines.push(`${errors.length} issue(s):`); errors.forEach((s) => lines.push("• " + s)); }
    _fvShowSummary("Convert all to PDF", lines);
  }
}

/* ── (2) AI SCAN & RENAME ─────────────────────────────────────────── */
// Map a stored document category to a textract-ocr doc_type key.
function _fvDocTypeToTextract(category) {
  const c = (category || "").toLowerCase();
  if (!c) return "";
  if (c.indexOf("pay") >= 0) return "pay_stubs";
  if (c.indexOf("w-2") >= 0 || c.indexOf("w2") >= 0) return "w2";
  if (c.indexOf("1040") >= 0 || c.indexOf("tax") >= 0) return "tax_returns";
  if (c.indexOf("bank") >= 0) return "bank_statements";
  if (c.indexOf("id") >= 0 || c.indexOf("license") >= 0) return "gov_id";
  if (c.indexOf("insurance") >= 0) return "insurance";
  if (c.indexOf("credit") >= 0) return "credit";
  return "";
}

function _fvFirstWord(s) { if (!s) return ""; return String(s).trim().split(/\s+/)[0] || ""; }

const _FV_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function _fvParseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) { const d = new Date(+iso[1], +iso[2] - 1, +iso[3]); if (!isNaN(d.getTime())) return d; }
  const mdy = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (mdy) { let y = +mdy[3]; if (y < 100) y += 2000; const d = new Date(y, +mdy[1] - 1, +mdy[2]); if (!isNaN(d.getTime())) return d; }
  const d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}
function _fvFmtDateMDY(v) { const d = _fvParseDate(v); return d ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}` : ""; }
function _fvFmtMonYear(v) { const d = _fvParseDate(v); return d ? `${_FV_MONTHS[d.getMonth()]} ${d.getFullYear()}` : ""; }

function _fvFallbackName(category, contact, file) {
  // "Couldn't read" fallback: Category + borrower name only — NO synthetic
  // today's/upload date. (Real document dates still appear in the proper-name
  // builders below for paystubs / bank statements / W-2 / tax returns.)
  const cat = category || "Document";
  const full = contact ? `${contact.first_name || ""} ${contact.last_name || ""}`.trim() : "";
  const who = full || (contact && contact.first_name) || _fvFirstWord(contact && contact.name) || "Borrower";
  return `${cat} – ${who}`;
}

// Build a suggested file name from the OCR doc_type + extracted fields.
function _fvComputeSuggestedName(docType, fields, contact, category, file) {
  const f = fields || {};
  const dt = (docType || "").toLowerCase();
  const borrowerFirst = (contact && contact.first_name) || _fvFirstWord(contact && contact.name) || "Borrower";
  const get = (...keys) => { for (const k of keys) { const v = f[k]; if (v != null && String(v).trim() !== "") return String(v).trim(); } return ""; };
  let name = "", flagged = false;

  if (dt === "pay_stubs" || dt === "pay_stub" || dt === "paystub") {
    const fn = _fvFirstWord(get("first_name", "employee_first_name", "employee_name")) || borrowerFirst;
    const ps = _fvFmtDateMDY(get("pay_period_start", "period_start", "pay_period_start_date"));
    const pe = _fvFmtDateMDY(get("pay_period_end", "period_end", "pay_period_end_date"));
    const emp = get("employer_name", "employer", "company_name");
    const period = (ps || pe) ? ` – ${ps}–${pe}` : "";
    name = `Paystub – ${fn}${period}${emp ? ` – ${emp}` : ""}`;
    if (!ps && !pe && !emp) flagged = true;
  } else if (dt === "w2" || dt === "w-2") {
    const fn = _fvFirstWord(get("employee_first_name", "first_name", "employee_name")) || borrowerFirst;
    const yr = get("tax_year", "year");
    const emp = get("employer_name", "employer", "company_name");
    name = `W2 – ${fn}${yr ? ` – ${yr}` : ""}${emp ? ` – ${emp}` : ""}`;
    if (!yr && !emp) flagged = true;
  } else if (dt === "bank_statements" || dt === "bank_statement") {
    const fn = _fvFirstWord(get("account_holder_first_name", "account_holder_name", "first_name")) || borrowerFirst;
    const bank = get("bank_name", "institution_name", "bank");
    const end = _fvFmtMonYear(get("statement_end_date", "statement_period_end", "end_date", "statement_date"));
    name = `Bank Stmt – ${fn}${bank ? ` – ${bank}` : ""}${end ? ` – ${end}` : ""}`;
    if (!bank && !end) flagged = true;
  } else if (dt === "gov_id" || dt === "govid" || dt === "drivers_license" || dt === "driver_license" || dt === "id") {
    const fn = _fvFirstWord(get("first_name", "full_name", "name")) || borrowerFirst;
    const st = get("dl_state", "state", "issuing_state");
    name = `Gov ID – ${fn} – DL${st ? ` (${st})` : ""}`;
  } else if (
    dt === "social security card" || dt === "social_security_card" || dt === "ssn_card" || dt === "ss_card" ||
    // No driver-license number + an SSN with a name → a Social Security card, not a Gov ID.
    (get("ssn", "social_security_number") && get("first_name", "last_name", "full_name", "name") && !get("driver_license_number", "dl_number", "license_number", "dl_state"))
  ) {
    const fn = get("first_name") || _fvFirstWord(get("full_name", "name")) || borrowerFirst;
    const ln = get("last_name");
    name = `Social Security Card – ${(fn + " " + ln).trim()}`;
    // It read fine (name/ssn extracted) — no "couldn't read" flag, and never the Gov ID template.
  } else if (dt === "tax_returns" || dt === "tax_return" || dt === "1040") {
    const fn = _fvFirstWord(get("first_name", "taxpayer_first_name", "name")) || borrowerFirst;
    const yr = get("tax_year", "year");
    name = `Tax Return – ${fn}${yr ? ` – ${yr}` : ""}`;
    if (!yr) flagged = true;
  } else {
    name = _fvFallbackName(category, contact, file);
    flagged = true;
  }
  return { name: name.replace(/\s+/g, " ").trim(), flagged };
}

function _fvFileExt(name) {
  const m = (name || "").match(/\.[a-zA-Z0-9]{1,6}$/);
  return m ? m[0] : "";
}
function _fvKeepExt(name, ext) {
  if (!ext) return name;
  return name.slice(-ext.length).toLowerCase() === ext.toLowerCase() ? name : name + ext;
}

async function _fvScanAndRename() {
  if (_fvBatchBusy) { _fvShowToast("A batch is already running…"); return; }
  const contact = _fvCurrentContact();
  if (!contact) { _fvShowToast("Pick a borrower first"); return; }
  const folderId = _fvCurrentFolderIdResolved();
  if (!folderId) { _fvShowToast("No folder for this borrower"); return; }

  // Scan ONLY the selected files. If none are selected, ask before scanning all.
  // (Scanning never renames — it only proposes names for Review & Approve.)
  let targets;
  if (_fvSelectedIds.size) {
    targets = _fvSelectedFileObjects();
  } else {
    const all = _fvCurrentFileObjects();
    if (!all.length) { _fvShowToast("No files to scan"); return; }
    if (!confirm(`No files selected. Scan all ${all.length} file${all.length === 1 ? "" : "s"} in this folder?\n\n(Nothing is renamed — you'll review each suggestion first.)`)) {
      _fvShowToast("Tick the files you want, then run AI Scan");
      return;
    }
    targets = all;
  }
  if (!targets.length) { _fvShowToast("No files to scan"); return; }

  try { await _fvEnsureToken(); } catch (e) { _fvShowToast("Google Drive access needed — click again to allow"); return; }

  _fvBatchBusy = true;
  _fvReviewQueue = [];
  const errors = [];
  try {
    for (let i = 0; i < targets.length; i++) {
      const f = targets[i];
      _fvShowToast(`Scanning ${i + 1} of ${targets.length}…`);
      const ext = _fvFileExt(f.name);
      const category = (f.appProperties && f.appProperties.docType) || "";
      const docTypeKey = _fvDocTypeToTextract(category);
      let fields = {}, detectedType = docTypeKey, jobId = null, flagged = false, name;
      try {
        const blob = await _fvDownloadBlob(f.id);
        const b64 = await _fvBlobToBase64(blob);
        const resp = await _fvCallTextract(b64, f.name || "file", f.mimeType || "", contact.id, docTypeKey);
        fields = (resp && resp.fields) || {};
        detectedType = (resp && resp.doc_type) || docTypeKey || "";
        jobId = (resp && resp.job_id) || null;
        const built = _fvComputeSuggestedName(detectedType, fields, contact, category, f);
        name = built.name;
        flagged = built.flagged;
      } catch (e) {
        errors.push(`${f.name || "file"}: ${(e && e.message) || e}`);
        flagged = true;
        name = _fvFallbackName(category, contact, f);
      }
      name = _fvKeepExt(name, ext);
      _fvReviewQueue.push({ file: f, originalName: f.name || "", suggestedName: name, docType: detectedType, category: category, fields: fields, jobId: jobId, flagged: flagged, ext: ext, contactId: contact.id, approved: false });
    }
  } finally {
    _fvBatchBusy = false;
  }

  const flaggedCount = _fvReviewQueue.filter((q) => q.flagged).length;
  _fvShowToast(`Scanned ${_fvReviewQueue.length} file${_fvReviewQueue.length === 1 ? "" : "s"}${flaggedCount ? ` · ${flaggedCount} need a look` : ""} ✓`);
  if (errors.length) console.warn("[FileVault][scan] errors:", errors);
  if (_fvReviewQueue.length) _fvOpenReviewModal();
}

/* ── (3) REVIEW & APPROVE ─────────────────────────────────────────── */
function _fvOpenReviewModal() {
  if (!_fvReviewQueue.length) { _fvShowToast("Run “AI Scan & Rename” first"); return; }
  if (_fvReviewIndex < 0 || _fvReviewIndex >= _fvReviewQueue.length) _fvReviewIndex = 0;
  const existing = document.getElementById("fvReviewOverlay");
  if (existing) existing.remove();

  // Name autocomplete seeds from the open borrower's known info + quick-insert chips.
  const _rc = _fvCurrentContact() || {};
  const _full = `${_rc.first_name || ""} ${_rc.last_name || ""}`.trim();
  const _first = _rc.first_name || _fvFirstWord(_full) || "";
  const _last = _rc.last_name || "";
  const _today = _fvFmtDateMDY(new Date());
  const _seedNames = Array.from(new Set([_full, _first, _last].filter(Boolean)));
  const _chipTokens = ["Paystub", "W2", "Bank Stmt", "Gov ID", "Social Security Card", "Tax Return"];
  if (_first) _chipTokens.push(_first);
  if (_today) _chipTokens.push(_today);
  const _chipStyle = "background:#1a1a1a;border:1px solid #C9A84C55;color:#C9A84C;font-size:11px;padding:3px 9px;border-radius:14px;cursor:pointer;font-family:inherit;white-space:nowrap;";
  const chipsHtml = _chipTokens.map((t) => `<button type="button" data-fv-chip data-token="${_fvEscape(t)}" title="Insert “${_fvEscape(t)}”" style="${_chipStyle}">${_fvEscape(t)}</button>`).join("");
  const datalistHtml = `<datalist id="fvReviewNameList">${_seedNames.map((n) => `<option value="${_fvEscape(n)}"></option>`).join("")}</datalist>`;

  const ov = document.createElement("div");
  ov.id = "fvReviewOverlay";
  ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9990;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif;";
  ov.innerHTML = `
    <div style="width:1100px;max-width:96vw;height:88vh;display:flex;flex-direction:column;background:#0e0e0e;border:1px solid #C9A84C44;border-radius:14px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.6);">
      <div style="display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid #1e1e1e;flex-shrink:0;">
        <span style="color:#C9A84C;font-size:13px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;">Review &amp; Approve</span>
        <span id="fvReviewProgress" style="color:#666;font-size:12px;"></span>
        <span style="flex:1;"></span>
        <button id="fvReviewClose" style="background:transparent;border:1px solid #2a2a2a;color:#888;font-size:13px;padding:5px 12px;border-radius:6px;cursor:pointer;font-family:inherit;">Close</button>
      </div>
      <div style="display:flex;flex:1;min-height:0;">
        <div id="fvReviewPreview" style="flex:1;min-width:0;background:#050505;display:flex;align-items:center;justify-content:center;overflow:auto;"></div>
        <div style="width:340px;flex-shrink:0;border-left:1px solid #1e1e1e;padding:18px;display:flex;flex-direction:column;gap:14px;overflow-y:auto;">
          <div><div style="color:#555;font-size:10px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px;">Detected type</div><div id="fvReviewType" style="color:#C9A84C;font-size:13px;font-weight:600;"></div></div>
          <div><div style="color:#555;font-size:10px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px;">Current name</div><div id="fvReviewCurrent" style="color:#e8e8e8;font-size:14px;font-weight:600;word-break:break-word;line-height:1.35;"></div></div>
          <div><div style="color:#555;font-size:10px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px;">Suggested name (editable)</div>
            <div id="fvReviewChips" style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px;">${chipsHtml}</div>
            <input id="fvReviewName" type="text" list="fvReviewNameList" autocomplete="off" placeholder="Type a name…" style="width:100%;background:#161616;border:1px solid #C9A84C55;color:#eee;font-size:13px;padding:8px 10px;border-radius:8px;outline:none;font-family:inherit;box-sizing:border-box;">${datalistHtml}
            <div style="color:#555;font-size:10px;margin-top:4px;">Tap a chip to insert · or pick a saved name as you type</div></div>
          <div id="fvReviewFlag" style="display:none;background:#3a2a0a;border:1px solid #C9A84C55;color:#e0c070;font-size:11px;padding:8px 10px;border-radius:8px;line-height:1.4;">&#9888; Couldn’t read this one confidently — please set the name manually.</div>
          <div id="fvReviewFields" style="font-size:11px;color:#666;"></div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid #1e1e1e;flex-shrink:0;">
        <button id="fvReviewPrev" style="background:transparent;border:1px solid #2a2a2a;color:#aaa;font-size:13px;padding:7px 16px;border-radius:8px;cursor:pointer;font-family:inherit;">&#8592; Prev</button>
        <button id="fvReviewNext" style="background:transparent;border:1px solid #2a2a2a;color:#aaa;font-size:13px;padding:7px 16px;border-radius:8px;cursor:pointer;font-family:inherit;">Next &#8594;</button>
        <span style="flex:1;"></span>
        <button id="fvReviewSkip" title="Leave this file's name unchanged and move on" style="background:transparent;border:1px solid #2a2a2a;color:#aaa;font-size:13px;padding:8px 16px;border-radius:8px;cursor:pointer;font-family:inherit;">Keep current name</button>
        <button id="fvReviewPull" title="Push this document's extracted income/assets into the borrower's 1003" style="display:none;background:transparent;border:1px solid #C9A84C;color:#C9A84C;font-size:13px;font-weight:700;padding:8px 16px;border-radius:8px;cursor:pointer;font-family:inherit;">&#8615; Pull to 1003</button>
        <button id="fvReviewApprove" style="background:#C9A84C;border:none;color:#000;font-size:13px;font-weight:700;padding:8px 22px;border-radius:8px;cursor:pointer;font-family:inherit;">Approve &amp; rename &#8594;</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) _fvCloseReviewModal(); });
  document.getElementById("fvReviewClose").onclick = _fvCloseReviewModal;
  document.getElementById("fvReviewPrev").onclick = () => _fvReviewNav(-1);
  document.getElementById("fvReviewNext").onclick = () => _fvReviewNav(1);
  document.getElementById("fvReviewSkip").onclick = _fvReviewSkip;
  document.getElementById("fvReviewPull").onclick = _fvPullTo1003;
  document.getElementById("fvReviewApprove").onclick = _fvReviewApprove;
  ov.querySelectorAll("[data-fv-chip]").forEach((b) => {
    b.addEventListener("click", () => _fvInsertNameToken(b.getAttribute("data-token")));
  });
  _fvReviewRender();
  _fvAugmentNameSuggestions(_rc); // best-effort: add co-borrowers / related people to the datalist
}

// Add co-borrower + related-people names to the rename autocomplete datalist.
// Best-effort and async — never blocks the modal.
async function _fvAugmentNameSuggestions(contact) {
  if (!contact || !contact.id) return;
  const extra = [];
  try {
    const { supabase } = await import("/api/supabase-client.js");
    try {
      const { data } = await supabase
        .from("mortgage_applications_secure")
        .select("co_borrower_first_name,co_borrower_last_name")
        .eq("contact_id", contact.id).order("created_at", { ascending: false }).limit(1);
      const a = data && data[0];
      if (a) {
        const co = [a.co_borrower_first_name, a.co_borrower_last_name].filter(Boolean).join(" ").trim();
        if (co) extra.push(co);
        if (a.co_borrower_first_name) extra.push(String(a.co_borrower_first_name).trim());
      }
    } catch (_) {}
    try {
      const { data } = await supabase.from("loan_contacts").select("name").eq("contact_id", contact.id);
      (data || []).forEach((r) => { if (r && r.name && String(r.name).trim()) extra.push(String(r.name).trim()); });
    } catch (_) {}
  } catch (_) {}
  if (!extra.length) return;
  const list = document.getElementById("fvReviewNameList");
  if (!list) return;
  const existing = new Set(Array.from(list.querySelectorAll("option")).map((o) => o.value));
  extra.forEach((n) => {
    if (n && !existing.has(n)) { existing.add(n); const o = document.createElement("option"); o.value = n; list.appendChild(o); }
  });
}

// Insert a name token (chip) at the caret in the rename field, joining onto
// existing text with the standard " – " separator. Keeps the field editable.
function _fvInsertNameToken(token) {
  const el = document.getElementById("fvReviewName");
  if (!el) return;
  token = String(token || "");
  const v = el.value;
  let start = el.selectionStart, end = el.selectionEnd;
  if (typeof start !== "number" || start < 0) { start = v.length; end = v.length; }
  const before = v.slice(0, start);
  const after = v.slice(end);
  let ins = token;
  if (before && !/[\s\-–]$/.test(before)) ins = " – " + ins; // join onto existing text nicely
  el.value = before + ins + after;
  const caret = (before + ins).length;
  el.focus();
  try { el.setSelectionRange(caret, caret); } catch (_) {}
  if (_fvReviewQueue[_fvReviewIndex]) _fvReviewQueue[_fvReviewIndex].suggestedName = el.value;
}

function _fvReviewStashName() {
  const q = _fvReviewQueue[_fvReviewIndex];
  const el = document.getElementById("fvReviewName");
  if (q && el) q.suggestedName = el.value;
}

function _fvReviewNav(delta) {
  _fvReviewStashName();
  const n = _fvReviewIndex + delta;
  if (n < 0 || n >= _fvReviewQueue.length) return;
  _fvReviewIndex = n;
  _fvReviewRender();
}

function _fvReviewRender() {
  const q = _fvReviewQueue[_fvReviewIndex];
  if (!q) return;
  const prog = document.getElementById("fvReviewProgress");
  if (prog) prog.textContent = `${_fvReviewIndex + 1} of ${_fvReviewQueue.length}` + (q.approved ? " · approved ✓" : "");
  const typeEl = document.getElementById("fvReviewType");
  if (typeEl) typeEl.textContent = (q.docType ? q.docType.replace(/_/g, " ") : "—") + (q.category ? ` · ${q.category}` : "");
  const curEl = document.getElementById("fvReviewCurrent");
  if (curEl) curEl.textContent = q.originalName || "(unnamed)";
  const nameEl = document.getElementById("fvReviewName");
  if (nameEl) nameEl.value = q.suggestedName || "";
  const flag = document.getElementById("fvReviewFlag");
  if (flag) flag.style.display = q.flagged ? "block" : "none";
  const fEl = document.getElementById("fvReviewFields");
  if (fEl) {
    const keys = Object.keys(q.fields || {}).slice(0, 8);
    fEl.innerHTML = keys.length
      ? ("<div style='color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px;'>Extracted</div>" +
         keys.map((k) => `<div style="margin-bottom:2px;"><span style='color:#888;'>${_fvEscape(k)}:</span> ${_fvEscape(String(q.fields[k]))}</div>`).join(""))
      : "";
  }
  const prevB = document.getElementById("fvReviewPrev"), nextB = document.getElementById("fvReviewNext");
  if (prevB) { prevB.disabled = _fvReviewIndex === 0; prevB.style.opacity = prevB.disabled ? ".4" : "1"; }
  if (nextB) { nextB.disabled = _fvReviewIndex >= _fvReviewQueue.length - 1; nextB.style.opacity = nextB.disabled ? ".4" : "1"; }
  // Only Pay Stub / W-2 / Bank Statement map to the 1003.
  const pullB = document.getElementById("fvReviewPull");
  if (pullB) { pullB.style.display = _fvDocMapsTo1003(q.docType) ? "" : "none"; pullB.disabled = false; pullB.textContent = "⇣ Pull to 1003"; }
  _fvReviewLoadPreview(q.file);
}

async function _fvReviewLoadPreview(f) {
  const host = document.getElementById("fvReviewPreview");
  if (!host) return;
  if (_fvReviewBlobUrl) { try { URL.revokeObjectURL(_fvReviewBlobUrl); } catch (_) {} _fvReviewBlobUrl = null; }
  host.innerHTML = '<div style="color:#666;font-size:13px;display:flex;align-items:center;gap:10px;"><span style="width:16px;height:16px;border:2px solid #C9A84C;border-top-color:transparent;border-radius:50%;animation:fvSpin .7s linear infinite;"></span>Loading preview…</div>';
  const myIndex = _fvReviewIndex;
  try {
    const blob = await _fvDownloadBlob(f.id);
    if (_fvReviewIndex !== myIndex || !document.getElementById("fvReviewPreview")) return;
    const url = URL.createObjectURL(blob);
    _fvReviewBlobUrl = url;
    const mime = f.mimeType || blob.type || "";
    if (mime.indexOf("image/") === 0) {
      host.innerHTML = `<img src="${url}" alt="" style="max-width:100%;max-height:100%;object-fit:contain;display:block;">`;
    } else if (mime.indexOf("pdf") >= 0 || /\.pdf$/i.test(f.name || "")) {
      host.innerHTML = `<iframe src="${url}" title="preview" style="width:100%;height:100%;border:none;background:#fff;"></iframe>`;
    } else {
      host.innerHTML = `<div style="color:#888;font-size:13px;text-align:center;padding:30px;">No inline preview for this file type.<br>You can still set a name and approve.</div>`;
    }
  } catch (e) {
    if (document.getElementById("fvReviewPreview")) host.innerHTML = `<div style="color:#e0a0a0;font-size:13px;padding:30px;text-align:center;">Preview failed: ${_fvEscape((e && e.message) || "error")}</div>`;
  }
}

// Advance to the next queued item, or finish after the last. Writes NOTHING.
function _fvReviewAdvance() {
  if (_fvReviewIndex >= _fvReviewQueue.length - 1) _fvFinishReview();
  else { _fvReviewIndex++; _fvReviewRender(); }
}

// "Keep current name" / Skip — leave the file untouched and move on.
function _fvReviewSkip() { _fvReviewAdvance(); }

// The ONLY action that writes a new name to Drive.
async function _fvReviewApprove() {
  const q = _fvReviewQueue[_fvReviewIndex];
  if (!q) return;
  const el = document.getElementById("fvReviewName");
  let newName = ((el && el.value) || "").trim();
  if (!newName) { _fvShowToast("Enter a name first"); return; }
  newName = _fvKeepExt(newName, q.ext);
  q.suggestedName = newName;

  // No-op when the proposed name already matches the file's current name.
  const currentName = q.file.name || q.originalName || "";
  if (newName === currentName) {
    _fvShowToast("Already named — nothing to change");
    _fvReviewAdvance();
    return;
  }

  const btn = document.getElementById("fvReviewApprove");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    await _fvRenameDriveFile(q.file.id, newName);
    q.file.name = newName;
    const who = await _fvAdminIdentity();
    try { await _fvSetReviewedMeta(q.file.id, who); } catch (_) {}
    q.approved = true;
  } catch (e) {
    _fvShowToast("Approve failed: " + ((e && e.message) || e));
    if (btn) { btn.disabled = false; btn.textContent = "Approve & rename →"; }
    return;
  }
  if (btn) { btn.disabled = false; btn.textContent = "Approve & rename →"; }
  _fvReviewAdvance();
}

/* ── PULL TO 1003 ─────────────────────────────────────────────────── */
// Only Pay Stub / W-2 / Bank Statement map to the 1003.
function _fvDocMapsTo1003(docType) {
  const dt = (docType || "").toLowerCase();
  if (dt.indexOf("pay") >= 0) return true;            // pay stub / pay_stubs / paystub
  if (dt === "w2" || dt.indexOf("w-2") >= 0 || dt.indexOf("w2") >= 0) return true;
  if (dt.indexOf("bank") >= 0) return true;           // bank statement(s)
  return false;
}

// Format a numeric value as money with thousands separators.
function _fv1003Money(v) {
  if (v == null || v === "") return "—";
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  if (!isFinite(n)) return _fvEscape(String(v));
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// Authenticated call to the ocr-apply-1003 edge fn (verify_jwt=true) — same
// session-Bearer style as the textract-ocr scan call. No `owner` is sent, so the
// function attributes rows to the document's own extracted name (co-borrower-safe).
async function _fvCall1003Apply(item, preview) {
  const jwt = await _fvUserAccessToken();
  if (!jwt) throw new Error("Session expired — sign in and retry");
  const anon = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_ANON_KEY) || "";
  const body = {
    contact_id: item.contactId,
    doc_type: item.docType,
    fields: item.fields || {},
    job_id: item.jobId || null,
    preview: !!preview,
  };
  const res = await fetch(_fvFnBase() + "/functions/v1/ocr-apply-1003", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + jwt, "apikey": anon },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = "ocr-apply-1003 HTTP " + res.status;
    try { const j = await res.json(); if (j && (j.error || j.message)) msg = j.error || j.message; } catch (_) {}
    throw new Error(msg);
  }
  return await res.json();
}

// "Pull to 1003" — fetch a preview plan, then show it for confirmation.
async function _fvPullTo1003() {
  const q = _fvReviewQueue[_fvReviewIndex];
  if (!q) return;
  if (!_fvDocMapsTo1003(q.docType)) { _fvShowToast("This document type doesn't map to the 1003"); return; }
  const btn = document.getElementById("fvReviewPull");
  if (btn) { btn.disabled = true; btn.textContent = "Reading…"; }
  try {
    const resp = await _fvCall1003Apply(q, true);
    _fv1003ShowPlan(q, resp);
  } catch (e) {
    _fvShowToast("Pull to 1003 failed: " + ((e && e.message) || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "⇣ Pull to 1003"; }
  }
}

// Render the preview plan inside the modal with a Confirm-write action.
function _fv1003ShowPlan(item, resp) {
  const plan = (resp && (resp.plan || resp)) || {};
  const income = Array.isArray(plan.income) ? plan.income : [];
  const assets = Array.isArray(plan.assets) ? plan.assets : [];
  const employment = plan.employment || plan.employment_update || null;
  const notes = Array.isArray(plan.notes) ? plan.notes : [];

  const sec = (t) => `<div style="color:#C9A84C;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin:14px 0 6px;">${t}</div>`;
  const empty = (m) => `<div style="color:#666;font-size:12px;">${m}</div>`;
  const card = (head, right, sub) =>
    `<div style="background:#161616;border:1px solid #2a2a2a;border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:12px;color:#ddd;">
       <div style="display:flex;justify-content:space-between;gap:8px;"><span style="color:#e8e8e8;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${head}</span><span style="color:#C9A84C;flex-shrink:0;">${right}</span></div>
       ${sub ? `<div style="color:#888;margin-top:2px;">${sub}</div>` : ""}
     </div>`;

  let html = "";
  html += sec("Income");
  html += income.length ? income.map((r) => card(
    _fvEscape(r.employer_name || r.income_type || "Income"),
    _fv1003Money(r.monthly_amount) + "/mo",
    [r.income_owner, r.income_type, (r.annual_amount != null && r.annual_amount !== "") ? _fv1003Money(r.annual_amount) + "/yr" : ""].filter(Boolean).map(_fvEscape).join(" · ")
  )).join("") : empty("No income rows.");

  html += sec("Assets");
  html += assets.length ? assets.map((r) => card(
    _fvEscape(r.institution_name || r.asset_type || "Asset"),
    _fv1003Money(r.current_value),
    [r.asset_owner, r.asset_type].filter(Boolean).map(_fvEscape).join(" · ")
  )).join("") : empty("No asset rows.");

  if (employment && (employment.employer_name || employment.base_income != null)) {
    html += sec("Employment update");
    html += card(
      _fvEscape(employment.employer_name || "—"),
      (employment.base_income != null && employment.base_income !== "") ? _fv1003Money(employment.base_income) : "",
      "base income"
    );
  }

  if (notes.length) {
    html += sec("Notes");
    html += `<div style="color:#aaa;font-size:12px;line-height:1.5;">${notes.map((n) => "• " + _fvEscape(String(n))).join("<br>")}</div>`;
  }

  const old = document.getElementById("fv1003Overlay"); if (old) old.remove();
  const ov = document.createElement("div");
  ov.id = "fv1003Overlay";
  ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9992;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif;";
  ov.innerHTML = `
    <div style="width:520px;max-width:94vw;max-height:84vh;display:flex;flex-direction:column;background:#0e0e0e;border:1px solid #C9A84C66;border-radius:14px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.7);">
      <div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #1e1e1e;flex-shrink:0;">
        <span style="color:#C9A84C;font-size:13px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;">Pull to 1003 — preview</span>
        <span style="flex:1;"></span>
        <span style="color:#666;font-size:12px;">${_fvEscape((item.docType || "").replace(/_/g, " "))}</span>
      </div>
      <div style="padding:6px 18px 14px;overflow-y:auto;">${html || empty("Nothing to apply.")}</div>
      <div style="display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid #1e1e1e;flex-shrink:0;">
        <button id="fv1003Cancel" style="background:transparent;border:1px solid #2a2a2a;color:#aaa;font-size:13px;padding:8px 16px;border-radius:8px;cursor:pointer;font-family:inherit;">Cancel</button>
        <span style="flex:1;"></span>
        <button id="fv1003Confirm" style="background:#C9A84C;border:none;color:#000;font-size:13px;font-weight:700;padding:8px 20px;border-radius:8px;cursor:pointer;font-family:inherit;">Confirm &amp; write to 1003</button>
      </div>
    </div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
  document.getElementById("fv1003Cancel").onclick = () => ov.remove();
  document.getElementById("fv1003Confirm").onclick = () => _fv1003Confirm(item);
}

// Confirm — re-POST the same body with preview:false and toast the written counts.
async function _fv1003Confirm(item) {
  const btn = document.getElementById("fv1003Confirm");
  if (btn) { btn.disabled = true; btn.textContent = "Writing…"; }
  try {
    const resp = await _fvCall1003Apply(item, false);
    const w = (resp && resp.written) || {};
    const inc = Number(w.income || 0), ast = Number(w.assets || 0);
    const parts = [];
    if (inc) parts.push(`${inc} income row${inc === 1 ? "" : "s"}`);
    if (ast) parts.push(`${ast} asset row${ast === 1 ? "" : "s"}`);
    if (w.employment_updated) parts.push("updated employment");
    _fvShowToast(parts.length ? ("Added " + parts.join(", ") + " ✓") : "1003 already up to date ✓");
    const ov = document.getElementById("fv1003Overlay"); if (ov) ov.remove();
  } catch (e) {
    _fvShowToast("Write to 1003 failed: " + ((e && e.message) || e));
    if (btn) { btn.disabled = false; btn.textContent = "Confirm & write to 1003"; }
  }
}

function _fvFinishReview() {
  const approved = _fvReviewQueue.filter((q) => q.approved).length;
  const total = _fvReviewQueue.length;
  _fvCloseReviewModal();
  _fvShowToast(`Reviewed ${approved} of ${total} ✓`);
  // Refresh the file list so the new names show.
  const contact = _fvCurrentContact();
  const folderId = _fvCurrentFolderIdResolved();
  if (folderId && contact) { _fvLoadFiles(folderId).then(() => _fvRenderFileListPanel(contact)).catch(() => {}); }
}

function _fvCloseReviewModal() {
  _fvReviewStashName();
  if (_fvReviewBlobUrl) { try { URL.revokeObjectURL(_fvReviewBlobUrl); } catch (_) {} _fvReviewBlobUrl = null; }
  const plan = document.getElementById("fv1003Overlay"); if (plan) plan.remove();
  const ov = document.getElementById("fvReviewOverlay");
  if (ov) ov.remove();
}

// Themed summary dialog (used by Convert all to PDF for skipped/errored files).
function _fvShowSummary(title, lines) {
  const ov = document.createElement("div");
  ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9991;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif;";
  ov.innerHTML = `
    <div style="width:520px;max-width:94vw;background:#0e0e0e;border:1px solid #C9A84C44;border-radius:14px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.6);">
      <div style="padding:14px 18px;border-bottom:1px solid #1e1e1e;color:#C9A84C;font-size:13px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;">${_fvEscape(title)}</div>
      <div style="padding:16px 18px;color:#ccc;font-size:13px;line-height:1.6;max-height:50vh;overflow-y:auto;">${lines.map((l) => `<div style="margin-bottom:6px;">${_fvEscape(l)}</div>`).join("")}</div>
      <div style="padding:12px 18px;border-top:1px solid #1e1e1e;text-align:right;"><button style="background:#C9A84C;border:none;color:#000;font-size:13px;font-weight:700;padding:7px 18px;border-radius:8px;cursor:pointer;font-family:inherit;">Got it</button></div>
    </div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
  ov.querySelector("button").onclick = () => ov.remove();
  document.body.appendChild(ov);
}

// ── INLINE FILE VIEWER (right panel view toggle) ────────────────
// The viewer chrome is pre-mounted in the shell. This function just
// populates fields and toggles the right panel to the viewer view.
function _fvOpenViewer(contact, files, index) {
  // Never try to "view" a folder — navigate into it instead.
  const file = files[index];
  if (file && file.mimeType === "application/vnd.google-apps.folder") {
    _fvNavigateIntoFolder(file);
    return;
  }
  _fvRevokeBlobUrl();
  _fvViewerState = { contactId: contact.id, files, index, blobUrl: null };

  // Swap right panel to viewer view.
  const listView = document.getElementById("fv-view-list");
  const viewerView = document.getElementById("fv-view-viewer");
  if (listView) listView.style.display = "none";
  if (viewerView) viewerView.style.display = "flex";

  _fvViewerRender();
  _fvHighlightActiveFileRow();
}

// Toggle back to the file-list view.
function _fvShowFileList() {
  _fvRevokeBlobUrl();
  const listView = document.getElementById("fv-view-list");
  const viewerView = document.getElementById("fv-view-viewer");
  if (listView) listView.style.display = "flex";
  if (viewerView) viewerView.style.display = "none";
  // Clear any active-row highlight from the file list.
  document.querySelectorAll(".fv-file-row.active").forEach((r) => r.classList.remove("active"));
  _fvViewerState = null;
}

// Highlight the active row in Panel 2 and scroll it into view.
function _fvHighlightActiveFileRow() {
  if (!_fvViewerState) return;
  const activeId = _fvViewerState.files[_fvViewerState.index]?.id;
  if (!activeId) return;
  const host = document.getElementById("fv-file-list");
  if (!host) return;
  host.querySelectorAll(".fv-file-row").forEach((row) => {
    row.classList.toggle("active", row.dataset.fvRow === activeId);
  });
}

function _fvViewerPrev() { _fvViewerNav(-1); }
function _fvViewerNext() { _fvViewerNav(1); }

// PATCH file.appProperties.docType on Drive and sync the in-memory file +
// any visible row badge. Extracted from the inline change handler so the
// template-only mount path can pass a single listener reference.
async function _fvSaveDocType(e, currentFile) {
  if (!currentFile) return;
  const sel = e.currentTarget;
  const newVal = sel.value;
  const prev = sel.dataset.prev || "";
  sel.dataset.prev = newVal;
  try {
    const token = await _fvEnsureToken();
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(currentFile.id)}?fields=id,appProperties`,
      {
        method: "PATCH",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ appProperties: { docType: newVal } })
      }
    );
    if (res.status === 401 || res.status === 403) _fvClearToken();
    if (!res.ok) throw new Error("HTTP " + res.status);
    currentFile.appProperties = currentFile.appProperties || {};
    currentFile.appProperties.docType = newVal;
    const rowBadge = document.querySelector(`[data-fv-row="${currentFile.id}"] .fv-doc-type-badge`);
    if (rowBadge) rowBadge.textContent = newVal;
    _fvShowToast("Document type saved");
  } catch (err) {
    console.error("[FileVault][docType]", err);
    sel.value = prev;
    sel.dataset.prev = prev;
    _fvShowToast("Failed to save type");
  }
}

function _fvRevokeBlobUrl() {
  if (_fvViewerState && _fvViewerState.blobUrl) {
    try { URL.revokeObjectURL(_fvViewerState.blobUrl); } catch (_) {}
    _fvViewerState.blobUrl = null;
  }
}

// Back-compat shim — "close" means return to the file-list view.
function _fvCloseViewer() { _fvShowFileList(); }

function _fvViewerNav(delta) {
  if (!_fvViewerState) return;
  const next = _fvViewerState.index + delta;
  if (next < 0 || next >= _fvViewerState.files.length) return;
  // Revoke the previous file's blob URL before switching.
  _fvRevokeBlobUrl();
  _fvViewerState.index = next;
  _fvViewerRender();
}

async function _fvViewerRender() {
  if (!_fvViewerState) return;
  const { files, index } = _fvViewerState;
  const f = files[index];
  if (!f) return;
  const title = document.getElementById("fv-viewer-title");
  const counter = document.getElementById("fv-viewer-counter");
  const prev = document.getElementById("fv-viewer-prev");
  const next = document.getElementById("fv-viewer-next");
  const iframe = document.getElementById("fv-viewer-iframe");
  if (!title || !iframe) return;

  title.textContent = f.name || "Untitled";
  title.title = f.name || "";
  counter.textContent = `${index + 1} of ${files.length}`;
  prev.disabled = index === 0;
  next.disabled = index === files.length - 1;
  prev.style.opacity = prev.disabled ? "0.4" : "1";
  next.style.opacity = next.disabled ? "0.4" : "1";

  // Sync doc-type pill to this file's saved appProperties.docType.
  const typeSel = document.getElementById("fv-doc-type");
  if (typeSel) {
    const currentType = (f.appProperties && f.appProperties.docType) || "";
    typeSel.value = currentType;
    typeSel.dataset.prev = currentType;
  }

  _fvLoadBlobIntoIframe(f);
  _fvHighlightActiveFileRow();
}

// Lazy-load pdf.js from CDN once per session.
let _fvPdfJsPromise = null;
function _fvEnsurePdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_fvPdfJsPromise) return _fvPdfJsPromise;
  _fvPdfJsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => {
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      } else {
        reject(new Error("pdfjsLib missing after script load"));
      }
    };
    s.onerror = () => { _fvPdfJsPromise = null; reject(new Error("pdf.js CDN failed to load")); };
    document.head.appendChild(s);
  });
  return _fvPdfJsPromise;
}

// PDF editing state — mirrors the lead-detail.html docViewer state but
// scoped to the File Vault component.
function _fvResetPdfEditState() {
  if (_fvViewerState) {
    _fvViewerState.pdfDoc = null;
    _fvViewerState.scale = 1.0;
    _fvViewerState.rotation = 0;
    _fvViewerState.savedRotation = 0;
    _fvViewerState.type = null;
    _fvViewerState.cropMode = false;
    _fvViewerState.cropSelection = null;
    _fvViewerState.cropDragging = false;
  }
}

// Load file bytes via Drive alt=media + OAuth token. PDFs render into a
// <canvas> stack via pdf.js (no browser-native viewer chrome). Images render
// inline. Other types fall back to the Google Docs viewer iframe.
async function _fvLoadBlobIntoIframe(f) {
  const iframe = document.getElementById("fv-viewer-iframe");
  const canvasWrap = document.getElementById("fv-viewer-canvas-wrap");
  if (!iframe || !canvasWrap) return;
  const renderIndex = _fvViewerState && _fvViewerState.index;
  const mime = f.mimeType || "";
  const isPdf = _fvIsPdf(f);
  const isImage = mime.indexOf("image/") === 0;

  // Reset editing state (rotation/crop) for the new file.
  _fvResetPdfEditState();
  _fvUpdatePdfToolbarVisibility();

  // Show loading state in the canvas wrap; hide the iframe by default.
  canvasWrap.style.display = "block";
  canvasWrap.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;padding:60px 20px;color:#666;font-family:system-ui;gap:10px;">' +
    '<span style="width:18px;height:18px;border:2px solid #C9A84C;border-top-color:transparent;border-radius:50%;animation:fvSpin .7s linear infinite;"></span>Loading…</div>';
  iframe.style.display = "none";
  iframe.src = "about:blank";

  if (isPdf || isImage) {
    try {
      const token = await _fvEnsureToken();
      // Cache-bust query param + no-cache headers — after Save Rotation the
      // Drive file id is unchanged, so without this the browser/CDN serves
      // the stale pre-rotation bytes and the viewer looks like nothing
      // happened.
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true&t=${Date.now()}`,
        {
          headers: {
            Authorization: "Bearer " + token,
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
          },
          cache: "no-store",
        }
      );
      if (res.status === 401 || res.status === 403) _fvClearToken();
      if (!res.ok) throw new Error("HTTP " + res.status);
      const buf = await res.arrayBuffer();
      // Stale-fetch guard — user navigated away mid-load.
      if (!_fvViewerState || _fvViewerState.index !== renderIndex) return;

      if (isPdf) {
        const pdfjsLib = await _fvEnsurePdfJs();
        if (!_fvViewerState || _fvViewerState.index !== renderIndex) return;
        let pdfDoc;
        try {
          pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
        } catch (gdErr) {
          console.error(
            "[pdf.js] getDocument failed — workerSrc=" +
              (pdfjsLib.GlobalWorkerOptions && pdfjsLib.GlobalWorkerOptions.workerSrc) +
              " err=",
            gdErr
          );
          // Fallback: disable the worker and retry on the main thread.
          // Slower, but avoids any blob:/worker/CSP/MIME failure mode.
          try {
            pdfjsLib.GlobalWorkerOptions.workerSrc = "";
            pdfDoc = await pdfjsLib.getDocument({
              data: new Uint8Array(buf),
              disableWorker: true,
              workerPort: null,
            }).promise;
            console.warn("[pdf.js] main-thread fallback succeeded");
          } catch (fbErr) {
            console.error("[pdf.js] main-thread fallback also failed:", fbErr);
            throw fbErr;
          }
        }
        if (!_fvViewerState || _fvViewerState.index !== renderIndex) return;
        _fvViewerState.pdfDoc = pdfDoc;
        _fvViewerState.type = "pdf";
        _fvViewerState.scale = 1.0;
        _fvViewerState.rotation = 0;
        await _fvRenderPdfPages(renderIndex);
        _fvUpdatePdfToolbarVisibility();
      } else {
        // Image: blob URL inside an <img>, retain blobUrl for cleanup.
        _fvRevokeBlobUrl();
        const blob = new Blob([buf], { type: mime || "image/jpeg" });
        const blobUrl = URL.createObjectURL(blob);
        _fvViewerState.blobUrl = blobUrl;
        _fvViewerState.type = "image";
        canvasWrap.innerHTML = '<img src="' + blobUrl + '" alt="" style="display:block;margin:0 auto;max-width:100%;height:auto;border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,.5);">';
        _fvUpdatePdfToolbarVisibility();
      }
    } catch (e) {
      console.error("[FileVault][viewer] fetch failed:", e);
      canvasWrap.innerHTML =
        '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;color:#e0a0a0;font-family:system-ui;gap:10px;">' +
        '<div style="font-size:2rem;">⚠️</div><div>Preview failed: ' +
        (e.message || "network error").replace(/</g, "&lt;") + "</div></div>";
    }
    return;
  }

  // Google-native docs + other types: use the Docs viewer proxy iframe.
  _fvViewerState.type = "other";
  _fvUpdatePdfToolbarVisibility();
  canvasWrap.style.display = "none";
  canvasWrap.innerHTML = "";
  iframe.style.display = "block";
  const docsViewerUrl = "https://docs.google.com/viewer?embedded=true&url=" +
    encodeURIComponent(`https://drive.google.com/uc?export=download&id=${f.id}`);
  iframe.src = docsViewerUrl;
}

// Render every page of the current PDF using state.scale + state.rotation.
async function _fvRenderPdfPages(renderIndex) {
  const canvasWrap = document.getElementById("fv-viewer-canvas-wrap");
  if (!canvasWrap || !_fvViewerState || !_fvViewerState.pdfDoc) return;
  const pdfDoc = _fvViewerState.pdfDoc;
  const baseScale = 1.5;
  const totalScale = (_fvViewerState.scale || 1) * baseScale;
  const rotation = _fvViewerState.rotation || 0;
  canvasWrap.innerHTML = "";
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    if (!_fvViewerState || (renderIndex != null && _fvViewerState.index !== renderIndex)) return;
    const viewport = page.getViewport({ scale: totalScale, rotation });
    const canvas = document.createElement("canvas");
    canvas.dataset.page = String(i);
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.cssText = "display:block;margin:0 auto 12px;max-width:100%;height:auto;background:#fff;box-shadow:0 4px 16px rgba(0,0,0,.5);border-radius:4px;";
    canvasWrap.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  }
}

// Toggle visibility of the PDF editing toolbar based on current file type.
function _fvUpdatePdfToolbarVisibility() {
  const bar = document.getElementById("fv-pdf-toolbar");
  if (!bar) return;
  bar.style.display = (_fvViewerState && _fvViewerState.type === "pdf") ? "flex" : "none";
  _fvUpdateSaveRotBtn();
  _fvSetCropBtnsVisibility(false);
}

function _fvUpdateSaveRotBtn() {
  const btn = document.getElementById("fv-pdf-save-rot-btn");
  if (!btn) return;
  // Visible when the on-screen rotation differs from the last-saved rotation.
  // After Save Rotation succeeds we set savedRotation = current rotation so
  // the button hides without needing a Drive re-fetch.
  const visible =
    _fvViewerState &&
    _fvViewerState.type === "pdf" &&
    (_fvViewerState.rotation || 0) !== (_fvViewerState.savedRotation || 0);
  btn.style.display = visible ? "inline-flex" : "none";
}

function _fvSetCropBtnsVisibility(show) {
  const apply = document.getElementById("fv-pdf-crop-apply-btn");
  const cancel = document.getElementById("fv-pdf-crop-cancel-btn");
  if (apply) apply.style.display = show ? "inline-flex" : "none";
  if (cancel) cancel.style.display = show ? "inline-flex" : "none";
}

function _fvSyncZoomInput() {
  const lvl = document.getElementById("fv-pdf-zoom-level");
  if (lvl && _fvViewerState) lvl.value = Math.round((_fvViewerState.scale || 1) * 100) + "%";
}

// ── PDF EDITING ACTIONS ────────────────────────────────────────────────

function _fvPdfZoom(delta) {
  if (!_fvViewerState || _fvViewerState.type !== "pdf") return;
  _fvViewerState.scale = Math.max(0.4, Math.min(3.0, (_fvViewerState.scale || 1) + delta));
  _fvSyncZoomInput();
  _fvRenderPdfPages(_fvViewerState.index);
}

function _fvPdfZoomTo(percent) {
  if (!_fvViewerState || _fvViewerState.type !== "pdf") return;
  const pct = Math.max(40, Math.min(300, Number(percent) || 100));
  _fvViewerState.scale = pct / 100;
  _fvSyncZoomInput();
  _fvRenderPdfPages(_fvViewerState.index);
}

function _fvPdfRotate() {
  if (!_fvViewerState || _fvViewerState.type !== "pdf") return;
  _fvViewerState.rotation = ((_fvViewerState.rotation || 0) + 90) % 360;
  _fvRenderPdfPages(_fvViewerState.index).then(() => {
    _fvUpdateSaveRotBtn();
  });
}

async function _fvPdfSaveRotation() {
  if (!_fvViewerState || _fvViewerState.type !== "pdf") return;
  const file = _fvViewerState.files && _fvViewerState.files[_fvViewerState.index];
  if (!file || !_fvViewerState.rotation) return;
  const btn = document.getElementById("fv-pdf-save-rot-btn");
  const SAVE_BTN_HTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5h-9a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-9z"/><polyline points="4 1.5 4 5.5 10 5.5 10 1.5"/><rect x="4" y="9" width="8" height="5"/></svg><span class="fv-tb-label">Save</span>';
  const pendingRot = _fvViewerState.rotation;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span style="display:inline-block;width:10px;height:10px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:fvSpin .7s linear infinite;"></span><span class="fv-tb-label">Saving</span>';
  }
  try {
    const { supabase } = await import("/api/supabase-client.js");
    const sess = await supabase.auth.getSession();
    const accessToken = sess?.data?.session?.access_token;
    if (!accessToken) throw new Error("Not signed in — refresh and log in again");
    const base = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_URL) || "";
    const res = await fetch(base + "/functions/v1/save-document", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
      body: JSON.stringify({ file_id: file.id, rotation_degrees: pendingRot }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error((data && data.error) || ("HTTP " + res.status));
    // The viewer is already showing the rotated pages (we render with
    // state.rotation each time). Mark the rotation as saved so the Save
    // button hides — no Drive re-fetch needed. Drive's CDN ignores cache-
    // busting query params, so a re-fetch would return stale bytes anyway.
    if (_fvViewerState) _fvViewerState.savedRotation = pendingRot;
    if (btn) {
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8.5 6.5 12 13 4.5"/></svg><span class="fv-tb-label">Saved</span>';
    }
    _fvShowToast("Rotation saved");
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = SAVE_BTN_HTML;
      }
      _fvUpdateSaveRotBtn();
    }, 900);
  } catch (e) {
    console.error("[FileVault][saveRotation] failed:", e);
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = SAVE_BTN_HTML;
    }
    _fvShowToast("Save failed: " + (e.message || e));
  }
}

// ── CROP TOOL ──────────────────────────────────────────────────────────

function _fvPdfToggleCrop() {
  if (!_fvViewerState || _fvViewerState.type !== "pdf") {
    _fvShowToast("Crop only works on PDFs");
    return;
  }
  if (!_fvViewerState.cropMode && (_fvViewerState.rotation || 0) !== 0) {
    _fvShowToast("Reset rotation to 0 before cropping");
    return;
  }
  if (_fvViewerState.cropMode) { _fvPdfExitCropMode(); return; }
  _fvViewerState.cropMode = true;
  _fvViewerState.cropSelection = null;
  const btn = document.getElementById("fv-pdf-crop-btn");
  if (btn) btn.classList.add("is-active");
  const wrap = document.getElementById("fv-viewer-canvas-wrap");
  if (wrap) {
    wrap.style.cursor = "crosshair";
    wrap.addEventListener("mousedown", _fvPdfCropMouseDown);
  }
}

function _fvPdfExitCropMode() {
  if (!_fvViewerState) return;
  _fvViewerState.cropMode = false;
  _fvViewerState.cropDragging = false;
  _fvViewerState.cropSelection = null;
  const btn = document.getElementById("fv-pdf-crop-btn");
  if (btn) btn.classList.remove("is-active");
  const wrap = document.getElementById("fv-viewer-canvas-wrap");
  if (wrap) {
    wrap.style.cursor = "";
    wrap.removeEventListener("mousedown", _fvPdfCropMouseDown);
    const sel = document.getElementById("_fvCropRect");
    if (sel) sel.remove();
  }
  _fvSetCropBtnsVisibility(false);
}

function _fvPdfCropMouseDown(evt) {
  if (!_fvViewerState || !_fvViewerState.cropMode) return;
  if (!evt.target || !evt.target.closest) return;
  const canvas = evt.target.closest("canvas[data-page]");
  if (!canvas) return;
  evt.preventDefault();
  const wrap = document.getElementById("fv-viewer-canvas-wrap");
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  const startX = evt.clientX - wrapRect.left + wrap.scrollLeft;
  const startY = evt.clientY - wrapRect.top  + wrap.scrollTop;
  const pageNum = parseInt(canvas.dataset.page || "1", 10);

  const prior = document.getElementById("_fvCropRect");
  if (prior) prior.remove();

  const rect = document.createElement("div");
  rect.id = "_fvCropRect";
  rect.style.cssText = "position:absolute;left:" + startX + "px;top:" + startY + "px;width:0;height:0;border:2px dashed #C9A84C;background:rgba(201,168,76,0.12);pointer-events:none;z-index:20;";
  wrap.appendChild(rect);

  _fvViewerState.cropDragging = true;
  _fvViewerState.cropSelection = { page: pageNum, canvas, left: startX, top: startY, width: 0, height: 0 };

  const move = (ev) => {
    if (!_fvViewerState || !_fvViewerState.cropDragging) return;
    const curX = ev.clientX - wrapRect.left + wrap.scrollLeft;
    const curY = ev.clientY - wrapRect.top  + wrap.scrollTop;
    const left = Math.min(startX, curX);
    const top  = Math.min(startY, curY);
    const width  = Math.abs(curX - startX);
    const height = Math.abs(curY - startY);
    rect.style.left   = left + "px";
    rect.style.top    = top + "px";
    rect.style.width  = width + "px";
    rect.style.height = height + "px";
    _fvViewerState.cropSelection.left = left;
    _fvViewerState.cropSelection.top = top;
    _fvViewerState.cropSelection.width = width;
    _fvViewerState.cropSelection.height = height;
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    _fvViewerState.cropDragging = false;
    if (!_fvViewerState.cropSelection || _fvViewerState.cropSelection.width < 8 || _fvViewerState.cropSelection.height < 8) {
      const el = document.getElementById("_fvCropRect");
      if (el) el.remove();
      _fvViewerState.cropSelection = null;
      _fvSetCropBtnsVisibility(false);
      return;
    }
    _fvSetCropBtnsVisibility(true);
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

async function _fvPdfApplyCrop() {
  if (!_fvViewerState || !_fvViewerState.cropSelection) return;
  const file = _fvViewerState.files && _fvViewerState.files[_fvViewerState.index];
  if (!file) return;
  const sel = _fvViewerState.cropSelection;
  const canvas = sel.canvas;
  if (!canvas) return;

  const baseScale = 1.5;
  const totalScale = (_fvViewerState.scale || 1) * baseScale;

  const canvasLeftInWrap = canvas.offsetLeft;
  const canvasTopInWrap  = canvas.offsetTop;
  const relLeft   = sel.left - canvasLeftInWrap;
  const relTop    = sel.top  - canvasTopInWrap;
  const dispW = canvas.offsetWidth;
  const dispH = canvas.offsetHeight;
  const clampedLeft   = Math.max(0, Math.min(dispW, relLeft));
  const clampedTop    = Math.max(0, Math.min(dispH, relTop));
  const clampedRight  = Math.max(0, Math.min(dispW, relLeft + sel.width));
  const clampedBottom = Math.max(0, Math.min(dispH, relTop  + sel.height));
  const finalLeft   = clampedLeft;
  const finalTop    = clampedTop;
  const finalWidth  = clampedRight - clampedLeft;
  const finalHeight = clampedBottom - clampedTop;
  if (finalWidth < 4 || finalHeight < 4) { _fvShowToast("Selection is outside the page"); return; }

  const ratio = canvas.width / (dispW || canvas.width);
  const intrLeft   = finalLeft   * ratio;
  const intrTop    = finalTop    * ratio;
  const intrWidth  = finalWidth  * ratio;
  const intrHeight = finalHeight * ratio;
  const pdfXTL = intrLeft   / totalScale;
  const pdfYTL = intrTop    / totalScale;
  const pdfW   = intrWidth  / totalScale;
  const pdfH   = intrHeight / totalScale;
  const pageHeightPdf = canvas.height / totalScale;
  const pdfXBL = pdfXTL;
  const pdfYBL = pageHeightPdf - (pdfYTL + pdfH);
  const cropPayload = { page: sel.page, x: pdfXBL, y: pdfYBL, width: pdfW, height: pdfH };

  const applyBtn = document.getElementById("fv-pdf-crop-apply-btn");
  const cancelBtn = document.getElementById("fv-pdf-crop-cancel-btn");
  if (applyBtn) { applyBtn.disabled = true; applyBtn.innerHTML = "Cropping…"; }
  if (cancelBtn) cancelBtn.disabled = true;

  try {
    const { supabase } = await import("/api/supabase-client.js");
    const sess = await supabase.auth.getSession();
    const accessToken = sess?.data?.session?.access_token;
    if (!accessToken) throw new Error("Not signed in — refresh and log in again");
    const base = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_URL) || "";
    const res = await fetch(base + "/functions/v1/save-document", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
      body: JSON.stringify({ file_id: file.id, crop: cropPayload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error((data && data.error) || ("HTTP " + res.status));
    _fvShowToast("Cropped!");
    _fvPdfExitCropMode();
    const contact = _fvContacts.find((c) => c.id === _fvViewerState.contactId);
    if (contact && contact.gdrive_folder_id) {
      await _fvLoadFiles(contact.gdrive_folder_id);
      const refreshed = _fvFiles[contact.gdrive_folder_id] || [];
      _fvViewerState.files = refreshed;
      const newId = (data.file && data.file.id) || file.id;
      const idx = refreshed.findIndex((x) => x.id === newId);
      if (idx >= 0) {
        _fvViewerState.index = idx;
        _fvViewerRender();
      }
      _fvRenderFileListPanel(contact);
    }
  } catch (e) {
    console.error("[FileVault] crop failed:", e);
    if (applyBtn) { applyBtn.disabled = false; applyBtn.innerHTML = "Apply Crop"; }
    if (cancelBtn) cancelBtn.disabled = false;
    _fvShowToast("Crop failed: " + (e.message || e));
  }
}

// Inline rename from inside the viewer header. Module-scoped so the click
// listener wired by _fvOpenViewer can invoke it directly. Accepts the live
// file reference from the caller so navigation between files never leaves
// a stale closure here.
async function _fvStartRenameInViewer(file) {
  const titleSpan = document.getElementById("fv-viewer-title");
  const pencilBtn = document.getElementById("fv-viewer-rename");
  const savingSpinner = document.getElementById("fv-viewer-saving");
  if (!titleSpan || !pencilBtn) return;

  const originalName = file.name;

  const input = document.createElement("input");
  input.type = "text";
  input.value = originalName;
  input.style.cssText = "background:transparent;border:1px solid #C9A84C;border-radius:4px;color:#C9A84C;font-size:14px;padding:2px 6px;min-width:180px;max-width:320px;outline:none;font-family:inherit;";
  input._fvDone = false;

  titleSpan.replaceWith(input);
  pencilBtn.style.display = "none";
  input.focus();
  input.select();

  function restore(name) {
    const newSpan = document.createElement("span");
    newSpan.id = "fv-viewer-title";
    newSpan.style.cssText = "color:#C9A84C;font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;";
    newSpan.textContent = name;
    newSpan.title = name;
    input.replaceWith(newSpan);
    pencilBtn.style.display = "";
  }

  function cancel() {
    input._fvDone = true;
    restore(originalName);
  }

  async function commit() {
    if (input._fvDone) return;
    input._fvDone = true;
    const newName = input.value.trim();
    if (!newName || newName === originalName) { restore(originalName); return; }

    if (savingSpinner) savingSpinner.style.display = "inline-block";
    try {
      const token = await _fvEnsureToken();
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?fields=id,name`,
        {
          method: "PATCH",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName })
        }
      );
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) _fvClearToken();
        throw new Error(`HTTP ${res.status}`);
      }
      file.name = newName;
      restore(newName);
      const rowName = document.querySelector(`[data-fv-row="${file.id}"] .fv-name`);
      if (rowName) rowName.textContent = newName;
      _fvShowToast("Renamed successfully");
    } catch (err) {
      console.error("[FileVault][rename]", err);
      _fvShowToast("Rename failed: " + err.message);
      restore(originalName);
    } finally {
      if (savingSpinner) savingSpinner.style.display = "none";
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", () => commit());
}

function _fvShowToast(msg) {
  let t = document.getElementById("fvToast");
  if (!t) {
    t = document.createElement("div");
    t.id = "fvToast";
    t.style.cssText = "position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#C9A84C;padding:10px 18px;border-radius:22px;border:1px solid #333;font-size:.82rem;font-weight:700;z-index:9999;box-shadow:0 6px 20px rgba(0,0,0,.5);font-family:system-ui,sans-serif;";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(t._hide);
  t._hide = setTimeout(() => { t.style.display = "none"; }, 3000);
}

// ── LEAD DETAIL DRAWER ────────────────────────────────────────────────────────
function expandToFullView() {
  if (!openLeadId) return;
  const lead = dashboardData?.leads?.find((l) => String(l.id) === String(openLeadId));
  const contactId = lead?.contact_id;
  if (contactId) {
    window.location.href = `../admin/lead-detail.html?contact_id=${contactId}`;
  } else {
    window.location.href = `../admin/lead-detail.html?lead_id=${openLeadId}`;
  }
}

function bindDrawer() {
  document.getElementById("drawer-close-btn")?.addEventListener("click", closeDrawer);
  document.getElementById("drawer-overlay")?.addEventListener("click", closeDrawer);
  document.getElementById("drawer-expand-btn")?.addEventListener("click", expandToFullView);
  document.querySelectorAll(".drawer-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".drawer-tab").forEach((t) => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      drawerActiveTab = tab.dataset.drawerTab;
      if (openLeadId) renderDrawerTab(drawerActiveTab, null);
    });
  });
  document.getElementById("drawer-edit-btn")?.addEventListener("click", () => {
    if (openLeadId) openLeadFormForEdit(openLeadId);
  });

  // Keyboard shortcut: F = expand to full view when drawer is open
  document.addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") {
      const focused = document.activeElement;
      const isTyping = focused && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.isContentEditable);
      if (!isTyping && openLeadId) expandToFullView();
    }
  });
}

async function openLeadDrawer(leadId) {
  openLeadId = leadId;
  const drawer = document.getElementById("lead-drawer");
  const overlay = document.getElementById("drawer-overlay");
  if (!drawer) return;
  drawer.classList.add("is-open");
  overlay?.classList.add("is-visible");
  document.body.style.overflow = "hidden";

  const body = document.getElementById("drawer-body");
  body.innerHTML = `<div style="padding:24px;color:var(--muted);">Loading lead details...</div>`;

  // Reset to details tab
  drawerActiveTab = "details";
  document.querySelectorAll(".drawer-tab").forEach((t) => t.classList.toggle("is-active", t.dataset.drawerTab === "details"));

  try {
    const detail = await getLeadDetail(leadId);
    await renderDrawerTab("details", detail);
  } catch (err) {
    body.innerHTML = `<div style="padding:24px;color:var(--red);">Error loading lead: ${err.message}</div>`;
  }
}

async function renderDrawerTab(tab, detail) {
  const body = document.getElementById("drawer-body");
  if (!body) return;

  if (!detail) {
    try {
      detail = await getLeadDetail(openLeadId); // eslint-disable-line no-param-reassign
    } catch (_) {
      body.innerHTML = `<div style="padding:24px;color:var(--red);">Error loading lead details.</div>`;
      return;
    }
  }

  const { lead, notes, tasks, activityEvents } = detail;
  const c = lead.contacts || {};
  const name = `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Unknown";

  // Update drawer header
  document.getElementById("drawer-lead-name").textContent = name;
  document.getElementById("drawer-lead-sub").textContent = `${lead.loan_type || "—"} · ${lead.status || "new"}`;

  if (tab === "details") {
    body.innerHTML = `
      <!-- Score + Status Row -->
      <div class="drawer-section drawer-score-row">
        ${scoreCard(lead.score)}
        <div style="flex:1;">
          <label class="field" style="margin:0;">
            <span style="font-size:0.75rem;color:var(--gold);text-transform:uppercase;letter-spacing:.1em;">Status</span>
            <select class="field input" id="drawer-status-select" style="margin-top:6px;">
              ${statusOptions(lead.status)}
            </select>
          </label>
        </div>
        <div class="drawer-ai-btns">
          <button class="btn btn-ghost btn-sm" id="drawer-draft-email">✉ Draft Email</button>
          <button class="btn btn-ghost btn-sm" id="drawer-draft-sms">💬 Draft SMS</button>
        </div>
      </div>

      <!-- AI Summary -->
      <div class="drawer-section drawer-ai-summary" id="drawer-ai-summary">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <p class="kicker" style="margin:0;">AI Summary</p>
          <button class="btn btn-ghost btn-xs" id="drawer-ai-refresh">↺ Refresh</button>
        </div>
        <div id="drawer-ai-summary-text" class="ai-summary-body">
          ${lead.ai_summary || `<span style="color:var(--muted);">Click ↺ Refresh to generate AI summary.</span>`}
        </div>
      </div>

      <!-- Contact Info -->
      <div class="drawer-section">
        <p class="kicker">Contact Information</p>
        <div class="detail-grid">
          <div class="detail-item"><span>Email</span><strong>${c.email || "—"}</strong></div>
          <div class="detail-item"><span>Phone</span><strong>${c.phone || "—"}</strong></div>
          <div class="detail-item"><span>Secondary Phone</span><strong>${c.secondary_phone || "—"}</strong></div>
          <div class="detail-item"><span>Credit Score</span><strong>${c.credit_score ? `<span class="${scoreBadgeClass(c.credit_score)}">${c.credit_score}</span>` : "—"}</strong></div>
          <div class="detail-item"><span>Employer</span><strong>${c.employer_name || "—"}</strong></div>
          <div class="detail-item"><span>Job Title</span><strong>${c.job_title || "—"}</strong></div>
          <div class="detail-item"><span>Monthly Income</span><strong>${c.monthly_income ? currency(c.monthly_income) : "—"}</strong></div>
          <div class="detail-item"><span>Address</span><strong>${[c.address, c.city, c.state, c.zip].filter(Boolean).join(", ") || "—"}</strong></div>
        </div>
      </div>

      <!-- Loan Details -->
      <div class="drawer-section">
        <p class="kicker">Loan Details</p>
        <div class="detail-grid">
          <div class="detail-item"><span>Loan Type</span><strong>${lead.loan_type || "—"}</strong></div>
          <div class="detail-item"><span>Loan Amount</span><strong>${lead.loan_amount ? currency(lead.loan_amount) : "—"}</strong></div>
          <div class="detail-item"><span>Purchase Price</span><strong>${lead.purchase_price ? currency(lead.purchase_price) : "—"}</strong></div>
          <div class="detail-item"><span>Down Payment</span><strong>${lead.down_payment ? currency(lead.down_payment) : "—"}</strong></div>
          <div class="detail-item"><span>LTV</span><strong>${lead.ltv ? `${lead.ltv}%` : "—"}</strong></div>
          <div class="detail-item"><span>Property Type</span><strong>${lead.property_type || "—"}</strong></div>
          <div class="detail-item"><span>Occupancy</span><strong>${lead.occupancy_type || "—"}</strong></div>
          <div class="detail-item"><span>Timeline</span><strong>${lead.timeline || "—"}</strong></div>
        </div>
      </div>

      <!-- Current Rate/Lender -->
      <div class="drawer-section">
        <p class="kicker">Current Mortgage</p>
        <div class="detail-grid">
          <div class="detail-item"><span>Current Rate</span><strong>${lead.current_interest_rate ? `${lead.current_interest_rate}%` : "—"}</strong></div>
          <div class="detail-item"><span>Current Lender</span><strong>${lead.current_lender || "—"}</strong></div>
          <div class="detail-item"><span>Monthly Payment</span><strong>${lead.current_monthly_payment ? currency(lead.current_monthly_payment) : "—"}</strong></div>
          <div class="detail-item"><span>Property Address</span><strong>${lead.property_address || "—"}</strong></div>
        </div>
      </div>
    `;

    // Bind status select
    const statusSelect = document.getElementById("drawer-status-select");
    statusSelect?.addEventListener("change", async () => {
      await updateLeadStatus(openLeadId, statusSelect.value);
      if (dashboardData) {
        const lead = dashboardData.leads.find((l) => String(l.id) === String(openLeadId));
        if (lead) lead.status = statusSelect.value;
      }
    });

    // AI summary refresh
    document.getElementById("drawer-ai-refresh")?.addEventListener("click", async () => {
      const el = document.getElementById("drawer-ai-summary-text");
      if (!el) return;
      el.textContent = "Generating summary...";
      try {
        const summary = await summarizeLead(lead);
        el.textContent = summary;
        await updateLead(openLeadId, { ai_summary: summary });
      } catch (err) {
        el.textContent = `Error: ${err.message}`;
      }
    });

    // Draft email
    document.getElementById("drawer-draft-email")?.addEventListener("click", async () => {
      const btn = document.getElementById("drawer-draft-email");
      btn.disabled = true;
      btn.textContent = "Drafting...";
      try {
        const draft = await draftEmail(lead);
        showAIResultModal("Draft Email", draft);
      } catch (err) {
        alert(`Error: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = "✉ Draft Email";
      }
    });

    // Draft SMS
    document.getElementById("drawer-draft-sms")?.addEventListener("click", async () => {
      const btn = document.getElementById("drawer-draft-sms");
      btn.disabled = true;
      btn.textContent = "Drafting...";
      try {
        const draft = await draftSMS(lead);
        showAIResultModal("Draft SMS", draft);
      } catch (err) {
        alert(`Error: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = "💬 Draft SMS";
      }
    });

  } else if (tab === "ai") {
    body.innerHTML = `
      <div class="drawer-section">
        <p class="kicker">AI Summary</p>
        <div id="ai-tab-summary" class="ai-summary-body" style="margin-bottom:16px;">
          ${lead.ai_summary || `<span style="color:var(--muted);">No summary yet.</span>`}
        </div>
        <div class="flex-gap" style="margin-bottom:24px;">
          <button class="btn btn-secondary btn-sm" id="ai-tab-summarize">↺ Generate Summary</button>
          <button class="btn btn-secondary btn-sm" id="ai-tab-score">🎯 Score Lead</button>
        </div>
      </div>
      <div class="drawer-section">
        <p class="kicker">Draft Communications</p>
        <div class="flex-gap" style="margin-bottom:12px;">
          <button class="btn btn-ghost btn-sm" id="ai-tab-email">✉ Draft Email</button>
          <button class="btn btn-ghost btn-sm" id="ai-tab-sms">💬 Draft SMS</button>
        </div>
        <div id="ai-draft-output" class="ai-draft-output" style="display:none;"></div>
      </div>
    `;

    document.getElementById("ai-tab-summarize")?.addEventListener("click", async () => {
      const el = document.getElementById("ai-tab-summary");
      el.textContent = "Generating...";
      try {
        const summary = await summarizeLead(lead);
        el.textContent = summary;
        await updateLead(openLeadId, { ai_summary: summary });
      } catch (err) { el.textContent = `Error: ${err.message}`; }
    });

    document.getElementById("ai-tab-score")?.addEventListener("click", async () => {
      const el = document.getElementById("ai-tab-summary");
      el.textContent = "Scoring lead...";
      try {
        const result = await scoreLead(lead);
        el.textContent = result;
      } catch (err) { el.textContent = `Error: ${err.message}`; }
    });

    const setupDraftBtn = (id, fn) => {
      document.getElementById(id)?.addEventListener("click", async () => {
        const out = document.getElementById("ai-draft-output");
        out.style.display = "block";
        out.textContent = "Generating...";
        try {
          const result = await fn(lead);
          out.textContent = result;
        } catch (err) { out.textContent = `Error: ${err.message}`; }
      });
    };
    setupDraftBtn("ai-tab-email", draftEmail);
    setupDraftBtn("ai-tab-sms", draftSMS);

  } else if (tab === "notes") {
    body.innerHTML = `
      <div class="drawer-section">
        <p class="kicker">Add Note</p>
        <form id="drawer-note-form" class="stack-form" style="margin-bottom:0;" novalidate>
          <label class="field"><textarea name="noteBody" rows="3" placeholder="Add a note..." required></textarea></label>
          <button class="btn btn-primary btn-sm" type="submit">Add Note</button>
          <p id="drawer-note-msg" class="form-message" aria-live="polite"></p>
        </form>
      </div>
      <div class="drawer-section">
        <p class="kicker">Notes (${notes.length})</p>
        <div class="admin-stack">
          ${notes.length ? notes.map((n) => `
            <div class="list-item">
              <p style="margin:0;font-size:0.88rem;">${n.body}</p>
              <span style="font-size:0.75rem;color:var(--muted);">${formatDate(n.created_at)}</span>
            </div>
          `).join("") : `<p style="color:var(--muted);font-size:0.85rem;">No notes yet.</p>`}
        </div>
      </div>
    `;
    document.getElementById("drawer-note-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = document.getElementById("drawer-note-msg");
      const noteBody = e.target.noteBody.value.trim();
      if (!noteBody) return;
      setMessage(msg, "Saving...");
      try {
        await addLeadNote({ leadId: openLeadId, body: noteBody });
        setMessage(msg, "Note added!", "success");
        e.target.reset();
        const newDetail = await getLeadDetail(openLeadId);
        await renderDrawerTab("notes", newDetail);
      } catch (err) {
        setMessage(msg, err.message, "error");
      }
    });

  } else if (tab === "tasks") {
    body.innerHTML = `
      <div class="drawer-section">
        <p class="kicker">Add Task</p>
        <form id="drawer-task-form" class="stack-form" style="margin-bottom:0;" novalidate>
          <div class="input-row">
            <label class="field"><input name="title" type="text" placeholder="Task title..." required></label>
            <label class="field"><input name="dueDate" type="date"></label>
          </div>
          <button class="btn btn-primary btn-sm" type="submit">Create Task</button>
          <p id="drawer-task-msg" class="form-message" aria-live="polite"></p>
        </form>
      </div>
      <div class="drawer-section">
        <p class="kicker">Tasks (${tasks.length})</p>
        <div class="admin-stack">
          ${tasks.length ? tasks.map((t) => `
            <div class="list-item crm-list-item" style="display:flex;align-items:center;justify-content:space-between;">
              <div>
                <strong style="font-size:0.88rem;">${t.title}</strong>
                <span style="color:var(--muted);font-size:0.75rem;display:block;">Due ${formatDate(t.due_date)} · ${t.status || "open"}</span>
              </div>
              ${t.status !== "completed" ? `<button class="btn btn-success btn-xs" data-complete-task-drawer="${t.id}">Done</button>` : `<span class="status-pill status-pill-green" style="font-size:0.72rem;">Done</span>`}
            </div>
          `).join("") : `<p style="color:var(--muted);font-size:0.85rem;">No tasks yet.</p>`}
        </div>
      </div>
    `;
    document.getElementById("drawer-task-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = document.getElementById("drawer-task-msg");
      const title = e.target.title.value.trim();
      const dueDate = e.target.dueDate.value;
      if (!title) return;
      setMessage(msg, "Creating...");
      try {
        await createTask({ leadId: openLeadId, title, dueDate });
        setMessage(msg, "Task created!", "success");
        e.target.reset();
        const newDetail = await getLeadDetail(openLeadId);
        await renderDrawerTab("tasks", newDetail);
      } catch (err) { setMessage(msg, err.message, "error"); }
    });
    document.querySelectorAll("[data-complete-task-drawer]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await completeTask(btn.dataset.completeTaskDrawer);
        const newDetail = await getLeadDetail(openLeadId);
        await renderDrawerTab("tasks", newDetail);
      });
    });

  } else if (tab === "timeline") {
    body.innerHTML = `
      <div class="drawer-section">
        <p class="kicker">Activity Timeline</p>
        <div class="activity-feed">
          ${renderActivityItems(activityEvents)}
        </div>
      </div>
    `;
  }
}

function closeDrawer() {
  document.getElementById("lead-drawer")?.classList.remove("is-open");
  document.getElementById("drawer-overlay")?.classList.remove("is-visible");
  document.body.style.overflow = "";
  openLeadId = null;
}

// ── AI RESULT MODAL ───────────────────────────────────────────────────────────
function showAIResultModal(title, content) {
  const existing = document.getElementById("ai-result-modal");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.id = "ai-result-modal";
  el.className = "modal-overlay";
  el.style.zIndex = "9999";
  el.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="drawer-close" onclick="document.getElementById('ai-result-modal').remove()">✕</button>
      </div>
      <div style="padding:0 4px;">
        <textarea class="field input" rows="10" style="width:100%;font-size:0.85rem;line-height:1.6;resize:vertical;" readonly>${content}</textarea>
        <div class="flex-gap" style="justify-content:flex-end;margin-top:12px;">
          <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText(${JSON.stringify(content)}).then(()=>this.textContent='Copied!')">Copy</button>
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('ai-result-modal').remove()">Close</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(el);
}

// ── MODALS ────────────────────────────────────────────────────────────────────
function bindModals() {
  // New lead buttons
  ["new-lead-btn", "new-lead-btn-leads", "new-lead-btn-pipeline"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", () => openLeadForm());
  });

  // Lead modal close/cancel
  document.getElementById("lead-modal-close")?.addEventListener("click", () => closeModal("lead-modal"));
  document.getElementById("lead-modal-cancel")?.addEventListener("click", () => closeModal("lead-modal"));
  document.getElementById("lead-modal")?.addEventListener("click", (e) => { if (e.target.id === "lead-modal") closeModal("lead-modal"); });

  // Lead form submit
  document.getElementById("lead-form")?.addEventListener("submit", handleLeadFormSubmit);

  // Task modal
  document.getElementById("new-task-modal-btn")?.addEventListener("click", () => openModal("task-modal"));
  document.getElementById("task-modal-close")?.addEventListener("click", () => closeModal("task-modal"));
  document.getElementById("task-modal-cancel")?.addEventListener("click", () => closeModal("task-modal"));
  document.getElementById("task-modal")?.addEventListener("click", (e) => { if (e.target.id === "task-modal") closeModal("task-modal"); });
  document.getElementById("task-modal-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("task-modal-message");
    const title = e.target.title.value.trim();
    const contactId = document.getElementById("taskContactId")?.value || null;
    const dueDate = e.target.due_date.value;
    const priority = e.target.priority.value;
    if (!title) return;
    setMessage(msg, "Creating...");
    try {
      await createTask({ leadId: null, contactId: contactId, title, dueDate, priority });
      setMessage(msg, "Task created!", "success");
      e.target.reset();
      if (typeof clearTaskContact === "function") clearTaskContact();
      allTasks = await getAllTasks();
      if (activeTab === "tasks") renderAllTasksTable(allTasks);
      setTimeout(() => closeModal("task-modal"), 800);
    } catch (err) { setMessage(msg, err.message, "error"); }
  });

  // Appointment modal
  document.getElementById("new-appointment-btn")?.addEventListener("click", () => openModal("appointment-modal"));
  document.getElementById("modal-close-btn")?.addEventListener("click", () => closeModal("appointment-modal"));
  document.getElementById("modal-cancel-btn")?.addEventListener("click", () => closeModal("appointment-modal"));
  document.getElementById("appointment-modal")?.addEventListener("click", (e) => { if (e.target.id === "appointment-modal") closeModal("appointment-modal"); });
  document.getElementById("appointment-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("appointment-message");
    const fd = new FormData(e.target);
    setMessage(msg, "Saving...");
    try {
      const contactId = document.getElementById("appointmentContactId")?.value || null;
      await createAppointment({
        title: fd.get("title"),
        type: fd.get("type"),
        date: fd.get("date"),
        time: fd.get("time"),
        leadId: null,
        contactId: contactId,
        notes: fd.get("notes")
      });
      setMessage(msg, "Appointment saved!", "success");
      allAppointments = await getAppointments();
      e.target.reset();
      if (typeof clearAppointmentContact === "function") clearAppointmentContact();
      if (activeTab === "calendar") renderCalendar();
      setTimeout(() => closeModal("appointment-modal"), 800);
    } catch (err) { setMessage(msg, err.message, "error"); }
  });
}

// ── DAY VIEW POPUP ───────────────────────────────────────────────────────────

let _dayViewDate = null;

async function openDayView(dateStr) {
  _dayViewDate = dateStr;

  const modal = document.getElementById("dayViewModal");
  const list = document.getElementById("dayViewList");
  const title = document.getElementById("dayViewTitle");
  const count = document.getElementById("dayViewCount");

  const d = new Date(dateStr + "T00:00:00");
  const options = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
  title.textContent = d.toLocaleDateString("en-US", options);

  list.innerHTML = '<div style="text-align:center; padding:32px; color:rgba(255,255,255,0.3); font-family:sans-serif; font-size:14px;">Loading appointments...</div>';
  modal.style.display = "flex";
  document.body.style.overflow = "hidden";

  try {
    const { supabase } = await import("/api/supabase-client.js");
    const startOfDay = dateStr + "T00:00:00.000Z";
    const endOfDay = dateStr + "T23:59:59.999Z";

    const { data: appointments, error } = await supabase
      .from("appointments")
      .select("*, contacts(first_name, last_name, phone, email)")
      .gte("scheduled_at", startOfDay)
      .lte("scheduled_at", endOfDay)
      .order("scheduled_at", { ascending: true });

    if (error) throw error;

    if (!appointments || appointments.length === 0) {
      count.textContent = "No appointments scheduled";
      list.innerHTML = `
        <div style="text-align:center; padding:40px 20px;">
          <div style="font-size:40px; margin-bottom:12px;">📅</div>
          <p style="color:rgba(255,255,255,0.4); font-size:14px; font-family:sans-serif;">No appointments for this day yet.</p>
          <p style="color:rgba(255,255,255,0.25); font-size:13px; font-family:sans-serif; margin-top:4px;">Click the button below to add one.</p>
        </div>`;
      return;
    }

    count.textContent = appointments.length + " appointment" + (appointments.length !== 1 ? "s" : "");

    list.innerHTML = appointments.map(apt => {
      const time = apt.scheduled_at
        ? new Date(apt.scheduled_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
        : "All day";

      const clientName = apt.contacts
        ? ((apt.contacts.first_name || "") + " " + (apt.contacts.last_name || "")).trim()
        : (apt.attendee_name || "");

      const clientPhone = apt.contacts?.phone || apt.attendee_phone || "";
      const clientEmail = apt.contacts?.email || apt.attendee_email || "";

      const typeColors = {
        "appointment": "#c9a84c",
        "showing": "#64b5f6",
        "call": "#81c784",
        "follow-up": "#ffb74d",
        "milestone": "#ce93d8"
      };
      const typeColor = typeColors[apt.type] || "#c9a84c";

      return `
        <div style="
          background:rgba(255,255,255,0.04);
          border:1px solid rgba(255,255,255,0.08);
          border-left:3px solid ${typeColor};
          border-radius:10px; padding:16px; margin-bottom:12px;
          position:relative;">

          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
            <div style="flex:1;">
              <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                <span style="font-size:12px; font-weight:700; color:${typeColor};
                  text-transform:uppercase; letter-spacing:0.5px; font-family:sans-serif;">
                  ${apt.type || "Appointment"}
                </span>
                <span style="font-size:13px; color:rgba(255,255,255,0.5); font-family:sans-serif;">
                  ${time}
                </span>
              </div>

              <div style="font-size:15px; font-weight:700; color:#fff;
                          font-family:Georgia,serif; margin-bottom:6px;">
                ${apt.title || (clientName ? "Meeting with " + clientName : "Appointment")}
              </div>

              ${clientName ? `
              <div style="font-size:13px; color:rgba(255,255,255,0.6); font-family:sans-serif; margin-bottom:4px;">
                👤 ${clientName}
              </div>` : ""}

              ${clientPhone ? `
              <div style="font-size:13px; color:rgba(255,255,255,0.5); font-family:sans-serif; margin-bottom:2px;">
                📞 <a href="tel:${clientPhone}" style="color:rgba(255,255,255,0.5); text-decoration:none;">${clientPhone}</a>
              </div>` : ""}

              ${clientEmail ? `
              <div style="font-size:13px; color:rgba(255,255,255,0.5); font-family:sans-serif; margin-bottom:2px;">
                ✉️ ${clientEmail}
              </div>` : ""}

              ${apt.notes ? `
              <div style="font-size:12px; color:rgba(255,255,255,0.35);
                          font-family:sans-serif; margin-top:8px;
                          padding-top:8px; border-top:1px solid rgba(255,255,255,0.06);">
                ${apt.notes}
              </div>` : ""}

              ${apt.meeting_url ? `
              <a href="${apt.meeting_url}" target="_blank" style="
                display:inline-block; margin-top:8px; padding:5px 12px;
                background:rgba(100,181,246,0.15); border:1px solid rgba(100,181,246,0.3);
                border-radius:6px; color:#64b5f6; font-size:12px;
                text-decoration:none; font-family:sans-serif;">
                🔗 Join Meeting
              </a>` : ""}
            </div>

            <div style="display:flex; flex-direction:column; gap:6px; flex-shrink:0;">
              ${apt.google_event_id ? `
              <span style="font-size:10px; color:#81c784; font-family:sans-serif;
                background:rgba(76,175,80,0.1); border:1px solid rgba(76,175,80,0.2);
                padding:3px 8px; border-radius:4px; white-space:nowrap;">
                📅 In Google Cal
              </span>` : `
              <button onclick="window._syncSingleAppointment('${apt.id}')" style="
                font-size:10px; color:rgba(255,255,255,0.4); font-family:sans-serif;
                background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1);
                padding:3px 8px; border-radius:4px; cursor:pointer; white-space:nowrap;">
                Sync to GCal
              </button>`}
            </div>
          </div>
        </div>`;
    }).join("");

  } catch (e) {
    console.error("Day view error:", e);
    list.innerHTML = '<div style="padding:20px; color:#ff7070; font-family:sans-serif; font-size:14px;">Error loading appointments: ' + e.message + '</div>';
  }
}

function closeDayView() {
  document.getElementById("dayViewModal").style.display = "none";
  document.body.style.overflow = "";
  _dayViewDate = null;
}
window.closeDayView = closeDayView;

function openNewAppointmentFromDay() {
  const savedDate = _dayViewDate;
  closeDayView();
  setTimeout(() => {
    const dateInput = document.querySelector("#appointment-form [name='date']");
    if (dateInput && savedDate) dateInput.value = savedDate;
    openModal("appointment-modal");
  }, 100);
}
window.openNewAppointmentFromDay = openNewAppointmentFromDay;

window._syncSingleAppointment = async function(appointmentId) {
  try {
    const res = await fetch(
      "https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/google-calendar-sync",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appointment_id: appointmentId })
      }
    );
    const result = await res.json();
    if (result.success && _dayViewDate) {
      openDayView(_dayViewDate);
    }
  } catch (e) {
    console.error("Sync error:", e);
  }
};

document.getElementById("dayViewModal")?.addEventListener("click", function(e) {
  if (e.target === this) closeDayView();
});

function openModal(id) {
  document.getElementById(id)?.classList.add("is-open");
  document.body.style.overflow = "hidden";
}

function closeModal(id) {
  document.getElementById(id)?.classList.remove("is-open");
  document.body.style.overflow = "";
}

function openLeadForm() {
  document.getElementById("lead-modal-title").textContent = "New Lead";
  document.getElementById("lead-form-id").value = "";
  document.getElementById("lead-form")?.reset();
  document.getElementById("lead-form-message").textContent = "";
  // Clear any previous validation state
  ["field-first-name", "field-last-name", "field-email"].forEach((id) => {
    document.getElementById(id)?.classList.remove("is-invalid");
  });
  openModal("lead-modal");
  // Clear validation on input
  ["first_name", "last_name", "email"].forEach((name) => {
    const input = document.querySelector(`#lead-form [name="${name}"]`);
    if (input && !input.dataset.validationBound) {
      input.dataset.validationBound = "1";
      input.addEventListener("input", () => {
        input.closest(".field")?.classList.remove("is-invalid");
      });
    }
  });
}

async function openLeadFormForEdit(leadId) {
  document.getElementById("lead-modal-title").textContent = "Edit Lead";
  document.getElementById("lead-form-id").value = leadId;
  document.getElementById("lead-form-message").textContent = "";
  openModal("lead-modal");
  try {
    const detail = await getLeadDetail(leadId);
    const lead = detail.lead;
    const c = lead.contacts || {};
    const form = document.getElementById("lead-form");
    if (!form) return;
    // Fill contact fields
    ["first_name","last_name","email","phone","secondary_phone","date_of_birth","address","city","state","zip","credit_score","employer_name","job_title","employment_type","monthly_income"].forEach((field) => {
      if (form.elements[field]) form.elements[field].value = c[field] || "";
    });
    // Fill lead fields
    ["loan_type","timeline","property_type","occupancy_type","purchase_price","down_payment","loan_amount","current_interest_rate","current_lender","source"].forEach((field) => {
      if (form.elements[field]) form.elements[field].value = lead[field] || "";
    });
  } catch (_) {}
}

function validateLeadForm(fd) {
  // Clear previous errors
  ["field-first-name", "field-last-name", "field-email"].forEach((id) => {
    document.getElementById(id)?.classList.remove("is-invalid");
  });

  let valid = true;
  const firstName = (fd.get("first_name") || "").trim();
  const lastName = (fd.get("last_name") || "").trim();
  const email = (fd.get("email") || "").trim();

  if (!firstName) {
    document.getElementById("field-first-name")?.classList.add("is-invalid");
    valid = false;
  }
  if (!lastName) {
    document.getElementById("field-last-name")?.classList.add("is-invalid");
    valid = false;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById("field-email")?.classList.add("is-invalid");
    valid = false;
  }
  return valid;
}

async function handleLeadFormSubmit(e) {
  e.preventDefault();
  const msg = document.getElementById("lead-form-message");
  const submitBtn = document.getElementById("lead-form-submit");
  const submitText = document.getElementById("lead-form-submit-text");
  const fd = new FormData(e.target);
  const existingLeadId = fd.get("lead_id");

  // Validate required fields
  if (!validateLeadForm(fd)) {
    setMessage(msg, "Please fill in all required fields.", "error");
    return;
  }

  // Clear validation
  ["field-first-name", "field-last-name", "field-email"].forEach((id) => {
    document.getElementById(id)?.classList.remove("is-invalid");
  });

  submitBtn.disabled = true;
  if (submitText) submitText.textContent = "Saving…";
  setMessage(msg, "");

  const contactPayload = {
    first_name: fd.get("first_name").trim(),
    last_name: fd.get("last_name").trim(),
    email: fd.get("email").trim(),
    phone: fd.get("phone") || null,
    secondary_phone: fd.get("secondary_phone") || null,
    date_of_birth: fd.get("date_of_birth") || null,
    address: fd.get("address") || null,
    city: fd.get("city") || null,
    state: fd.get("state") || null,
    zip: fd.get("zip") || null,
    credit_score: fd.get("credit_score") ? parseInt(fd.get("credit_score")) : null,
    employer_name: fd.get("employer_name") || null,
    job_title: fd.get("job_title") || null,
    employment_type: fd.get("employment_type") || null,
    monthly_income: fd.get("monthly_income") ? parseFloat(fd.get("monthly_income")) : null
  };

  const leadPayload = {
    loan_type: fd.get("loan_type") || null,
    timeline: fd.get("timeline") || null,
    property_type: fd.get("property_type") || null,
    occupancy_type: fd.get("occupancy_type") || null,
    purchase_price: fd.get("purchase_price") ? parseFloat(fd.get("purchase_price")) : null,
    down_payment: fd.get("down_payment") ? parseFloat(fd.get("down_payment")) : null,
    loan_amount: fd.get("loan_amount") ? parseFloat(fd.get("loan_amount")) : null,
    source: fd.get("source") || "website",
    notes: fd.get("notes") || null
  };

  // Calculate initial score
  const { score, tier } = calculateLeadScore(leadPayload, contactPayload);
  leadPayload.score = score;
  leadPayload.score_tier = tier;

  try {
    if (existingLeadId) {
      await updateLead(existingLeadId, leadPayload);
    } else {
      await createLead(contactPayload, leadPayload);
    }
    e.target.reset();
    closeModal("lead-modal");
    await loadAll();
    // Show toast via global helper or inline
    const toastEl = document.createElement("div");
    toastEl.textContent = existingLeadId ? "✓ Lead updated successfully!" : "✓ Lead saved successfully!";
    toastEl.style.cssText = "position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:rgba(30,30,30,0.98);border:1px solid rgba(201,168,76,0.35);color:#f2cf85;padding:10px 22px;border-radius:999px;font-size:0.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,0.4);";
    document.body.appendChild(toastEl);
    setTimeout(() => toastEl.remove(), 3000);
  } catch (err) {
    setMessage(msg, "Error: " + err.message, "error");
  } finally {
    submitBtn.disabled = false;
    if (submitText) submitText.textContent = "Save Lead";
  }
}

function populateLoanTypeSelect() {
  const select = document.getElementById("loan-type-select");
  if (!select || !loanTypeGroups) return;
  select.innerHTML = `<option value="">Select loan type...</option>`;
  Object.entries(loanTypeGroups).forEach(([category, types]) => {
    const group = document.createElement("optgroup");
    group.label = category;
    types.forEach((lt) => {
      const option = document.createElement("option");
      option.value = lt.name;
      option.textContent = lt.name;
      group.appendChild(option);
    });
    select.appendChild(group);
  });
}

// ── AI CHAT BUBBLE ────────────────────────────────────────────────────────────
function bindAIChat() {
  const toggle = document.getElementById("ai-chat-toggle");
  const panel = document.getElementById("ai-chat-panel");
  const closeBtn = document.getElementById("ai-chat-close");
  const sendBtn = document.getElementById("ai-chat-send");
  const input = document.getElementById("ai-chat-input");
  const messages = document.getElementById("ai-chat-messages");

  toggle?.addEventListener("click", () => {
    panel?.classList.toggle("is-open");
    if (panel?.classList.contains("is-open")) input?.focus();
  });
  closeBtn?.addEventListener("click", () => panel?.classList.remove("is-open"));

  const sendMessage = async () => {
    const text = input?.value.trim();
    if (!text) return;
    if (input) input.value = "";

    // Add user message
    messages.insertAdjacentHTML("beforeend", `
      <div class="ai-chat-msg user-msg">
        <div class="ai-chat-bubble-msg">${escHtml(text)}</div>
      </div>
    `);
    messages.scrollTop = messages.scrollHeight;

    // Add loading
    const loadId = "ai-load-" + Date.now();
    messages.insertAdjacentHTML("beforeend", `
      <div class="ai-chat-msg ai-msg" id="${loadId}">
        <div class="ai-chat-bubble-msg ai-thinking">Thinking...</div>
      </div>
    `);
    messages.scrollTop = messages.scrollHeight;

    try {
      const context = dashboardData ? {
        totalLeads: dashboardData.leads.length,
        recentLeads: dashboardData.leads.slice(0, 5).map((l) => ({ name: `${l.contacts?.first_name || ""} ${l.contacts?.last_name || ""}`, status: l.status, loan_type: l.loan_type }))
      } : {};
      const response = await chatWithAI(text, context);
      document.getElementById(loadId).querySelector(".ai-chat-bubble-msg").textContent = response;
    } catch (err) {
      document.getElementById(loadId).querySelector(".ai-chat-bubble-msg").textContent = `Error: ${err.message}`;
    }
    messages.scrollTop = messages.scrollHeight;
  };

  sendBtn?.addEventListener("click", sendMessage);
  input?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
}

// ── UTILITY ───────────────────────────────────────────────────────────────────
function bindLeadRowClicks(selector) {
  const container = typeof selector === "string" ? document.querySelector(selector) : selector;
  if (!container) return;
  container.querySelectorAll(".lead-row[data-lead-id]").forEach((row) => {
    row.style.cursor = "pointer";
    row.addEventListener("click", (e) => {
      if (e.target.closest(".lead-name-link")) return; // let the link navigate
      openLeadDrawer(row.dataset.leadId);
    });
  });
}

function statusPillClass(status) {
  const map = {
    new: "status-pill-blue",
    contacted: "status-pill-yellow",
    prequalified: "status-pill-orange",
    preapproved: "status-pill-orange",
    in_process: "status-pill-purple",
    in_escrow: "status-pill-purple",
    closed: "status-pill-green",
    lost: "status-pill-red",
    draft: "",
    submitted: "status-pill-blue",
    approved: "status-pill-green",
    denied: "status-pill-red"
  };
  return map[status] || "";
}

function statusOptions(current) {
  const stages = ["new", "contacted", "prequalified", "preapproved", "in_process", "in_escrow", "closed", "lost"];
  return stages.map((s) => `<option value="${s}" ${s === current ? "selected" : ""}>${s.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}</option>`).join("");
}

function scoreCard(score) {
  const s = score || 0;
  let cls = "score-badge score-red";
  if (s >= 71) cls = "score-badge score-green";
  else if (s >= 41) cls = "score-badge score-yellow";
  return `
    <div class="score-card">
      <div class="${cls}">${s}</div>
      <span style="font-size:0.72rem;color:var(--muted);margin-top:4px;">Lead Score</span>
    </div>
  `;
}

function scoreBadge(score, tier) {
  const s = score || 0;
  if (s === 0 && !tier) return `<span class="score-badge-sm score-grey">—</span>`;
  const t = tier || (s >= 80 ? "hot" : s >= 50 ? "warm" : "cold");
  const tierMap = {
    hot:  { cls: "score-tier-hot",  emoji: "🔴" },
    warm: { cls: "score-tier-warm", emoji: "🟡" },
    cold: { cls: "score-tier-cold", emoji: "🔵" }
  };
  const { cls, emoji } = tierMap[t] || tierMap.cold;
  return `<span class="score-tier-badge-sm ${cls}" title="${t.toUpperCase()}">${emoji} ${s}</span>`;
}

function scoreBadgeClass(score) {
  if (!score) return "";
  if (score >= 740) return "score-badge score-green";
  if (score >= 680) return "score-badge score-yellow";
  return "score-badge score-red";
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
