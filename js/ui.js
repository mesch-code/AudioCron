export const APP_VERSION = "0.3";

export const PLATFORMS = [
  { id: "bookbeat", label: "BookBeat" },
  { id: "borrowbox", label: "Borrow Box" },
  { id: "andere", label: "Andere" }
];

export const STATUSES = [
  { id: "gehoert", label: "Gehört" },
  { id: "hoere", label: "Höre ich gerade" },
  { id: "vormerk", label: "Vorgemerkt" }
];

export function platformLabel(id) {
  return PLATFORMS.find(p => p.id === id)?.label || "Andere";
}

export function statusLabel(id) {
  return STATUSES.find(s => s.id === id)?.label || "";
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

export function openSheet(html) {
  const sheet = document.getElementById("sheet");
  const backdrop = document.getElementById("sheet-backdrop");
  sheet.innerHTML = `<div class="sheet-grip"></div>` + html;
  sheet.classList.remove("hidden");
  backdrop.classList.remove("hidden");
  sheet.scrollTop = 0;
  backdrop.onclick = closeSheet;
  return sheet;
}

export function closeSheet() {
  document.getElementById("sheet").classList.add("hidden");
  document.getElementById("sheet-backdrop").classList.add("hidden");
  document.dispatchEvent(new CustomEvent("sheetclosed"));
}

export function stars(rating) {
  if (!rating) return "";
  return `<span class="stars">${"★".repeat(rating)}${"☆".repeat(5 - rating)}</span>`;
}

export function fmtHours(minutes) {
  if (!minutes) return "0 h";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

export function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function spinner() {
  return `<div class="spinner"></div>`;
}
