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
  if (_cachedSupabaseConfig && _cachedSupabaseConfig.key) return _cachedSupabaseConfig;
  _cachedSupabaseConfig = {
    url: window.APP_CONFIG?.SUPABASE_URL || 'https://ljywhvbmsibwnssxpesh.supabase.co',
    key: window.APP_CONFIG?.SUPABASE_ANON_KEY
  };
  return _cachedSupabaseConfig;
}

import { requireAdmin } from "/api/auth-api.js";
import {
  addLeadNote, calculateLeadScore, completeTask, createAppointment, createLead, createTask,
  getActivityFeed, getAdminDashboardData, getAnalyticsData,
  getAppointments, getCommunications, getLeadDetail, getLoanTypes,
  updateLead, updateLeadStage, updateLeadStatus, updateLeadScore, getAllTasks
} from "/api/admin-api-v2.js";
import { summarizeLead, draftEmail, draftSMS, chatWithAI } from "/api/ai-api.js";
import { currency, formatDate, renderEmptyState, setMessage } from "/components/ui.js";

// ── STATE ─────────────────────────────────────────────────────────────────────
let dashboardData = null;
let activeTab = "overview";
let openLeadId = null;
let calendarDate = new Date();
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
    window.location.href = "/public/unified-portal.html";
  });
}

