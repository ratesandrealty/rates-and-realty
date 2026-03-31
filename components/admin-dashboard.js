import { requireAdmin } from "/api/auth-api.js";
import {
  addLeadNote, calculateLeadScore, completeTask, createAppointment, createLead, createTask,
  getActivityFeed, getAdminDashboardData, getAnalyticsData,
  getAppointments, getCommunications, getLeadDetail, getLoanTypes,
  updateLead, updateLeadStage, updateLeadStatus, updateLeadScore, getAllTasks
} from "/api/admin-api.js";
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
    document.querySelector(".crm-main")?.insertAdjacentHTML("afterbegin", `
      <div class="panel" style="margin-bottom:24px;">
        <p class="kicker">Access Restricted</p>
        <h2>CRM access is limited to your internal team.</h2>
        <p style="color:var(--muted);">Add your email to <code>/api/env.js</code> ADMIN_EMAILS and sign in with that account.</p>
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
    console.error("Dashboard load error:", err);
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
    window.location.href = "/auth/index.html";
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
    case "pipeline": renderKanban(dashboardData.leads); break;
    case "contacts": renderContacts(dashboardData.contacts); break;
    case "calendar": renderCalendar(); break;
    case "tasks": renderAllTasksTable(allTasks); break;
    case "communications": renderCommunications(); break;
    case "activity": renderActivityFeed(); break;
    case "analytics": renderAnalytics(); break;
    case "applications": console.log('about to call renderApplications, data:', dashboardData.applications?.length); renderApplications(dashboardData.applications || []); break;
    case "documents": renderDocuments(dashboardData.documents); break;
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
    const stages = [
      { key: "new", label: "New" },
      { key: "contacted", label: "Contacted" },
      { key: "prequalified", label: "Prequalified" },
      { key: "preapproved", label: "Preapproved" },
      { key: "in_process", label: "In Process" },
      { key: "in_escrow", label: "In Escrow" },
      { key: "closed", label: "Closed" },
      { key: "lost", label: "Lost" }
    ];
    pipelineRoot.innerHTML = stages.map((s) => `
      <div class="pipeline-column" onclick="window.crmNavigateTo('pipeline')" style="cursor:pointer;">
        <p class="kicker" style="font-size:0.65rem;">${s.label}</p>
        <div class="pipeline-count">${leads.filter((l) => (l.status || "new") === s.key).length}</div>
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
      const lead = task.leads;
      const c = lead?.contacts || {};
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
  const active = apps.filter(a => a.status === 'active').length;
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
  if (!el) return;
  const q = (document.getElementById("appSearchInput")?.value || "").toLowerCase();
  const statusF = document.getElementById("appStatusFilter")?.value || "";
  const sortBy = document.getElementById("appSortBy")?.value || "newest";

  let filtered = _allApplications.filter(app => {
    if (statusF && (app.status || "").toLowerCase() !== statusF) return false;
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
    const clickHandler = hasContact ? `window.location.href='/admin/lead-detail.html?id=${app.contact_id}'` : `alert('No contact linked to this application.')`;

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

function renderDocuments(documents) {
  const el = document.getElementById("admin-document-table");
  if (!el) return;
  if (!documents.length) { renderEmptyState(el, "Uploaded borrower documents will appear here."); return; }
  el.innerHTML = documents.map((doc) => `
    <article class="crm-record-card">
      <div class="crm-record-top">
        <div><strong>${doc.file_name || "File"}</strong><span>${doc.mime_type || "Unknown type"}</span></div>
        <span class="status-pill">${doc.status || "uploaded"}</span>
      </div>
      <div class="crm-record-meta">
        <span>${formatDate(doc.created_at)}</span>
        <span>App ${doc.application_id || "—"}</span>
      </div>
    </article>
  `).join("");
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
