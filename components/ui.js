export function setMessage(element, text, type = "") {
  if (!element) return;
  element.textContent = text;
  element.classList.remove("is-error", "is-success");
  if (type === "error") element.classList.add("is-error");
  if (type === "success") element.classList.add("is-success");
}

export function currency(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value || 0));
}

export function formatDate(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "N/A" : date.toLocaleDateString("en-US");
}

export function formToObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

export function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

export function renderEmptyState(container, text) {
  container.innerHTML = `<div class="list-item"><strong>No records yet</strong><span>${text}</span></div>`;
}
