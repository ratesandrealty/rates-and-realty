import { supabase } from "/api/supabase-client.js";

// ── DASHBOARD DATA ────────────────────────────────────────────────────────────

export async function getAdminDashboardData() {
  const [contactsResult, leadsResult, applicationsResult, documentsResult, notesResult, tasksResult] = await Promise.all([
    supabase.from("contacts").select("*").order("created_at", { ascending: false }),
    supabase.from("leads").select("*, contacts(first_name, last_name, email, phone, credit_score, employer_name, monthly_income)").order("created_at", { ascending: false }),
    supabase.from("mortgage_applications").select("*, contacts!mortgage_applications_contact_id_fkey(id, first_name, last_name, email, phone, credit_score, monthly_income, pipeline_status, score_tier, loan_type)").order("updated_at", { ascending: false }),
    supabase.from("uploaded_documents").select("*").order("created_at", { ascending: false }),
    supabase.from("notes").select("*").order("created_at", { ascending: false }),
    supabase.from("tasks").select("*").order("created_at", { ascending: false })
  ]);

  if (contactsResult.error) throw contactsResult.error;
  if (leadsResult.error) throw leadsResult.error;
  // Non-fatal: applications join may fail if FK not set up
  if (applicationsResult.error) console.warn("Applications load error:", applicationsResult.error);
  if (documentsResult.error) console.warn("Documents load error:", documentsResult.error);
  if (notesResult.error) console.warn("Notes load error:", notesResult.error);
  if (tasksResult.error) console.warn("Tasks load error:", tasksResult.error);

  return {
    contacts: contactsResult.data || [],
    leads: leadsResult.data || [],
    applications: applicationsResult.data || [],
    documents: documentsResult.data || [],
    notes: notesResult.data || [],
    tasks: tasksResult.data || []
  };
}

// ── LEAD OPERATIONS ───────────────────────────────────────────────────────────

export async function getLeadDetail(leadId) {
  const [leadResult, notesResult, tasksResult] = await Promise.all([
    supabase.from("leads")
      .select(`*, contacts(
        first_name, last_name, email, phone, secondary_phone,
        address, city, state, zip, county,
        employer_name, job_title, employment_type, years_employed,
        monthly_income, annual_income, credit_score, monthly_debt,
        preferred_contact, best_time_to_call, date_of_birth, source
      )`)
      .eq("id", leadId)
      .single(),
    supabase.from("notes")
      .select("*")
      .eq("related_table", "leads")
      .eq("related_id", leadId)
      .order("created_at", { ascending: false }),
    supabase.from("tasks")
      .select("*")
      .eq("related_table", "leads")
      .eq("related_id", leadId)
      .order("created_at", { ascending: false })
  ]);

  if (leadResult.error) throw leadResult.error;

  let activityEvents = [];
  try {
    const { data } = await supabase
      .from("activity_events")
      .select("*")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(50);
    activityEvents = data || [];
  } catch (_) {}

  return {
    lead: leadResult.data,
    notes: notesResult.data || [],
    tasks: tasksResult.data || [],
    activityEvents
  };
}

export async function updateLeadStatus(leadId, status) {
  const { data, error } = await supabase
    .from("leads")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", leadId)
    .select()
    .single();
  if (error) throw error;
  await logActivity({ leadId, type: "status_changed", description: `Status changed to ${status}` }).catch(() => {});
  return data;
}

export async function updateLeadStage(leadId, stage) {
  return updateLeadStatus(leadId, stage);
}

export async function updateLead(leadId, fields) {
  const { data, error } = await supabase
    .from("leads")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", leadId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function createLead(contactData, leadData) {
  // Upsert contact by email
  let contactId = null;
  if (contactData.email) {
    const { data: existing } = await supabase
      .from("contacts")
      .select("id")
      .eq("email", contactData.email)
      .maybeSingle();

    if (existing) {
      contactId = existing.id;
      await supabase.from("contacts").update(contactData).eq("id", contactId);
    } else {
      const { data: newContact, error: contactError } = await supabase
        .from("contacts")
        .insert(contactData)
        .select("id")
        .single();
      if (contactError) throw contactError;
      contactId = newContact.id;
    }
  } else {
    const { data: newContact, error: contactError } = await supabase
      .from("contacts")
      .insert(contactData)
      .select("id")
      .single();
    if (contactError) throw contactError;
    contactId = newContact.id;
  }

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .insert({ ...leadData, contact_id: contactId, status: leadData.status || "new" })
    .select()
    .single();
  if (leadError) throw leadError;

  await logActivity({ leadId: lead.id, type: "lead_created", description: `Lead created for ${contactData.first_name || ""} ${contactData.last_name || ""}` }).catch(() => {});
  return lead;
}

