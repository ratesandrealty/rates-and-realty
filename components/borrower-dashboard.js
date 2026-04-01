import { isAdminUser, requireUser, signOutBorrower } from "/api/auth-api.js";
import { getBorrowerDashboard, saveApplication, uploadBorrowerDocument } from "/api/borrower-api.js";
import { formatDate, renderEmptyState, setMessage } from "/components/ui.js";

const summaryRoot = document.getElementById("borrower-summary");
const applicationForm = document.getElementById("application-form");
const applicationMessage = document.getElementById("application-message");
const documentForm = document.getElementById("document-form");
const documentMessage = document.getElementById("document-message");
const documentList = document.getElementById("document-list");
const startApplicationButton = document.getElementById("start-application-button");
const prevStepButton = document.getElementById("prev-step-button");
const nextStepButton = document.getElementById("next-step-button");
const stepButtons = [...document.querySelectorAll("[data-step-button]")];
const stepPanels = [...document.querySelectorAll("[data-step]")];

let currentUser;
let currentApplication;
let currentStep = 0;

initializeDashboard();

async function initializeDashboard() {
  try {
    currentUser = await requireUser();
    attachHeaderLogout();
    bindFormStepper();
    await loadDashboard();
  } catch (error) {
    console.error(error);
  }
}

async function loadDashboard() {
  const { profile, application, documents } = await getBorrowerDashboard(currentUser.id);
  currentApplication = application;

  // Summary cards
  summaryRoot.innerHTML = `
    <article class="metric-card ${statusCardClass(application?.status)}">
      <strong>${capitalize(application?.status || "draft")}</strong>
      <span>Application Status</span>
    </article>
    <article class="metric-card">
      <strong>${documents.length}</strong>
      <span>Documents Uploaded</span>
    </article>
    <article class="metric-card">
      <strong>${application?.loan_type || "Not Selected"}</strong>
      <span>Loan Program</span>
    </article>
    <article class="metric-card">
      <strong>${profile?.first_name || currentUser.user_metadata?.first_name || "Borrower"}</strong>
      <span>Account Name</span>
    </article>
  `;

  // Update progress bar
  updateProgressTracker(application?.status, documents.length);

  // Populate form
  const data = application?.application_data || {};
  const values = {
    borrowerFirstName: profile?.first_name || data.borrowerFirstName || currentUser.user_metadata?.first_name || "",
    borrowerLastName: profile?.last_name || data.borrowerLastName || currentUser.user_metadata?.last_name || "",
    borrowerPhone: profile?.phone || data.borrowerPhone || currentUser.user_metadata?.phone || "",
    dateOfBirth: profile?.date_of_birth || data.dateOfBirth || "",
    currentAddress: profile?.current_address || data.currentAddress || "",
    loanType: application?.loan_type || data.loanType || "Conventional",
    applicationStatus: application?.status || data.applicationStatus || "draft",
    propertyAddress: application?.property_address || data.propertyAddress || "",
    purchasePrice: application?.purchase_price || data.purchasePrice || "",
    loanAmount: application?.loan_amount || data.loanAmount || "",
    employerName: data.employerName || "",
    jobTitle: data.jobTitle || "",
    monthlyIncome: data.monthlyIncome || "",
    yearsOnJob: data.yearsOnJob || "",
    cashAssets: data.cashAssets || "",
    investmentAssets: data.investmentAssets || "",
    monthlyDebt: data.monthlyDebt || "",
    otherLiabilities: data.otherLiabilities || ""
  };
  Object.entries(values).forEach(([key, value]) => {
    if (applicationForm.elements[key]) applicationForm.elements[key].value = value;
  });

  // Document list
  if (!documents.length) {
    renderEmptyState(documentList, "Your uploaded documents will appear here.");
  } else {
    documentList.innerHTML = documents.map((doc) => `
      <div class="doc-row" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div>
          <strong style="font-size:0.88rem;">${doc.file_name || "Untitled file"}</strong>
          <span style="color:var(--muted);font-size:0.78rem;display:block;">${formatDate(doc.created_at)}</span>
        </div>
        <span class="status-pill ${doc.status === "reviewed" ? "status-pill-green" : ""}">${doc.status || "uploaded"}</span>
      </div>
    `).join("");
  }

  // Mark checklist items based on uploaded files
  updateDocumentChecklist(documents);
}