function navigateTo(tabKey) {
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

// ── TASKS TABLE ───────────────────────────────────────────────────────────────
function renderAllTasksTable(tasks) {
  const tbody = document.getElementById("tasks-tbody");
  if (!tbody) return;

  const now = new Date();

  const renderRows = (list) => {
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--muted);">No tasks.</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map((task) => {
      const c = task.contacts || {};
      const leadName = c.first_name ? `${c.first_name} ${c.last_name || ""}` : (task.related_id ? `Lead ${task.related_id.substring(0, 8)}` : "—");
      const isOverdue = task.due_date && new Date(task.due_date) < now && task.status !== "completed";
      const priorityClass = { high: "status-pill-orange", urgent: "status-pill-red", normal: "" }[task.priority || "normal"] || "";
      return `
        <tr>
          <td><strong style="font-size:0.9rem;">${task.title || "Task"}</strong></td>
          <td style="font-size:0.82rem;color:var(--muted);">${leadName}</td>
          <td><span class="status-pill ${priorityClass}" style="font-size:0.75rem;">${task.priority || "normal"}</span></td>
          <td style="font-size:0.82rem;${isOverdue ? "color:var(--red);" : "color:var(--muted);"}">${task.due_date ? formatDate(task.due_date) : "—"}${isOverdue ? " ⚠" : ""}</td>
          <td><span class="status-pill ${task.status === "completed" ? "status-pill-green" : isOverdue ? "status-pill-red" : ""}">${task.status || "open"}</span></td>
          <td>
            ${task.status !== "completed" ? `<button class="btn btn-success btn-xs" data-complete-task="${task.id}">Done</button>` : ""}
          </td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll("[data-complete-task]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await completeTask(btn.dataset.completeTask);
        allTasks = await getAllTasks();
        renderAllTasksTable(allTasks);
      });
    });
  };

  // Filter
  document.querySelectorAll("[data-task-filter]").forEach((chip) => {
    if (chip.dataset.taskFilterBound) return;
    chip.dataset.taskFilterBound = "1";
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-task-filter]").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      const filter = chip.dataset.taskFilter;
      let filtered = tasks;
      if (filter === "open") filtered = tasks.filter((t) => t.status === "open" || t.status === null);
      else if (filter === "in_progress") filtered = tasks.filter((t) => t.status === "in_progress");
      else if (filter === "completed") filtered = tasks.filter((t) => t.status === "completed");
      else if (filter === "overdue") filtered = tasks.filter((t) => t.due_date && new Date(t.due_date) < now && t.status !== "completed");
      renderRows(filtered);
    });
  });

  // Default: show open tasks
  renderRows(tasks.filter((t) => !t.status || t.status === "open" || t.status === "in_progress"));
}

// ── CALENDAR ─────────────────────────────────────────────────────────────────
function renderCalendar() {
  const root = document.getElementById("calendar-root");
  if (!root) return;
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const monthName = calendarDate.toLocaleString("default", { month: "long" });
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const todayStr = new Date().toISOString().split("T")[0];
  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const cells = [];
  for (let i = firstDay - 1; i >= 0; i--) cells.push({ day: daysInPrevMonth - i, month: month - 1, year, other: true });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, month, year, other: false });
  const remaining = 42 - cells.length;
  for (let d = 1; d <= remaining; d++) cells.push({ day: d, month: month + 1, year, other: true });

  const gridHTML = cells.map((cell) => {
    const dateStr = `${cell.year}-${String(cell.month + 1).padStart(2, "0")}-${String(cell.day).padStart(2, "0")}`;
    const isToday = dateStr === todayStr;
    const dayAppts = allAppointments.filter((a) => (a.scheduled_at || "").startsWith(dateStr));
    const eventChips = dayAppts.slice(0, 3).map((a) => `<div class="calendar-event-chip type-${a.type || "appointment"}" title="${a.title}">${a.title}</div>`).join("");
    return `
      <div class="calendar-cell ${isToday ? "today" : ""} ${cell.other ? "other-month" : ""}" data-date="${dateStr}">
        <span class="cell-date">${cell.day}</span>
        ${eventChips}
        ${dayAppts.length > 3 ? `<div style="font-size:0.68rem;color:var(--muted);">+${dayAppts.length - 3} more</div>` : ""}
      </div>
    `;
  }).join("");

  root.innerHTML = `
    <div class="calendar-header">
      <div class="calendar-nav">
        <button class="btn btn-ghost btn-icon" id="cal-prev">‹</button>
        <span class="calendar-month-label">${monthName} ${year}</span>
        <button class="btn btn-ghost btn-icon" id="cal-next">›</button>
        <button class="btn btn-secondary btn-sm" id="cal-today">Today</button>
      </div>
    </div>
    <div class="calendar-grid">
      ${dayLabels.map((d) => `<div class="calendar-day-label">${d}</div>`).join("")}
      ${gridHTML}
    </div>
    <div id="upcoming-appointments" style="margin-top:20px;"></div>
  `;

  document.getElementById("cal-prev")?.addEventListener("click", () => { calendarDate = new Date(year, month - 1, 1); renderCalendar(); });
  document.getElementById("cal-next")?.addEventListener("click", () => { calendarDate = new Date(year, month + 1, 1); renderCalendar(); });
  document.getElementById("cal-today")?.addEventListener("click", () => { calendarDate = new Date(); renderCalendar(); });
  root.querySelectorAll(".calendar-cell").forEach((cell) => {
    cell.addEventListener("click", () => {
      openDayView(cell.dataset.date);
    });
  });

  renderUpcomingAppointmentsInEl(document.getElementById("upcoming-appointments"));
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
  return events.map((e) => {
    const m = iconMap[e.type] || { icon: "•", cls: "activity-dot" };
    return `
      <div class="activity-item">
        <div class="activity-dot ${m.cls}">${m.icon}</div>
        <div class="activity-content">
          <div class="activity-title">${e.description || e.type}</div>
          <div class="activity-time">${formatDate(e.created_at)}</div>
        </div>
      </div>
    `;
  }).join("");
}

// ── ANALYTICS ─────────────────────────────────────────────────────────────────
async function renderAnalytics() {
  const root = document.getElementById("analytics-root");
  if (!root || !dashboardData) return;
  const { leads, tasks, applications } = dashboardData;
  const data = await getAnalyticsData(leads, tasks, applications);

  root.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:24px;">
      <div class="metric-card metric-card-gold"><strong>${data.totalLeads}</strong><span>Total Leads</span></div>
      <div class="metric-card metric-card-green"><strong>${data.conversionRate}%</strong><span>Conversion Rate</span></div>
      <div class="metric-card"><strong>${data.hotLeads}</strong><span>Hot Leads (70+)</span></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
      <div class="panel chart-panel">
        <p class="kicker">Leads by Source</p>
        ${renderInlinePieChart(data.bySource)}
      </div>
      <div class="panel chart-panel">
        <p class="kicker">Pipeline Distribution</p>
        ${renderInlineBarChart(data.byStage, ["new","contacted","prequalified","preapproved","in_process","in_escrow","closed","lost"])}
      </div>
      <div class="panel chart-panel">
        <p class="kicker">Leads by Loan Type</p>
        ${renderInlineBarChart(data.byLoanType, Object.keys(data.byLoanType))}
      </div>
      <div class="panel chart-panel">
        <p class="kicker">Weekly Lead Volume (Last 30 Days)</p>
        ${renderWeeklyBar(data.weeklyLeads)}
      </div>
    </div>
  `;
}

function renderInlineBarChart(data, keys) {
  const entries = keys.map((k) => [k, data[k] || 0]).filter((e) => e[1] > 0);
  if (!entries.length) return `<p style="color:var(--muted);font-size:0.85rem;">No data yet</p>`;
  const max = Math.max(...entries.map((e) => e[1]), 1);
  return `<div class="bar-chart" style="height:100px;align-items:flex-end;">` +
    entries.map(([label, count]) => `
      <div class="bar-chart-col">
        <div style="height:${Math.round((count / max) * 100)}%;min-height:2px;" class="bar-fill" title="${label}: ${count}"></div>
        <div class="bar-label">${label.replace("_", " ").substring(0, 8)}</div>
        <div style="font-size:0.7rem;color:var(--muted-light);font-weight:700;">${count}</div>
      </div>
    `).join("") + `</div>`;
}

function renderInlinePieChart(data) {
  const entries = Object.entries(data).filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return `<p style="color:var(--muted);font-size:0.85rem;">No data yet</p>`;
  const total = entries.reduce((s, e) => s + e[1], 0);
  const colors = ["var(--gold)", "var(--blue)", "var(--green)", "#e8a87c", "#c084fc", "#f87171", "#34d399", "#60a5fa"];
  return `<div class="pie-legend">` +
    entries.map(([label, count], i) => `
      <div class="pie-legend-item">
        <span class="pie-dot" style="background:${colors[i % colors.length]};"></span>
        <span style="font-size:0.82rem;">${label}</span>
        <span style="margin-left:auto;font-weight:700;font-size:0.82rem;">${Math.round((count / total) * 100)}%</span>
      </div>
    `).join("") + `</div>`;
}

function renderWeeklyBar(weeklyLeads) {
  const labels = ["3 wks ago", "2 wks ago", "Last week", "This week"];
  const max = Math.max(...weeklyLeads, 1);
  return `<div class="bar-chart" style="height:100px;align-items:flex-end;">` +
    weeklyLeads.map((count, i) => `
      <div class="bar-chart-col">
        <div style="height:${Math.round((count / max) * 100)}%;min-height:2px;" class="bar-fill bar-fill-green"></div>
        <div class="bar-label">${labels[i]}</div>
        <div style="font-size:0.7rem;color:var(--muted-light);font-weight:700;">${count}</div>
      </div>
    `).join("") + `</div>`;
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
let _fvFilter = "";
let _fvExpanded = new Set();
let _fvFileCounts = {};
let _fvFiles = {};
let _fvViewerState = null; // { contactId, files, index, keyHandler }

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
  el.innerHTML = '<div style="grid-column:1/-1;padding:32px;text-align:center;color:var(--muted);font-size:.9rem;"><i class="fa-solid fa-spinner fa-spin" style="margin-right:8px;"></i>Loading borrowers…</div>';
  await _fvLoadContacts();
  _fvBindSearch();
  _fvRenderGrid();
  // Lazy-refresh file counts for contacts that already have folders
  _fvContacts.forEach((c) => {
    if (c.gdrive_folder_id && _fvFileCounts[c.gdrive_folder_id] == null) {
      _fvRefreshCount(c.id, c.gdrive_folder_id);
    }
  });
}

async function _fvLoadContacts() {
  const { url, key } = getSupabaseConfig();
  try {
    const res = await fetch(
      `${url}/rest/v1/contacts?select=id,first_name,last_name,email,pipeline_status,gdrive_folder_id,gdrive_folder_url&order=last_name.asc.nullslast`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
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
    _fvRenderGrid();
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

function _fvRenderGrid() {
  const el = document.getElementById("admin-document-table");
  if (!el) return;
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
    el.innerHTML = '<div style="grid-column:1/-1;padding:32px;text-align:center;color:var(--muted);font-size:.9rem;">No borrowers match your search.</div>';
    return;
  }
  el.innerHTML = list.map(_fvCardHtml).join("");
  el.querySelectorAll("[data-fv-action]").forEach((btn) => {
    btn.addEventListener("click", _fvHandleAction);
  });
  // Re-populate file lists for any expanded cards
  list.forEach((c) => {
    if (_fvExpanded.has(c.id) && c.gdrive_folder_id) _fvRenderFileList(c);
  });
}

function _fvCardHtml(c) {
  const name = `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Unnamed";
  const initials = _fvInitials(c);
  const pipeline = c.pipeline_status || "New Lead";
  const pipeColor = _fvPipelineColor(pipeline);
  const expanded = _fvExpanded.has(c.id);
  const hasFolder = !!c.gdrive_folder_id;
  const count = hasFolder ? (_fvFileCounts[c.gdrive_folder_id] ?? "…") : "";

  let footer;
  if (hasFolder) {
    footer = `
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button data-fv-action="toggle" data-id="${c.id}" style="flex:1;background:#1a1a1a;border:1px solid #333;color:#eee;border-radius:8px;padding:8px 12px;font-size:.78rem;font-weight:600;cursor:pointer;">
          <i class="fa-solid fa-folder-open" style="color:#C9A84C;margin-right:5px;"></i>${expanded ? "Hide Files" : "View Files"} (${count})
        </button>
        <a href="/admin/lead-detail.html?id=${c.id}" title="Open contact" style="background:#1a1a1a;border:1px solid #333;color:var(--muted);border-radius:8px;padding:8px 12px;font-size:.78rem;font-weight:600;text-decoration:none;">Lead →</a>
      </div>
      ${expanded ? `<div id="fv-files-${c.id}" style="margin-top:12px;border-top:1px solid #222;padding-top:12px;"></div>` : ""}
    `;
  } else {
    footer = `
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button data-fv-action="create" data-id="${c.id}" style="flex:1;background:#C9A84C;color:#111;border:none;border-radius:8px;padding:9px 14px;font-weight:700;font-size:.78rem;cursor:pointer;font-family:inherit;">
          <i class="fa-solid fa-folder-plus" style="margin-right:5px;"></i>Create Folder
        </button>
        <a href="/admin/lead-detail.html?id=${c.id}" style="background:#1a1a1a;border:1px solid #333;color:var(--muted);border-radius:8px;padding:9px 14px;font-size:.78rem;font-weight:600;text-decoration:none;">Lead →</a>
      </div>
    `;
  }

  return `
    <article class="crm-record-card" data-fv-card="${c.id}" style="padding:16px;">
      <div style="display:flex;gap:12px;align-items:flex-start;">
        <div style="flex-shrink:0;width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#C9A84C,#8c6e23);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.95rem;color:#111;">${initials}</div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;">
            <strong style="font-size:.95rem;color:#eee;">${name}</strong>
            <span style="background:${pipeColor}22;color:${pipeColor};border:1px solid ${pipeColor}55;padding:2px 8px;border-radius:10px;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">${pipeline}</span>
          </div>
          <div style="font-size:.76rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${c.email || "—"}</div>
        </div>
      </div>
      ${footer}
    </article>
  `;
}

async function _fvHandleAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.fvAction;
  const id = btn.dataset.id;
  const contact = _fvContacts.find((c) => String(c.id) === String(id));
  if (!contact) return;
  if (action === "create") return _fvCreateFolder(contact, btn);
  if (action === "toggle") return _fvToggleFiles(contact);
}

// Upload a File/Blob directly to Drive using the OAuth token (no proxy).
// Builds a multipart/related body by hand: JSON metadata + raw file bytes.
async function _fvUploadOne(folderId, file, nameOverride) {
  const fileName = nameOverride || file.name || "upload";
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

async function _fvUploadFiles(contact, files) {
  if (!contact.gdrive_folder_id) { _fvShowToast("No folder yet — create one first"); return; }
  if (!files || !files.length) return;

  const zone = document.getElementById(`fv-dropzone-${contact.id}`);
  const status = document.getElementById(`fv-upload-status-${contact.id}`);
  if (zone) { zone.dataset.fvBusy = "1"; zone.style.pointerEvents = "none"; zone.style.opacity = "0.75"; }

  // Seed status list with one row per file.
  const list = Array.from(files);
  const rowIds = list.map((_, i) => `fv-u-${contact.id}-${Date.now()}-${i}`);
  if (status) {
    status.innerHTML = list.map((f, i) => `
      <div id="${rowIds[i]}" style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04);border-radius:8px;margin-bottom:4px;font-size:.75rem;color:#eee;">
        <i class="fa-solid fa-spinner fa-spin" style="color:#C9A84C;"></i>
        <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Uploading ${(f.name || "file").replace(/</g, "&lt;")}…</span>
      </div>
    `).join("");
  }

  // Sequential upload — simpler error handling and easier on the Drive API.
  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < list.length; i++) {
    const result = await _fvUploadOne(contact.gdrive_folder_id, list[i]);
    const row = document.getElementById(rowIds[i]);
    if (row) {
      if (result.ok) {
        row.innerHTML = `
          <i class="fa-solid fa-check" style="color:#52C87A;"></i>
          <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#cfe7d7;">✓ ${(result.name || "file").replace(/</g, "&lt;")}</span>
        `;
      } else {
        row.innerHTML = `
          <i class="fa-solid fa-xmark" style="color:#E05252;"></i>
          <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#f0bdbd;" title="${(result.error || "").replace(/"/g, "&quot;")}">✗ ${(result.name || "file").replace(/</g, "&lt;")}</span>
        `;
      }
    }
    if (result.ok) okCount++;
    else {
      failCount++;
      console.error("[FileVault] upload failed:", result.name, result.error);
    }
  }

  _fvShowToast(failCount ? `${okCount} uploaded, ${failCount} failed` : `${okCount} uploaded ✓`);

  // Refresh folder contents + count pill, then re-render the file list (which
  // rebuilds the dropzone and clears the status rows).
  await _fvLoadFiles(contact.gdrive_folder_id);
  const card = document.querySelector(`[data-fv-card="${contact.id}"]`);
  const toggle = card?.querySelector('[data-fv-action="toggle"]');
  if (toggle) {
    const label = _fvExpanded.has(contact.id) ? "Hide Files" : "View Files";
    toggle.innerHTML = `<i class="fa-solid fa-folder-open" style="color:#C9A84C;margin-right:5px;"></i>${label} (${_fvFileCounts[contact.gdrive_folder_id] ?? 0})`;
  }
  _fvRenderFileList(contact);
}

function _fvBindDropzone(contact) {
  const zone = document.getElementById(`fv-dropzone-${contact.id}`);
  if (!zone || zone._fvBound) return;
  zone._fvBound = true;

  const baseBorder = "2px dashed #C9A84C";
  const activeBorder = "2px solid #C9A84C";
  const baseBg = "rgba(201,168,76,0.06)";
  const activeBg = "rgba(201,168,76,0.18)";

  zone.addEventListener("click", () => {
    if (zone.dataset.fvBusy) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const files = input.files;
      input.remove();
      if (files && files.length) _fvUploadFiles(contact, files);
    });
    document.body.appendChild(input);
    input.click();
  });

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (zone.dataset.fvBusy) return;
    zone.style.border = activeBorder;
    zone.style.background = activeBg;
  });
  zone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    zone.style.border = baseBorder;
    zone.style.background = baseBg;
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.style.border = baseBorder;
    zone.style.background = baseBg;
    if (zone.dataset.fvBusy) return;
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) _fvUploadFiles(contact, files);
  });
}

async function _fvCreateFolder(contact, btn) {
  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating…';
  try {
    const headers = await _fvAuthHeaders({ "Content-Type": "application/json" });
    const res = await fetch(
      "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink,parents",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: `${contact.first_name || ""} ${contact.last_name || ""}`.trim().toUpperCase() || "UNNAMED BORROWER",
          mimeType: "application/vnd.google-apps.folder",
          parents: [GDRIVE_BORROWERS_ROOT]
        })
      }
    );
    if (res.status === 401 || res.status === 403) _fvClearToken();
    const data = await res.json();
    if (!res.ok || !data.id) throw new Error((data.error && data.error.message) || "Folder create failed");
    const folderId = data.id;
    const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
    // PATCH contact
    const { url, key: sbKey } = getSupabaseConfig();
    const patch = await fetch(`${url}/rest/v1/contacts?id=eq.${encodeURIComponent(contact.id)}`, {
      method: "PATCH",
      headers: {
        apikey: sbKey,
        Authorization: `Bearer ${sbKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ gdrive_folder_id: folderId, gdrive_folder_url: folderUrl })
    });
    if (!patch.ok) throw new Error("Failed to save folder ID to contact");
    contact.gdrive_folder_id = folderId;
    contact.gdrive_folder_url = folderUrl;
    _fvFileCounts[folderId] = 0;
    _fvFiles[folderId] = [];
    _fvExpanded.add(contact.id);
    _fvRenderGrid();
    _fvShowToast("Folder created ✓");
  } catch (e) {
    console.error("[FileVault] create folder failed:", e);
    btn.disabled = false;
    btn.innerHTML = orig;
    _fvShowToast("Error: " + (e.message || "create failed"));
  }
}