export async function deleteLead(leadId) {
  const { error } = await supabase.from("leads").delete().eq("id", leadId);
  if (error) throw error;
}

export async function getLoanTypes() {
  try {
    const { data, error } = await supabase
      .from("loan_types")
      .select("*")
      .order("category")
      .order("name");
    if (error) throw error;
    // Group by category
    const grouped = {};
    (data || []).forEach((lt) => {
      const cat = lt.category || "Other";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(lt);
    });
    return grouped;
  } catch (_) {
    // Fallback if table doesn't exist yet
    return {
      "Conventional": [{ id: "conv", name: "Conventional" }, { id: "conv30", name: "Conventional 30yr" }, { id: "conv15", name: "Conventional 15yr" }],
      "Government": [{ id: "fha", name: "FHA" }, { id: "va", name: "VA" }, { id: "usda", name: "USDA" }],
      "Specialty": [{ id: "dscr", name: "DSCR" }, { id: "jumbo", name: "Jumbo" }, { id: "bridgeL", name: "Bridge Loan" }],
      "Refinance": [{ id: "rateterm", name: "Rate & Term Refi" }, { id: "cashout", name: "Cash-Out Refi" }, { id: "streamline", name: "Streamline Refi" }],
      "Commercial": [{ id: "commercial", name: "Commercial" }, { id: "multifamily", name: "Multifamily" }]
    };
  }
}

// ── NOTES & TASKS ─────────────────────────────────────────────────────────────

export async function addLeadNote({ leadId, body }) {
  const { data, error } = await supabase.from("notes").insert({
    related_table: "leads",
    related_id: leadId,
    body
  }).select().single();
  if (error) throw error;
  await logActivity({ leadId, type: "note_added", description: `Note: ${body.substring(0, 80)}` }).catch(() => {});
  return data;
}

export async function createTask({ leadId, contactId, title, dueDate, priority }) {
  const { data, error } = await supabase.from("tasks").insert({
    related_table: "leads",
    related_id: contactId || leadId || null,
    contact_id: contactId || null,
    title,
    due_date: dueDate || null,
    priority: priority || "normal",
    status: "open"
  }).select().single();
  if (error) throw error;
  if (leadId) {
    await logActivity({ leadId, type: "task_created", description: `Task created: ${title}` }).catch(() => {});
  }
  return data;
}