function updateProgressTracker(status, docCount) {
  const statusStepMap = {
    draft: 1, submitted: 2, review: 3, approved: 4, closed: 5
  };
  const step = statusStepMap[status] || (docCount > 0 ? 2 : 1);
  const totalSteps = 5;
  const pct = Math.round((step / totalSteps) * 100);

  const fill = document.getElementById("progress-fill");
  if (fill) fill.style.width = `${pct}%`;

  const steps = document.querySelectorAll(".progress-step");
  steps.forEach((el, i) => {
    el.classList.remove("done", "current");
    if (i < step) el.classList.add("done");
    if (i === step) el.classList.add("current");
  });
}

function updateDocumentChecklist(documents) {
  const fileNames = documents.map((d) => (d.file_name || "").toLowerCase());
  const checks = [
    { id: "chk-id", keywords: ["id", "license", "passport", "driver"] },
    { id: "chk-paystubs", keywords: ["pay", "stub", "paystub", "w2"] },
    { id: "chk-bank", keywords: ["bank", "statement"] },
    { id: "chk-taxes", keywords: ["tax", "return", "1040"] },
    { id: "chk-contract", keywords: ["contract", "agreement", "purchase"] }
  ];
  checks.forEach(({ id, keywords }) => {
    const el = document.getElementById(id);
    if (!el) return;
    const uploaded = fileNames.some((name) => keywords.some((kw) => name.includes(kw)));
    if (uploaded) {
      el.textContent = "✓ Uploaded";
      el.className = "doc-check-status uploaded";
      el.closest(".doc-checklist-item")?.classList.add("is-uploaded");
    }
  });
}

function statusCardClass(status) {
  const map = { approved: "metric-card-gold", submitted: "", review: "", draft: "", closed: "metric-card-gold" };
  return map[status] || "";
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : "Draft";
}

function setStep(nextStep) {
  currentStep = Math.max(0, Math.min(nextStep, stepPanels.length - 1));
  stepButtons.forEach((button, index) => button.classList.toggle("is-active", index === currentStep));
  stepPanels.forEach((panel, index) => panel.classList.toggle("is-active", index === currentStep));
}

function bindFormStepper() {
  setStep(0);
  stepButtons.forEach((button, index) => button.addEventListener("click", () => setStep(index)));
  prevStepButton?.addEventListener("click", () => setStep(currentStep - 1));
  nextStepButton?.addEventListener("click", () => setStep(currentStep + 1));
}

applicationForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(applicationMessage, "Saving application...");
  const payload = Object.fromEntries(new FormData(applicationForm).entries());
  try {
    currentApplication = await saveApplication(currentUser, payload);
    setMessage(applicationMessage, "Application saved successfully.", "success");
    await loadDashboard();
  } catch (error) {
    setMessage(applicationMessage, error.message || "Unable to save application.", "error");
  }
});

documentForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = document.getElementById("document-file")?.files?.[0];
  if (!file) return setMessage(documentMessage, "Please select a file before uploading.", "error");
  if (!currentApplication?.id) return setMessage(documentMessage, "Save your application first so documents can be attached.", "error");
  setMessage(documentMessage, "Uploading...");
  try {
    await uploadBorrowerDocument({ userId: currentUser.id, applicationId: currentApplication.id, file });
    setMessage(documentMessage, "Document uploaded successfully.", "success");
    documentForm.reset();
    await loadDashboard();
  } catch (error) {
    setMessage(documentMessage, error.message || "Unable to upload document.", "error");
  }
});

startApplicationButton?.addEventListener("click", async () => {
  setMessage(applicationMessage, "Refreshing...");
  await loadDashboard();
  setMessage(applicationMessage, "", "");
});

function attachHeaderLogout() {
  const actions = document.querySelector(".header-actions");
  if (!actions) return;
  const adminLink = isAdminUser(currentUser) ? `<a class="btn btn-secondary btn-sm" href="/dashboard/admin.html">CRM</a>` : "";
  actions.innerHTML = `${adminLink}<button id="logout-button" class="btn btn-primary btn-sm" type="button">Sign Out</button>`;
  document.getElementById("logout-button")?.addEventListener("click", async () => {
    await signOutBorrower();
    window.location.href = "/public/unified-portal.html";
  });
}