async function _fvToggleFiles(contact) {
  const wasOpen = _fvExpanded.has(contact.id);
  if (wasOpen) _fvExpanded.delete(contact.id);
  else _fvExpanded.add(contact.id);
  _fvRenderGrid();
  if (!wasOpen && contact.gdrive_folder_id) {
    await _fvLoadFiles(contact.gdrive_folder_id);
    _fvRenderFileList(contact);
  }
}

async function _fvLoadFiles(folderId) {
  try {
    const headers = await _fvAuthHeaders();
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const fields = encodeURIComponent(
      "files(id,name,mimeType,webViewLink,webContentLink,size,createdTime,modifiedTime,iconLink,thumbnailLink,parents)"
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
  const card = document.querySelector(`[data-fv-card="${contactId}"]`);
  const toggle = card?.querySelector('[data-fv-action="toggle"]');
  if (toggle) {
    const label = _fvExpanded.has(contactId) ? "Hide Files" : "View Files";
    toggle.innerHTML = `<i class="fa-solid fa-folder-open" style="color:#C9A84C;margin-right:5px;"></i>${label} (${_fvFileCounts[folderId] ?? 0})`;
  }
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

function _fvRenderFileList(contact) {
  const host = document.getElementById(`fv-files-${contact.id}`);
  if (!host) return;
  const files = _fvFiles[contact.gdrive_folder_id] || [];
  const rows = files.length
    ? files.map((f, idx) => {
        const icon = _fvFileIcon(f.mimeType || "");
        const size = _fvFormatSize(f.size);
        const date = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : "";
        const nm = _fvEscape(f.name || "Untitled");
        const showConvert = !_fvIsPdf(f);
        return `
          <div class="fv-row" data-fv-row="${f.id}" data-fv-index="${idx}" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,0.02);margin-bottom:6px;color:#eee;border:1px solid rgba(255,255,255,0.04);transition:background .15s;" onmouseover="this.style.background='rgba(201,168,76,0.08)'" onmouseout="this.style.background='rgba(255,255,255,0.02)'">
            <i class="fa-solid ${icon}" style="color:#C9A84C;width:16px;text-align:center;flex-shrink:0;"></i>
            <div style="flex:1;min-width:0;">
              <div class="fv-name" data-fv-view="${f.id}" style="font-size:.82rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;">${nm}</div>
              <div style="font-size:.68rem;color:var(--muted);">${size}${date ? " · " + date : ""}</div>
            </div>
            <button type="button" data-fv-rename="${f.id}" title="Rename" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:4px 6px;font-size:.78rem;"><i class="fa-solid fa-pen"></i></button>
            ${showConvert ? `<button type="button" data-fv-topdf="${f.id}" title="Convert to PDF" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:4px 6px;font-size:.78rem;"><i class="fa-solid fa-file-pdf"></i></button>` : ""}
            <div style="position:relative;">
              <button type="button" data-fv-menu="${f.id}" title="More" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:4px 8px;font-size:.9rem;"><i class="fa-solid fa-ellipsis-vertical"></i></button>
              <div id="fv-menu-${f.id}" class="fv-menu" style="display:none;position:absolute;right:0;top:100%;margin-top:4px;background:#111;border:1px solid #2a2a2a;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.6);z-index:50;min-width:140px;overflow:hidden;">
                <a href="${_fvEscape(f.webContentLink || f.webViewLink || "#")}" ${f.webContentLink ? "" : 'target="_blank" rel="noopener"'} style="display:block;padding:9px 12px;color:#eee;text-decoration:none;font-size:.78rem;border-bottom:1px solid #222;"><i class="fa-solid fa-download" style="margin-right:6px;color:#C9A84C;"></i>Download</a>
                <button type="button" data-fv-delete="${f.id}" style="display:block;width:100%;text-align:left;background:none;border:none;padding:9px 12px;color:#f0bdbd;cursor:pointer;font-size:.78rem;font-family:inherit;"><i class="fa-solid fa-trash" style="margin-right:6px;"></i>Delete</button>
              </div>
            </div>
          </div>
        `;
      }).join("")
    : '<div style="padding:14px;text-align:center;color:var(--muted);font-size:.78rem;">No files yet.</div>';

  host.innerHTML = `
    <div class="fv-file-list" data-fv-list="${contact.id}">${rows}</div>
    <div id="fv-dropzone-${contact.id}" style="margin-top:12px;padding:18px 14px;border:2px dashed #C9A84C;background:rgba(201,168,76,0.06);border-radius:10px;text-align:center;cursor:pointer;transition:background .15s,border-color .15s;user-select:none;">
      <i class="fa-solid fa-cloud-arrow-up" style="color:#C9A84C;font-size:1.35rem;display:block;margin-bottom:6px;"></i>
      <div style="color:#eee;font-size:.82rem;font-weight:600;">Drop files here or click to browse</div>
      <div style="color:var(--muted);font-size:.68rem;margin-top:3px;">Multi-file upload to Google Drive</div>
    </div>
    <div id="fv-upload-status-${contact.id}" style="margin-top:8px;"></div>
    <div style="display:flex;gap:8px;margin-top:10px;">
      <a href="${contact.gdrive_folder_url}" target="_blank" rel="noopener" style="flex:1;text-align:center;background:#1a1a1a;border:1px solid #333;color:var(--muted);border-radius:8px;padding:8px 12px;font-size:.75rem;font-weight:600;text-decoration:none;">Open in Drive →</a>
    </div>
  `;
  _fvBindDropzone(contact);
  _fvBindRowActions(contact);
}

function _fvBindRowActions(contact) {
  const host = document.getElementById(`fv-files-${contact.id}`);
  if (!host) return;
  host.querySelectorAll("[data-fv-view]").forEach((el) => {
    el.addEventListener("click", () => {
      const fileId = el.dataset.fvView;
      const files = _fvFiles[contact.gdrive_folder_id] || [];
      const idx = files.findIndex((f) => f.id === fileId);
      if (idx >= 0) _fvOpenViewer(contact, files, idx);
    });
  });
  host.querySelectorAll("[data-fv-rename]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      _fvStartRename(contact, btn.dataset.fvRename);
    });
  });
  host.querySelectorAll("[data-fv-topdf]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      _fvConvertToPdf(contact, btn.dataset.fvTopdf, btn);
    });
  });
  host.querySelectorAll("[data-fv-menu]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.fvMenu;
      const menu = document.getElementById(`fv-menu-${id}`);
      if (!menu) return;
      // Close any other menus first
      host.querySelectorAll(".fv-menu").forEach((m) => { if (m !== menu) m.style.display = "none"; });
      menu.style.display = menu.style.display === "block" ? "none" : "block";
    });
  });
  host.querySelectorAll("[data-fv-delete]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      _fvDeleteFile(contact, btn.dataset.fvDelete);
    });
  });
  // Dismiss open menus on any outside click
  if (!host._fvMenuBound) {
    host._fvMenuBound = true;
    document.addEventListener("click", () => {
      host.querySelectorAll(".fv-menu").forEach((m) => { m.style.display = "none"; });
    });
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
    _fvRenderFileList(contact);
    const card = document.querySelector(`[data-fv-card="${contact.id}"]`);
    const toggle = card?.querySelector('[data-fv-action="toggle"]');
    if (toggle) {
      const label = _fvExpanded.has(contact.id) ? "Hide Files" : "View Files";
      toggle.innerHTML = `<i class="fa-solid fa-folder-open" style="color:#C9A84C;margin-right:5px;"></i>${label} (${_fvFileCounts[contact.gdrive_folder_id] ?? 0})`;
    }
  } catch (e) {
    console.error("[FileVault] delete failed:", e);
    _fvShowToast("Delete failed");
  }
}

// ── CONVERT TO PDF ────────────────────────────────────────────────
async function _fvConvertToPdf(contact, fileId, btn) {
  const files = _fvFiles[contact.gdrive_folder_id] || [];
  const file = files.find((f) => f.id === fileId);
  if (!file) return;
  console.log("[FileVault][convert] start", { name: file.name, mimeType: file.mimeType });
  if (_fvIsPdf(file)) { _fvShowToast("Already a PDF"); return; }
  // Only Google-native docs can be exported via the Drive export endpoint.
  // Other uploaded file types (docx, xlsx, jpg, png, etc) need to be converted
  // in the Drive UI — the API has no generic convert endpoint.
  if (!_fvIsGoogleDoc(file)) {
    _fvShowToast("Open this file in Google Drive, then File > Download as PDF");
    return;
  }
  const origHtml = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
  try {
    // Step 1: token
    const token = await _fvEnsureToken();
    console.log("[FileVault][convert] token acquired");

    // Step 2: export the Google-native doc as PDF bytes
    const exportUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=application/pdf`;
    const exportRes = await fetch(exportUrl, { headers: { Authorization: "Bearer " + token } });
    console.log("[FileVault][convert] export response status", exportRes.status);
    if (exportRes.status === 401 || exportRes.status === 403) _fvClearToken();
    if (!exportRes.ok) {
      const errText = await exportRes.text().catch(() => "");
      console.error("[FileVault][convert] export failed body:", errText);
      _fvShowToast(`Export failed: HTTP ${exportRes.status}`);
      if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
      return;
    }
    const blob = await exportRes.blob();
    console.log("[FileVault][convert] blob size/type", blob.size, blob.type);

    // Step 3: strip the existing extension and append .pdf
    const baseName = (file.name || "document").replace(/\.[a-zA-Z0-9]{1,6}$/, "");
    const pdfName = baseName + ".pdf";
    console.log("[FileVault][convert] upload filename", pdfName);

    // Step 4: upload the PDF blob back to the same folder via OAuth multipart
    const pdfFile = new File([blob], pdfName, { type: "application/pdf" });
    const result = await _fvUploadOne(contact.gdrive_folder_id, pdfFile);
    console.log("[FileVault][convert] upload result", result);
    if (!result.ok) {
      _fvShowToast("PDF upload failed: " + (result.error || "unknown"));
      if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
      return;
    }
    _fvShowToast("Converted to PDF ✓");
    await _fvLoadFiles(contact.gdrive_folder_id);
    _fvRenderFileList(contact);
  } catch (e) {
    console.error("[FileVault][convert] failed:", e);
    _fvShowToast("Convert failed: " + (e.message || "unknown"));
    if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
  }
}

// ── INLINE FILE VIEWER (right slide-in panel) ─────────────────────
function _fvOpenViewer(contact, files, index) {
  _fvCloseViewer(); // close any existing first
  _fvViewerState = { contactId: contact.id, files, index, keyHandler: null };

  // Inject spinner keyframes once (used by #fv-viewer-saving + any other CSS spinners in the vault).
  if (!document.getElementById("fv-spin-keyframes")) {
    const s = document.createElement("style");
    s.id = "fv-spin-keyframes";
    s.textContent = "@keyframes fvSpin{to{transform:rotate(360deg);}}";
    document.head.appendChild(s);
  }

  const overlay = document.createElement("div");
  overlay.id = "fv-viewer-overlay";
  overlay.style.cssText = "position:fixed;inset:0 480px 0 0;background:rgba(0,0,0,0.5);z-index:8000;";
  overlay.addEventListener("click", _fvCloseViewer);
  document.body.appendChild(overlay);

  const panel = document.createElement("div");
  panel.id = "fv-viewer-panel";
  panel.style.cssText = "position:fixed;top:0;right:0;width:480px;height:100vh;background:#1a1a1a;border-left:2px solid #C9A84C;z-index:8001;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .28s ease;box-shadow:-12px 0 40px rgba(0,0,0,0.6);";
  panel.innerHTML = `
    <div id="fv-viewer-header" style="padding:14px 16px;border-bottom:1px solid #2a2a2a;display:flex;align-items:center;gap:10px;flex-shrink:0;">
      <div id="fv-viewer-title-wrap" style="display:flex;align-items:center;min-width:0;gap:8px;flex:1;">
        <span id="fv-viewer-title" style="color:#C9A84C;font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;"></span>
        <button id="fv-viewer-rename" title="Rename" style="background:transparent;border:none;color:#C9A84C;cursor:pointer;padding:2px 4px;font-size:.9rem;flex-shrink:0;"><i class="fa-solid fa-pen"></i></button>
        <span id="fv-viewer-saving" style="display:none;width:14px;height:14px;border:2px solid #C9A84C;border-top-color:transparent;border-radius:50%;animation:fvSpin 0.7s linear infinite;flex-shrink:0;"></span>
      </div>
      <a id="fv-viewer-download" title="Download" style="background:#222;border:1px solid #333;color:#C9A84C;border-radius:6px;padding:6px 9px;font-size:.78rem;text-decoration:none;"><i class="fa-solid fa-download"></i></a>
      <a id="fv-viewer-openlink" title="Open in Drive" target="_blank" rel="noopener" style="background:#222;border:1px solid #333;color:#C9A84C;border-radius:6px;padding:6px 9px;font-size:.78rem;text-decoration:none;"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
      <button id="fv-viewer-close" title="Close" style="background:#222;border:1px solid #333;color:#eee;border-radius:6px;padding:6px 10px;font-size:.82rem;cursor:pointer;font-family:inherit;">✕</button>
    </div>
    <div id="fv-viewer-nav" style="padding:8px 16px;border-bottom:1px solid #222;display:flex;align-items:center;gap:8px;flex-shrink:0;">
      <button id="fv-viewer-prev" style="background:#1a1a1a;border:1px solid #333;color:#eee;border-radius:6px;padding:5px 10px;font-size:.75rem;cursor:pointer;font-family:inherit;">← Prev</button>
      <span id="fv-viewer-counter" style="flex:1;text-align:center;font-size:.72rem;color:var(--muted);"></span>
      <button id="fv-viewer-next" style="background:#1a1a1a;border:1px solid #333;color:#eee;border-radius:6px;padding:5px 10px;font-size:.75rem;cursor:pointer;font-family:inherit;">Next →</button>
    </div>
    <div id="fv-viewer-body" style="flex:1;overflow:auto;background:#0a0a0a;"></div>
  `;
  document.body.appendChild(panel);
  requestAnimationFrame(() => { panel.style.transform = "translateX(0)"; });

  document.getElementById("fv-viewer-close").addEventListener("click", _fvCloseViewer);
  document.getElementById("fv-viewer-prev").addEventListener("click", () => _fvViewerNav(-1));
  document.getElementById("fv-viewer-next").addEventListener("click", () => _fvViewerNav(1));
  document.getElementById("fv-viewer-rename").addEventListener("click", _fvStartRenameInViewer);

  const keyHandler = (e) => {
    if (e.key === "Escape") { _fvCloseViewer(); }
    else if (e.key === "ArrowLeft") { _fvViewerNav(-1); }
    else if (e.key === "ArrowRight") { _fvViewerNav(1); }
  };
  document.addEventListener("keydown", keyHandler);
  _fvViewerState.keyHandler = keyHandler;

  _fvViewerRender();
}

function _fvRevokeBlobUrl() {
  if (_fvViewerState && _fvViewerState.blobUrl) {
    try { URL.revokeObjectURL(_fvViewerState.blobUrl); } catch (_) {}
    _fvViewerState.blobUrl = null;
  }
}

function _fvCloseViewer() {
  const panel = document.getElementById("fv-viewer-panel");
  const overlay = document.getElementById("fv-viewer-overlay");
  if (_fvViewerState && _fvViewerState.keyHandler) {
    document.removeEventListener("keydown", _fvViewerState.keyHandler);
  }
  _fvRevokeBlobUrl();
  if (panel) {
    panel.style.transform = "translateX(100%)";
    setTimeout(() => panel.remove(), 280);
  }
  if (overlay) overlay.remove();
  _fvViewerState = null;
}

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
  const body = document.getElementById("fv-viewer-body");
  const dl = document.getElementById("fv-viewer-download");
  const openlink = document.getElementById("fv-viewer-openlink");
  if (!title || !body) return;

  title.textContent = f.name || "Untitled";
  title.title = f.name || "";
  counter.textContent = `${index + 1} of ${files.length}`;
  prev.disabled = index === 0;
  next.disabled = index === files.length - 1;
  prev.style.opacity = prev.disabled ? "0.4" : "1";
  next.style.opacity = next.disabled ? "0.4" : "1";

  if (dl) dl.href = f.webContentLink || f.webViewLink || "#";
  if (openlink) openlink.href = f.webViewLink || "#";

  // Capture the index we're rendering for — if the user navigates while a
  // fetch is in flight, we discard the stale result.
  const renderIndex = index;
  const mime = f.mimeType || "";
  const isPdf = _fvIsPdf(f);
  const isImage = mime.indexOf("image/") === 0;

  // Show a loading placeholder up front.
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:40px;gap:12px;">
      <span style="width:22px;height:22px;border:3px solid #C9A84C;border-top-color:transparent;border-radius:50%;animation:fvSpin 0.7s linear infinite;"></span>
      <div style="font-size:.78rem;color:var(--muted);">Loading preview…</div>
    </div>
  `;

  // PDF and image files: fetch the bytes via alt=media, render as blob URL.
  // Going through the Drive API with the OAuth token avoids Google's CSP
  // frame-ancestors header that blocks drive.google.com/file/d/.../preview.
  if (isPdf || isImage) {
    try {
      const token = await _fvEnsureToken();
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}?alt=media`,
        { headers: { Authorization: "Bearer " + token } }
      );
      if (res.status === 401 || res.status === 403) _fvClearToken();
      if (!res.ok) throw new Error("HTTP " + res.status);
      const blob = await res.blob();
      // Stale fetch guard — user may have navigated or closed the viewer.
      if (!_fvViewerState || _fvViewerState.index !== renderIndex) {
        try { URL.revokeObjectURL(URL.createObjectURL(blob)); } catch (_) {}
        return;
      }
      const blobUrl = URL.createObjectURL(blob);
      _fvViewerState.blobUrl = blobUrl;
      if (isPdf) {
        body.innerHTML = `<iframe src="${blobUrl}" style="width:100%;height:100%;border:0;background:#0a0a0a;"></iframe>`;
      } else {
        body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;padding:20px;min-height:100%;"><img src="${blobUrl}" style="max-width:100%;max-height:80vh;border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,0.6);" alt="${_fvEscape(f.name || '')}"></div>`;
      }
    } catch (e) {
      console.error("[FileVault][viewer] fetch failed:", e);
      if (!_fvViewerState || _fvViewerState.index !== renderIndex) return;
      body.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:40px;text-align:center;gap:12px;">
          <i class="fa-solid fa-triangle-exclamation" style="font-size:2rem;color:#E05252;"></i>
          <div style="font-size:.85rem;color:#eee;">Preview failed: ${_fvEscape(e.message || "network error")}</div>
          <a href="${_fvEscape(f.webViewLink || '#')}" target="_blank" rel="noopener" style="background:#C9A84C;color:#111;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:.82rem;text-decoration:none;margin-top:8px;">Open in Drive →</a>
        </div>
      `;
    }
    return;
  }

  // Google-native docs (Docs/Sheets/Slides/Drawings) and other file types
  // (docx, xlsx, etc.): use the Google Docs viewer proxy. This avoids the
  // drive.google.com CSP frame-ancestors block. Note: this only renders for
  // files whose download URL the proxy can fetch — fully private borrower
  // files may still fail, in which case the user can click "Open in Drive".
  const docsViewerUrl = "https://docs.google.com/viewer?embedded=true&url=" +
    encodeURIComponent(`https://drive.google.com/uc?export=download&id=${f.id}`);
  if (_fvIsGoogleDoc(f) || mime.indexOf("video/") === 0 || mime.indexOf("audio/") === 0 || mime) {
    body.innerHTML = `<iframe src="${_fvEscape(docsViewerUrl)}" style="width:100%;height:100%;border:0;background:#0a0a0a;" allow="autoplay"></iframe>`;
    return;
  }

  // Unknown / no mime: fallback card.
  const icon = _fvFileIcon(mime);
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:40px;text-align:center;gap:12px;">
      <i class="fa-solid ${icon}" style="font-size:3rem;color:#C9A84C;"></i>
      <div style="font-size:.95rem;font-weight:700;color:#eee;">${_fvEscape(f.name || "Untitled")}</div>
      <div style="font-size:.78rem;color:var(--muted);">Preview not available for this file type.</div>
      <a href="${_fvEscape(f.webViewLink || '#')}" target="_blank" rel="noopener" style="background:#C9A84C;color:#111;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:.82rem;text-decoration:none;margin-top:8px;">Open in Drive →</a>
    </div>
  `;
}

// Inline rename from inside the viewer header. Updates both the viewer title
// and the matching file row in the list on success.
function _fvStartRenameInViewer() {
  if (!_fvViewerState) return;
  const { files, index, contactId } = _fvViewerState;
  const file = files[index];
  if (!file) return;
  const titleSpan = document.getElementById("fv-viewer-title");
  const pencilBtn = document.getElementById("fv-viewer-rename");
  const saving = document.getElementById("fv-viewer-saving");
  if (!titleSpan || !pencilBtn) return;

  const currentName = file.name || "";
  const input = document.createElement("input");
  input.type = "text";
  input.id = "fv-viewer-rename-input";
  input.value = currentName;
  input.style.cssText = "background:transparent;border:1px solid #C9A84C;border-radius:4px;color:#C9A84C;font-size:14px;padding:2px 6px;min-width:180px;max-width:320px;font-family:inherit;outline:none;";
  titleSpan.replaceWith(input);
  pencilBtn.style.display = "none";
  input.focus();
  input.select();

  const restore = (name) => {
    const span = document.createElement("span");
    span.id = "fv-viewer-title";
    span.style.cssText = "color:#C9A84C;font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;";
    span.textContent = name;
    span.title = name;
    input.replaceWith(span);
    pencilBtn.style.display = "";
    if (saving) saving.style.display = "none";
  };

  const commit = async () => {
    if (input._fvDone) return;
    input._fvDone = true;
    const newName = input.value.trim();
    if (!newName || newName === currentName) { restore(currentName); return; }
    input.disabled = true;
    input.style.opacity = "0.6";
    if (saving) saving.style.display = "inline-block";
    try {
      const headers = await _fvAuthHeaders({ "Content-Type": "application/json" });
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?fields=id,name`,
        { method: "PATCH", headers, body: JSON.stringify({ name: newName }) }
      );
      if (res.status === 401 || res.status === 403) _fvClearToken();
      const data = await res.json();
      if (!res.ok || !data.id) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      // Update in-memory file model + viewer header + the row in the file list
      file.name = data.name;
      restore(data.name);
      const rowName = document.querySelector(`[data-fv-row="${file.id}"] .fv-name`);
      if (rowName) rowName.textContent = data.name;
      _fvShowToast("Renamed ✓");
    } catch (e) {
      console.error("[FileVault] rename (viewer) failed:", e);
      _fvShowToast("Rename failed");
      restore(currentName);
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); input._fvDone = true; restore(currentName); }
  });
  input.addEventListener("blur", commit);
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