export async function completeTask(taskId) {
  const { data, error } = await supabase
    .from("tasks")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getAllTasks() {
  const { data, error } = await supabase
    .from("tasks")
    .select("*, leads(id, status, contacts(first_name, last_name))")
    .order("due_date", { ascending: true, nullsLast: true });
  if (error) throw error;
  return data || [];
}

// ── APPOINTMENTS ─────────────────────────────────────────────────────────────

export async function getAppointments() {
  try {
    const { data, error } = await supabase
      .from("appointments")
      .select("*, leads(id, status, contacts(first_name, last_name))")
      .order("scheduled_at", { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (_) {
    return [];
  }
}

async function syncToGoogleCalendar(appointmentId) {
  try {
    const res = await fetch(
      'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/google-calendar-sync',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointment_id: appointmentId })
      }
    );
    const result = await res.json();
    if (result.success) {
      console.log('Synced to Google Calendar:', result.google_event_link);
    }
  } catch(e) {
    console.warn('Google Calendar sync failed silently:', e);
  }
}

export async function createAppointment({ title, type, date, time, leadId, contactId, notes }) {
  const scheduledAt = time ? `${date}T${time}:00` : `${date}T09:00:00`;
  try {
    const { data, error } = await supabase.from("appointments").insert({
      title,
      type: type || "call",
      scheduled_at: scheduledAt,
      lead_id: leadId || null,
      contact_id: contactId || null,
      notes: notes || null,
      status: "scheduled"
    }).select().single();
    if (error) throw error;
    if (data.id) syncToGoogleCalendar(data.id);
    if (leadId) {
      await logActivity({ leadId, type: "appointment_booked", description: `${type || "Appointment"}: ${title} on ${date}` }).catch(() => {});
    }
    return data;
  } catch (err) {
    if (err.code === "42P01") throw new Error("Run the SQL migration to create the appointments table first.");
    throw err;
  }
}

// ── COMMUNICATIONS ────────────────────────────────────────────────────────────

export async function getCommunications(leadId = null) {
  try {
    let query = supabase.from("communications").select("*").order("created_at", { ascending: false }).limit(100);
    if (leadId) query = query.eq("lead_id", leadId);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (_) {
    return getMockCommunications(leadId);
  }
}

function getMockCommunications(leadId) {
  return [
    { id: "m1", type: "sms", direction: "outbound", contact_name: "Michael Torres", body: "Hi Michael, following up on your DSCR application — let me know if you have questions.", created_at: new Date(Date.now() - 3600000).toISOString(), lead_id: leadId },
    { id: "m2", type: "call", direction: "inbound", contact_name: "Sarah Lin", body: "Called in to ask about FHA requirements. Discussed 3.5% down and credit score minimums.", created_at: new Date(Date.now() - 86400000).toISOString(), lead_id: leadId },
    { id: "m3", type: "email", direction: "outbound", contact_name: "Jennifer Marquez", body: "Sent pre-approval letter and next steps checklist.", created_at: new Date(Date.now() - 172800000).toISOString(), lead_id: leadId },
    { id: "m4", type: "sms", direction: "inbound", contact_name: "David Chen", body: "Can we move the appointment to Thursday?", created_at: new Date(Date.now() - 259200000).toISOString(), lead_id: leadId }
  ];
}

// ── ACTIVITY ─────────────────────────────────────────────────────────────────

export async function getActivityFeed(leadId = null) {
  try {
    let query = supabase.from("activity_events").select("*").order("created_at", { ascending: false }).limit(60);
    if (leadId) query = query.eq("lead_id", leadId);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (_) {
    return getMockActivity();
  }
}

export async function logActivity({ leadId, type, description }) {
  try {
    const { error } = await supabase.from("activity_events").insert({
      lead_id: leadId || null,
      type,
      description,
      created_at: new Date().toISOString()
    });
    if (error) throw error;
  } catch (_) {}
}

function getMockActivity() {
  const now = Date.now();
  return [
    { id: "a1", type: "lead_created", description: "New lead captured from DSCR funnel", created_at: new Date(now - 600000).toISOString() },
    { id: "a2", type: "status_changed", description: "Lead status changed to Contacted", created_at: new Date(now - 3600000).toISOString() },
    { id: "a3", type: "note_added", description: "Note: Borrower asked about down payment requirements for DSCR", created_at: new Date(now - 7200000).toISOString() },
    { id: "a4", type: "task_created", description: "Task created: Send pre-qualification checklist", created_at: new Date(now - 86400000).toISOString() },
    { id: "a5", type: "appointment_booked", description: "Call scheduled for Friday 10am", created_at: new Date(now - 172800000).toISOString() },
    { id: "a6", type: "document_uploaded", description: "Bank statement uploaded by borrower", created_at: new Date(now - 259200000).toISOString() }
  ];
}

// ── ANALYTICS ─────────────────────────────────────────────────────────────────

export async function getAnalyticsData(leads, tasks, applications) {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const bySource = {};
  leads.forEach((l) => {
    const src = l.source || "website";
    bySource[src] = (bySource[src] || 0) + 1;
  });

  const byLoanType = {};
  leads.forEach((l) => {
    const type = l.loan_type || "Unknown";
    byLoanType[type] = (byLoanType[type] || 0) + 1;
  });

  const allStages = ["new", "contacted", "prequalified", "preapproved", "in_process", "in_escrow", "closed", "lost"];
  const byStage = {};
  allStages.forEach((s) => {
    byStage[s] = leads.filter((l) => (l.status || "new") === s).length;
  });

  const weeklyLeads = [0, 0, 0, 0];
  leads.forEach((l) => {
    const created = new Date(l.created_at);
    if (created >= thirtyDaysAgo) {
      const daysAgo = Math.floor((now - created) / (7 * 24 * 3600 * 1000));
      const idx = Math.min(daysAgo, 3);
      weeklyLeads[3 - idx]++;
    }
  });

  const todayStr = now.toISOString().split("T")[0];
  let appointmentsToday = 0;
  try {
    const appts = await getAppointments();
    appointmentsToday = appts.filter((a) => (a.scheduled_at || "").startsWith(todayStr)).length;
  } catch (_) {}

  const hotLeads = leads.filter((l) => (l.score || 0) >= 70).length;
  const newThisWeek = leads.filter((l) => new Date(l.created_at) >= sevenDaysAgo).length;
  const closedThisMonth = leads.filter((l) => (l.status || "") === "closed" && new Date(l.updated_at || l.created_at) >= firstOfMonth).length;
  const openTasks = tasks.filter((t) => (t.status || "open").toLowerCase() !== "completed").length;
  const submitted = applications.filter((a) => a.status !== "draft").length;

  return {
    totalLeads: leads.length,
    newThisWeek,
    hotLeads,
    closedThisMonth,
    newLeads: byStage["new"] || 0,
    openTasks,
    submitted,
    appointmentsToday,
    weeklyLeads,
    bySource,
    byLoanType,
    byStage,
    conversionRate: leads.length > 0 ? Math.round(((byStage["closed"] || 0) / leads.length) * 100) : 0
  };
}

// ── LEAD SCORING ──────────────────────────────────────────────────────────────

export function calculateLeadScore(lead = {}, contact = {}) {
  let total = 0;
  const breakdown = {};

  // 1. Intent / Timeline (25 pts max)
  const timelineMap = {
    asap: 25, "30days": 20, "1-3months": 20,
    "60days": 15, "3-6months": 15,
    "90days": 10, "6-12months": 5, "6months": 5,
    exploring: 0, browsing: 0
  };
  const intentScore = timelineMap[(lead.timeline || "").toLowerCase()] ?? 0;
  breakdown.intent = { score: intentScore, max: 25, label: "Intent / Timeline" };
  total += intentScore;

  // 2. Financial Readiness (25 pts max)
  const cs = Number(contact.credit_score || 0);
  let financialScore = 0;
  if (cs >= 740) financialScore = 25;
  else if (cs >= 700) financialScore = 20;
  else if (cs >= 660) financialScore = 15;
  else if (cs >= 620) financialScore = 10;
  else if (cs >= 580) financialScore = 5;
  breakdown.financial = { score: financialScore, max: 25, label: "Financial Readiness" };
  total += financialScore;

  // 3. Engagement (20 pts max) — proxied via status progression
  const engMap = {
    new: 0, contacted: 5, prequalified: 12,
    preapproved: 16, in_process: 20, in_escrow: 20, closed: 20, lost: 8
  };
  const engScore = engMap[lead.status || "new"] ?? 0;
  breakdown.engagement = { score: engScore, max: 20, label: "Engagement" };
  total += engScore;

  // 4. Property Identified (15 pts max)
  let propScore = 0;
  if (lead.property_address && lead.property_address.trim().length > 3) propScore = 15;
  else if (lead.purchase_price && Number(lead.purchase_price) > 0) propScore = 10;
  breakdown.property = { score: propScore, max: 15, label: "Property Identified" };
  total += propScore;

  // 5. Lead Source Quality (10 pts max)
  const src = (lead.source || contact.source || "").toLowerCase();
  const sourceMap = {
    referral: 10, website: 8, google: 7, google_ads: 7,
    zillow: 7, "realtor.com": 7, realtor: 7,
    facebook: 6, fb: 6, social: 6,
    direct: 8, cold: 2, cold_list: 2, other: 4
  };
  const sourceScore = sourceMap[src] ?? 5;
  breakdown.source = { score: sourceScore, max: 10, label: "Source Quality" };
  total += sourceScore;

  // 6. Responsiveness (5 pts max, can be negative)
  const daysSince = lead.created_at
    ? Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 86400000)
    : 0;
  let respScore = 0;
  if (lead.status && lead.status !== "new") {
    respScore = 5;
  } else if (daysSince <= 0) {
    respScore = 5;
  } else if (daysSince <= 3) {
    respScore = 3;
  } else if (daysSince >= 14) {
    respScore = -10;
  } else if (daysSince >= 7) {
    respScore = -5;
  }
  breakdown.responsiveness = { score: respScore, max: 5, label: "Responsiveness" };
  total += respScore;

  const score = Math.max(0, Math.min(100, Math.round(total)));
  const tier = score >= 80 ? "hot" : score >= 50 ? "warm" : "cold";

  return { score, tier, breakdown };
}

export async function updateLeadScore(leadId, contactId, lead, contact) {
  const { score, tier } = calculateLeadScore(lead, contact);
  const updates = [];
  if (leadId) {
    updates.push(
      supabase.from("leads").update({ score, score_tier: tier }).eq("id", leadId).catch(() => {})
    );
  }
  if (contactId) {
    updates.push(
      supabase.from("contacts").update({ lead_score: score, score_tier: tier }).eq("id", contactId).catch(() => {})
    );
  }
  await Promise.all(updates);
  return { score, tier };
}
