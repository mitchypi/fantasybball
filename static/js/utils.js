// Utility helpers: fetch, formatting, DOM

export async function fetchJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.detail || response.statusText;
    } catch (_) {
      detail = response.statusText;
    }
    throw new Error(detail || `Request failed (${response.status})`);
  }
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch (_) { return {}; }
}

export function qs(sel, root = document) {
  return root.querySelector(sel);
}

export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatNumber(num, { decimals = 1 } = {}) {
  const n = Number(num);
  if (!Number.isFinite(n)) return "–";
  return n.toFixed(decimals).replace(/\.0+$/, "");
}

export function formatCurrency(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return "$0.00";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

export function americanToDecimal(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p === 0) return 1;
  return p > 0 ? 1 + p / 100 : 1 + 100 / Math.abs(p);
}

export function decimalToAmerican(decimal) {
  const d = Number(decimal);
  if (!Number.isFinite(d) || d <= 1) return 0;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

export function showToast(message, type = "success") {
  const toast = qs('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast ${type}`;
  setTimeout(() => toast.classList.add("hidden"), 3500);
  requestAnimationFrame(() => toast.classList.remove("hidden"));
}

export function openModal(modal) {
  if (!modal) return;
  document.body.classList.add("modal-open");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

export function closeModal(modal) {
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

