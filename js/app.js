import {
  allBooks, getBook, putBook, deleteBook, bulkPut, clearAll,
  getCoverUrl, storeCover, isDup, uid, norm
} from "./db.js";
import {
  searchCombined, isbnLookup, barcodeSupported, startBarcodeScan, resolveCover,
  coverCandidates, descriptionCandidates, olCoverUrlFor, fetchIsbnMetadata, resolveCoverUrl,
  coverForIsbn, getSourceConfig, setSourceConfig, sourceLabel
} from "./api.js";
import {
  importOpenreadsCsv, exportOpenreadsCsv, exportJson, importJson
} from "./csv.js";
import {
  PLATFORMS, STATUSES, esc, toast, openSheet, closeSheet, stars,
  fmtHours, fmtDate, download, spinner, platformLabel, statusLabel, APP_VERSION
} from "./ui.js";
import { renderStats, hydrateCovers, coverImg } from "./stats.js";

const state = {
  route: "library",
  query: "",
  platform: "alle",
  status: "alle",
  sort: "neu",
  bulk: false
};
const selected = new Set();

/* ---------- Stichtag (Kontingent-Reset) ---------- */

const STICH_TAG_KEY = "audiocron_stichtag";

function getStichtag() {
  return localStorage.getItem(STICH_TAG_KEY) || "";
}

function setStichtag(iso) {
  if (iso) localStorage.setItem(STICH_TAG_KEY, iso);
  else localStorage.removeItem(STICH_TAG_KEY);
}

function stichtagCountdown(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "";
  const target = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((target - today) / 86400000);
  if (days === 0) return "heute";
  if (days === 1) return "morgen";
  if (days > 0) return `in ${days} Tagen`;
  const past = -days;
  return past === 1 ? "seit gestern" : `seit ${past} Tagen`;
}

function openStichtagEditor() {
  const sheet = openSheet(`
    <h2>Kontingent-Stichtag</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:10px">Das Datum, ab dem du wieder Kontingent in der anderen Plattform hast. Wird oben in der Bibliothek angezeigt.</p>
    <div class="form-row"><label>Stichtag</label><input id="st-date" type="date" value="${esc(getStichtag())}"></div>
    <div id="st-preview" style="font-size:13px;color:var(--muted);margin-bottom:12px">${getStichtag() ? `⏳ ${stichtagCountdown(getStichtag())}` : ""}</div>
    <div class="btnrow">
      <button class="btn danger" id="st-clear" ${getStichtag() ? "" : "disabled"}>Entfernen</button>
      <button class="btn primary" id="st-save">💾 Speichern</button>
    </div>
  `);
  const input = sheet.querySelector("#st-date");
  const preview = sheet.querySelector("#st-preview");
  input.addEventListener("change", () => {
    preview.textContent = input.value ? `⏳ ${stichtagCountdown(input.value)}` : "";
  });
  sheet.querySelector("#st-save").onclick = () => {
    if (!input.value) { toast("Bitte Datum wählen"); return; }
    setStichtag(input.value);
    closeSheet();
    toast(`Stichtag: ${fmtDate(input.value)} ✓`);
    render();
  };
  sheet.querySelector("#st-clear").onclick = () => {
    setStichtag("");
    closeSheet();
    toast("Stichtag entfernt");
    render();
  };
}

/* ---------- Router ---------- */

function navigate(route) {
  state.route = route;
  if (state.bulk) exitBulk();
  document.querySelectorAll(".nav-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.route === route));
  document.getElementById("fab").style.display = route === "library" ? "" : "none";
  render();
}

window.addEventListener("pageshow", e => {
  if (e.persisted) render();
});

document.addEventListener("error", e => {
  const t = e.target;
  if (t && t.tagName === "IMG" && t.classList.contains("cover")) {
    t.outerHTML = `<div class="cover placeholder">🎧</div>`;
  }
}, true);

async function render() {
  const view = document.getElementById("view");
  const title = document.getElementById("topbar-title");
  const actions = document.getElementById("topbar-actions");
  if (state.route !== "library") actions.innerHTML = "";
  if (state.route === "stats") {
    title.textContent = "Statistik";
    await renderStats(view);
    return;
  }
  if (state.route === "settings") {
    title.textContent = "Einstellungen";
    await renderSettings(view);
    return;
  }
  title.textContent = "AudioCron";
  await renderLibrary(view);
}

/* ---------- Bibliothek ---------- */

async function renderLibrary(view) {
  const books = await allBooks();
  const actions = document.getElementById("topbar-actions");
  actions.innerHTML = `<button class="chip ${state.bulk ? "active" : ""}" id="bulk-toggle">${state.bulk ? "Fertig" : "Auswahl"}</button>`;
  actions.querySelector("#bulk-toggle").onclick = () => {
    state.bulk ? exitBulk() : enterBulk();
    render();
  };
  const st = getStichtag();
  const stBanner = st ? `<div class="stichtag" id="st-banner" title="Stichtag bearbeiten">🗓 Wieder Kontingent ab <strong>${fmtDate(st)}</strong> · ${stichtagCountdown(st)}</div>` : "";
  view.innerHTML = stBanner + `
    <div class="searchbar">
      <input id="q" type="search" placeholder="Titel, Autor, Sprecher suchen…" value="${esc(state.query)}">
    </div>
    <div class="chiprow" id="f-platform">
      <button class="chip ${state.platform === "alle" ? "active" : ""}" data-platform="alle">Alle <span class="cnt"></span></button>
      ${PLATFORMS.map(p => `<button class="chip ${state.platform === p.id ? "active" : ""}" data-platform="${p.id}">${p.label} <span class="cnt"></span></button>`).join("")}
    </div>
    <div class="chiprow" id="f-status">
      <button class="chip ${state.status === "alle" ? "active" : ""}" data-status="alle">Alle Status <span class="cnt"></span></button>
      ${STATUSES.map(s => `<button class="chip ${state.status === s.id ? "active" : ""}" data-status="${s.id}">${s.label} <span class="cnt"></span></button>`).join("")}
    </div>
    <div class="searchbar">
      <select id="sort">
        <option value="neu" ${state.sort === "neu" ? "selected" : ""}>Zuletzt hinzugefügt</option>
        <option value="fertig" ${state.sort === "fertig" ? "selected" : ""}>Zuletzt beendet</option>
        <option value="titel" ${state.sort === "titel" ? "selected" : ""}>Titel A–Z</option>
        <option value="autor" ${state.sort === "autor" ? "selected" : ""}>Autor A–Z</option>
      </select>
    </div>
    <div id="list"></div>`;

  view.querySelector("#st-banner")?.addEventListener("click", openStichtagEditor);
  view.querySelector("#q").addEventListener("input", e => {
    state.query = e.target.value;
    paintList(books);
  });
  view.querySelector("#sort").addEventListener("change", e => {
    state.sort = e.target.value;
    paintList(books);
  });
  for (const id of ["f-platform", "f-status"]) {
    view.querySelector("#" + id).addEventListener("click", e => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      if (id === "f-platform") state.platform = chip.dataset.platform;
      else state.status = chip.dataset.status;
      view.querySelectorAll(`#${id} .chip`).forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      paintList(books);
    });
  }
  paintList(books);
}

function matchesQuery(b, q) {
  if (!q) return true;
  const hay = norm([b.title, b.author, b.narrator, b.series].join(" "));
  return q.split(" ").every(t => hay.includes(t));
}

function filtered(books) {
  const q = norm(state.query);
  let list = books.filter(b => {
    if (state.platform !== "alle" && b.platform !== state.platform) return false;
    if (state.status !== "alle" && b.status !== state.status) return false;
    if (!matchesQuery(b, q)) return false;
    return true;
  });
  const by = {
    neu: (a, b) => (b.addedDate || "").localeCompare(a.addedDate || "") || b.createdAt - a.createdAt,
    fertig: (a, b) => (b.finishDate || "").localeCompare(a.finishDate || ""),
    titel: (a, b) => a.title.localeCompare(b.title, "de"),
    autor: (a, b) => (a.author || "~~~").localeCompare(b.author || "~~~", "de") || a.title.localeCompare(b.title, "de")
  };
  list.sort(by[state.sort]);
  return list;
}

function updateChipCounts(books) {
  const q = norm(state.query);
  const byStatus = books.filter(b => state.status === "alle" || b.status === state.status);
  const byPlatform = books.filter(b => state.platform === "alle" || b.platform === state.platform);
  const set = (selector, n) => {
    const el = document.querySelector(selector);
    if (el) el.textContent = n;
  };
  set('#f-platform [data-platform="alle"] .cnt', byStatus.filter(b => matchesQuery(b, q)).length);
  for (const p of PLATFORMS) {
    set(`#f-platform [data-platform="${p.id}"] .cnt`,
      byStatus.filter(b => b.platform === p.id && matchesQuery(b, q)).length);
  }
  set('#f-status [data-status="alle"] .cnt', byPlatform.filter(b => matchesQuery(b, q)).length);
  for (const s of STATUSES) {
    set(`#f-status [data-status="${s.id}"] .cnt`,
      byPlatform.filter(b => b.status === s.id && matchesQuery(b, q)).length);
  }
}

async function paintList(books) {
  updateChipCounts(books);
  const list = filtered(books);
  const el = document.getElementById("list");
  for (const id of [...selected]) {
    if (!books.some(b => b.id === id)) selected.delete(id);
  }
  if (!list.length) {
    el.innerHTML = `<div class="empty"><div class="big">🎧</div>
      ${books.length ? "Keine Treffer für deine Filter." : "Noch keine Bücher.<br>Tippe auf +, um loszulegen."}</div>`;
    return;
  }
  const grouped = state.sort === "autor";
  let html = "", current = null;
  for (const b of list) {
    if (grouped) {
      const a = b.author || "Unbekannt";
      if (a !== current) {
        html += `<div class="grouphead">${esc(a)}</div>`;
        current = a;
      }
    }
    html += `
      <div class="bookcard ${state.bulk && selected.has(b.id) ? "selected" : ""}" data-id="${b.id}">
        ${state.bulk ? `<span class="selbox ${selected.has(b.id) ? "on" : ""}">${selected.has(b.id) ? "✓" : ""}</span>` : ""}
        ${coverImg(b)}
        <div class="bookinfo">
          <div class="t">${esc(b.title)}${b.series ? ` <span style="color:var(--muted);font-weight:400;font-size:12px">· ${esc(b.series)}</span>` : ""}</div>
          <div class="a">${esc(b.author)}${b.narrator ? ` · <span style="font-style:italic">${esc(b.narrator)}</span>` : ""}</div>
          ${b.tags ? `<div class="tagsline">${esc(b.tags)}</div>` : ""}
          <div class="bookmeta">
            <span class="badge ${b.platform}">${esc(platformLabel(b.platform))}</span>
            ${state.bulk ? "" : `<span class="badge ${b.status} tappable" data-cycle="${b.id}" title="Status wechseln">${esc(statusLabel(b.status))} ⟳</span>`}
            ${b.lengthMin ? `<span style="color:var(--muted);font-size:11.5px">${fmtHours(b.lengthMin)}</span>` : ""}
            ${b.status === "gehoert" && b.finishDate ? `<span style="color:var(--muted);font-size:11.5px">${fmtDate(b.finishDate)}</span>` : ""}
            ${stars(b.rating)}
          </div>
        </div>
      </div>`;
  }
  const bulkBar = state.bulk ? `
    <div class="bulkbar">
      <span class="bulksel">${selected.size}/${list.length}</span>
      <button class="chip" id="bulk-all">${selected.size && selected.size === list.length ? "Keine" : "Alle"}</button>
      <button class="chip" id="bulk-status">Status</button>
      <button class="chip" id="bulk-platform">Plattform</button>
      <button class="chip" id="bulk-tag">🏷 Tags</button>
      <button class="chip danger" id="bulk-del" ${selected.size ? "" : "disabled"}>🗑 Löschen</button>
    </div>` : "";
  el.innerHTML = `<div class="listcount">${list.length} ${list.length === 1 ? "Hörbuch" : "Hörbücher"}</div>` + bulkBar + html;
  hydrateCovers(el);
  if (state.bulk) {
    el.querySelectorAll(".bookcard").forEach(c =>
      c.addEventListener("click", () => {
        const id = c.dataset.id;
        if (selected.has(id)) selected.delete(id); else selected.add(id);
        paintList(books);
      }));
    const bulkAction = (id, fn) => {
      const btn = el.querySelector("#" + id);
      if (btn) btn.onclick = () => fn(books);
    };
    bulkAction("bulk-all", () => {
      const visible = filtered(books).map(b => b.id);
      if (visible.every(id => selected.has(id))) visible.forEach(id => selected.delete(id));
      else visible.forEach(id => selected.add(id));
      paintList(books);
    });
    bulkAction("bulk-status", () => openBulkChoice("Status",
      STATUSES.map(s => ({ value: s.id, label: s.label })), async (value, ids) => {
        for (const id of ids) {
          const b = await getBook(id);
          if (!b) continue;
          b.status = value;
          if (value === "gehoert" && !b.finishDate) {
            b.finishDate = new Date().toISOString().slice(0, 10);
          }
          if (value !== "gehoert") b.finishDate = "";
          await putBook(b);
        }
        toast(`${ids.length} Bücher aktualisiert`);
      }));
    bulkAction("bulk-platform", () => openBulkChoice("Plattform",
      PLATFORMS.map(p => ({ value: p.id, label: p.label })), async (value, ids) => {
        for (const id of ids) {
          const b = await getBook(id);
          if (!b) continue;
          b.platform = value;
          await putBook(b);
        }
        toast(`${ids.length} Bücher aktualisiert`);
      }));
    bulkAction("bulk-tag", () => openBulkTags(books));
    bulkAction("bulk-del", async () => {
      if (!selected.size) return;
      if (!confirm(`${selected.size} Bücher wirklich löschen?`)) return;
      const ids = [...selected];
      for (const id of ids) await deleteBook(id);
      selected.clear();
      toast(`${ids.length} gelöscht`);
      const fresh = await allBooks();
      paintList(fresh);
      updateChipCounts(fresh);
    });
    return;
  }
  el.querySelectorAll(".bookcard").forEach(c =>
    c.addEventListener("click", () => openDetail(c.dataset.id)));
  el.querySelectorAll(".badge.tappable").forEach(badge => {
    badge.addEventListener("click", async e => {
      e.stopPropagation();
      await cycleStatus(badge.dataset.cycle, badge);
    });
  });
}

function enterBulk() {
  state.bulk = true;
  selected.clear();
}

function exitBulk() {
  state.bulk = false;
  selected.clear();
}

function openBulkChoice(title, options, onPick) {
  if (!selected.size) { toast("Erst Bücher auswählen"); return; }
  const sheet = openSheet(`
    <h2>${esc(title)} ändern</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:10px">Für ${selected.size} ausgewählte Bücher:</p>
    <div class="addoptions">
      ${options.map(o => `<button class="addopt" data-value="${esc(o.value)}"><span class="lbl">${esc(o.label)}</span></button>`).join("")}
    </div>
  `);
  sheet.querySelectorAll(".addopt").forEach(btn => {
    btn.onclick = async () => {
      const ids = [...selected];
      closeSheet();
      await onPick(btn.dataset.value, ids);
      selected.clear();
      render();
    };
  });
}

function parseTags(s) {
  return (s || "").split(",").map(t => t.trim()).filter(Boolean);
}

function mergeTags(existing, add, remove) {
  const rmKeys = new Set(remove.map(t => t.toLowerCase()));
  const out = parseTags(existing).filter(t => !rmKeys.has(t.toLowerCase()));
  const seen = new Set(out.map(t => t.toLowerCase()));
  for (const t of add) {
    if (!seen.has(t.toLowerCase())) { out.push(t); seen.add(t.toLowerCase()); }
  }
  return out.join(", ");
}

function openBulkTags(books) {
  if (!selected.size) { toast("Erst Bücher auswählen"); return; }
  const counts = new Map();
  for (const b of books) {
    for (const t of parseTags(b.tags)) {
      const k = t.toLowerCase();
      if (!counts.has(k)) counts.set(k, { label: t, n: 0 });
      counts.get(k).n++;
    }
  }
  const existing = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
  const sheet = openSheet(`
    <h2>Tags ändern</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:10px">Für ${selected.size} ausgewählte Bücher. Mehrere neue Tags durch Komma getrennt.</p>
    <div class="form-row"><label>Hinzufügen</label><input id="bt-add" placeholder="z.B. Krimi, Oslo"></div>
    ${existing.length ? `<div class="grouphead">Vorhandene Tags – antippen zum Entfernen</div>
      <div class="chiprow" id="bt-remove" style="flex-wrap:wrap">${existing.map(([k, v]) =>
        `<button class="chip" data-tag="${esc(k)}">${esc(v.label)} <span class="cnt">${v.n}</span></button>`).join("")}</div>
      <p style="color:var(--muted);font-size:12px;margin:4px 0 10px">Erneut antippen hebt die Entfernung auf.</p>` : ""}
    <div class="btnrow"><button class="btn primary block" id="bt-apply">Übernehmen</button></div>
  `);
  const removeSel = new Set();
  sheet.querySelector("#bt-remove")?.addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const tag = chip.dataset.tag;
    if (removeSel.has(tag)) { removeSel.delete(tag); chip.classList.remove("danger-on"); }
    else { removeSel.add(tag); chip.classList.add("danger-on"); }
  });
  sheet.querySelector("#bt-apply").onclick = async () => {
    const add = parseTags(sheet.querySelector("#bt-add").value);
    const remove = [...removeSel].map(k => counts.get(k)?.label || k);
    if (!add.length && !remove.length) { toast("Nichts geändert"); return; }
    const ids = [...selected];
    for (const id of ids) {
      const b = await getBook(id);
      if (!b) continue;
      b.tags = mergeTags(b.tags, add, remove);
      await putBook(b);
    }
    closeSheet();
    selected.clear();
    toast("Tags aktualisiert");
    render();
  };
}

async function cycleStatus(id, badgeEl) {
  const b = await getBook(id);
  if (!b) return;
  const idx = STATUSES.findIndex(s => s.id === b.status);
  const next = STATUSES[(idx + 1) % STATUSES.length];
  b.status = next.id;
  if (next.id === "gehoert" && !b.finishDate) {
    b.finishDate = new Date().toISOString().slice(0, 10);
  }
  await putBook(b);
  if (badgeEl) {
    badgeEl.className = `badge ${b.status} tappable`;
    badgeEl.textContent = `${statusLabel(b.status)} ⟳`;
  }
  toast(`Status: ${next.label}`);
  if (state.route !== "library") return;
  if (state.status !== "alle" && state.status !== next.id) render();
  else updateChipCounts(await allBooks());
}

/* ---------- Detail ---------- */

export async function openDetail(id) {
  const b = await getBook(id);
  if (!b) return;
  const coverUrl = b.hasCover ? await getCoverUrl(id) : (b.coverUrl || null);
  const dupes = (await allBooks()).filter(o => o.id !== id && isDup(o, b));
  const sheet = openSheet(`
    <h2>${esc(b.title)}</h2>
    <div class="detail-head">
      ${coverUrl
        ? `<img src="${esc(coverUrl)}" alt="" onerror="this.style.display='none'">`
        : `<div class="cover placeholder" style="width:104px;height:148px;border-radius:8px;font-size:34px">🎧</div>`}
      <div style="flex:1">
        <div style="font-size:13px;color:var(--muted)">${esc(b.author)}</div>
        <div class="bookmeta" style="margin-top:8px">
          <span class="badge ${b.platform}">${esc(platformLabel(b.platform))}</span>
        </div>
        <div class="chiprow" id="d-status" style="margin-top:8px;padding-bottom:0">
          ${STATUSES.map(s => `<button class="chip ${b.status === s.id ? "active" : ""}" data-status="${s.id}">${s.label}</button>`).join("")}
        </div>
        ${dupes.length ? `<div class="warnbox" style="margin-top:10px;font-size:12.5px">⚠ Kommt ${dupes.length}× weiter in deiner Liste vor (${esc(dupes[0].platform)}) – ggf. doppelt.</div>` : ""}
      </div>
    </div>
    ${b.series ? row("Serie", esc(b.series) + (b.seriesInfo ? ` · ${esc(b.seriesInfo)}` : "")) : ""}
    ${b.narrator ? row("Sprecher", esc(b.narrator)) : ""}
    ${b.lengthMin ? row("Länge", fmtHours(b.lengthMin)) : ""}
    ${b.publisher ? row("Verlag", esc(b.publisher)) : ""}
    ${b.pubYear ? row("Erscheinung", esc(b.pubYear)) : ""}
    ${b.isbn ? row("ISBN", esc(b.isbn)) : ""}
    ${b.startDate ? row("Start", fmtDate(b.startDate)) : ""}
    ${b.finishDate ? row("Beendet", fmtDate(b.finishDate)) : ""}
    ${b.rating ? row("Bewertung", stars(b.rating)) : ""}
    <div style="margin:12px 0 4px;display:flex;justify-content:space-between;align-items:center">
      <strong style="font-size:14px">Beschreibung</strong>
      <span class="linklike" id="d-desc-edit">✏️ Bearbeiten / nachladen</span>
    </div>
    <div class="descbox ${b.description ? "" : "empty-desc"}">${b.description ? esc(b.description) : 'Keine Beschreibung vorhanden – über „nachladen“ per ISBN/Titel suchen.'}</div>
    ${b.notes ? row("Notizen", esc(b.notes)) : ""}
    <div style="margin-top:10px">
      <a class="linklike" href="${esc(googleSearchUrl(b))}" target="_blank" rel="noopener noreferrer">🔍 Bei Google suchen</a>
    </div>
    <div class="btnrow" style="margin-top:16px">
      <button class="btn" id="d-cover">🖼 Cover korrigieren</button>
      <button class="btn primary" id="d-edit">✏️ Bearbeiten</button>
      <button class="btn danger" id="d-del">🗑</button>
    </div>
  `);
  sheet.querySelector("#d-desc-edit").onclick = () => openDescriptionEditor(b);
  sheet.querySelectorAll("#d-status .chip").forEach(ch => {
    ch.onclick = async () => {
      if (b.status === ch.dataset.status) return;
      b.status = ch.dataset.status;
      if (b.status === "gehoert" && !b.finishDate) {
        b.finishDate = new Date().toISOString().slice(0, 10);
      }
      await putBook(b);
      sheet.querySelectorAll("#d-status .chip").forEach(c =>
        c.classList.toggle("active", c === ch));
      toast(`Status: ${statusLabel(b.status)}`);
      render();
    };
  });
  sheet.querySelector("#d-cover").onclick = () => openCoverPicker(b);
  sheet.querySelector("#d-edit").onclick = () => { closeSheet(); openBookForm(b); };
  sheet.querySelector("#d-del").onclick = async () => {
    if (!confirm(`„${b.title}" wirklich löschen?`)) return;
    await deleteBook(id);
    closeSheet();
    toast("Gelöscht");
    render();
  };
}

function row(k, v) {
  return `<div class="detail-field"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

function googleSearchUrl(b, images = false) {
  const q = [`"${b.title || ""}"`, b.author ? `"${b.author}"` : "", b.isbn || ""].filter(Boolean).join(" ").trim();
  return `https://www.google.com/search?${images ? "tbm=isch&" : ""}q=${encodeURIComponent(q)}`;
}

/* ---------- Hinzufügen ---------- */

function openAddMenu() {
  const hasScan = barcodeSupported();
  const sheet = openSheet(`
    <h2>Buch hinzufügen</h2>
    <div class="addoptions">
      <button class="addopt" id="opt-search"><span class="ico">🔍</span><span><span class="lbl">Online suchen</span><div class="sub">Titel, Autor oder ISBN – mit Cover</div></span></button>
      <button class="addopt" id="opt-scan" ${hasScan ? "" : "disabled style=\"opacity:.45\""}><span class="ico">📷</span><span><span class="lbl">Barcode / ISBN scannen</span><div class="sub">${hasScan ? "Kamera auf Buchrücken halten" : "Nur mit Kamera-Unterstützung im Browser"}</div></span></button>
      <button class="addopt" id="opt-manual"><span class="ico">✏️</span><span><span class="lbl">Manuell eingeben</span><div class="sub">Ohne Suche, alle Felder frei</div></span></button>
    </div>
  `);
  sheet.querySelector("#opt-search").onclick = openSearchAdd;
  sheet.querySelector("#opt-scan")?.addEventListener("click", () => {
    if (hasScan) openScanAdd();
  });
  sheet.querySelector("#opt-manual").onclick = () => openBookForm(null);
}

async function openSearchAdd() {
  const sheet = openSheet(`
    <h2>Online suchen</h2>
    <input id="s-q" type="search" placeholder="Titel, Autor oder ISBN…" autofocus>
    <div id="s-results"></div>
  `);
  const input = sheet.querySelector("#s-q");
  const out = sheet.querySelector("#s-results");
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { out.innerHTML = ""; return; }
      out.innerHTML = spinner();
      const isIsbn = /^(\d[\d -]{8,16}[\dXx])$/.test(q);
      const results = isIsbn ? await isbnLookup(q.replace(/[\s-]/g, "")) : await searchCombined(q);
      renderSearchResults(out, results);
    }, 350);
  });
  input.focus();
}

function renderSearchResults(out, results) {
  if (!results.length) {
    out.innerHTML = `<div class="empty">Nichts gefunden. Versuche manuell hinzuzufügen.</div>`;
    return;
  }
  let shown = 5;
  const paint = () => {
    const visible = results.slice(0, shown);
    out.innerHTML = `<div class="results">` + visible.map((r, i) => `
      <div class="resultcard" ${!r.coverUrl && r.isbn13 ? `data-isbn="${esc(r.isbn13)}"` : ""}>
        ${r.coverUrl ? `<img class="cover" src="${esc(r.coverUrl)}" loading="lazy" alt="">` : `<div class="cover placeholder">🎧</div>`}
        <div class="bookinfo">
          <div class="t">${esc(r.title)}</div>
          <div class="a">${esc(r.author)}${r.year ? ` · ${r.year}` : ""}${r.series ? ` · <span style="font-style:italic">${esc(r.series)}</span>` : ""}</div>
        </div>
        <button class="minibtn" data-i="${i}">+ Hinzufügen</button>
      </div>`).join("") + `</div>` +
      (results.length > shown
        ? `<button class="btn block" id="s-more" style="margin-top:10px">Weitere ${Math.min(10, results.length - shown)} von ${results.length - shown} laden</button>`
        : "");
    out.querySelectorAll(".minibtn").forEach(btn => {
      btn.onclick = () => openBookForm(null, results[parseInt(btn.dataset.i, 10)]);
    });
    const more = out.querySelector("#s-more");
    if (more) more.onclick = () => { shown += 10; paint(); };
    out.querySelectorAll(".resultcard[data-isbn]").forEach(async card => {
      try {
        const r = results[parseInt(card.querySelector(".minibtn").dataset.i, 10)];
        const url = await coverForIsbn(card.dataset.isbn, r?.title, r?.author);
        if (!url) return;
        const ph = card.querySelector(".cover.placeholder");
        if (ph) {
          ph.outerHTML = `<img class="cover" src="${esc(url)}" loading="lazy" alt="">`;
          const r = results[parseInt(card.querySelector(".minibtn").dataset.i, 10)];
          if (r) r.coverUrl = url;
        }
      } catch {}
    });
  };
  paint();
}

async function openScanAdd() {
  const sheet = openSheet(`
    <h2>Barcode scannen</h2>
    <div class="qrbox"><video id="qr-video" playsinline muted></video></div>
    <p style="color:var(--muted);font-size:13px">ISBN-Barcode oder QR-Code scannen.</p>
    <div class="form-row" style="margin-top:10px"><label>… oder ISBN manuell</label>
      <input id="qr-manual" type="text" inputmode="numeric" placeholder="978…"></div>
    <button class="btn block" id="qr-go">Suchen</button>
  `);
  let stopScan = null;
  const video = sheet.querySelector("#qr-video");
  const handle = async (code) => {
    stopScan?.();
    const isbn = code.replace(/[^0-9Xx]/g, "");
    if (isbn.length < 8) { toast("Keine gültige ISBN erkannt"); return; }
    const results = await isbnLookup(isbn);
    if (results.length) openBookForm(null, results[0]);
    else { toast("ISBN nicht gefunden – bitte manuell eingeben"); openBookForm(null, { title: "", author: "", isbn13: isbn }); }
  };
  try {
    stopScan = await startBarcodeScan(video, handle);
    document.addEventListener("sheetclosed", () => stopScan?.(), { once: true });
  } catch {
    video.parentElement.style.display = "none";
    toast("Kamera nicht verfügbar – ISBN manuell eingeben");
  }
  sheet.querySelector("#qr-go").onclick = () => handle(sheet.querySelector("#qr-manual").value);
}

export function openQuickAdd(result) {
  openBookForm(null, result);
}

export async function openBookForm(existing, result = null) {
  const b = existing ? { ...existing } : {
    id: uid(),
    title: result?.title || "",
    author: result?.author || "",
    narrator: result?.narrator || "",
    series: result?.series || "",
    seriesInfo: "",
    platform: (await guessLastPlatform()) || "bookbeat",
    status: "hoere",
    finishDate: "",
    startDate: new Date().toISOString().slice(0, 10),
    addedDate: new Date().toISOString().slice(0, 10),
    lengthMin: 0,
    pages: 0,
    rating: 0,
    publisher: result?.publisher || "",
    pubYear: result?.year ? String(result.year) : "",
    isbn: result?.isbn13 || "",
    coverUrl: result?.coverUrl || "",
    hasCover: false,
    notes: "",
    tags: "",
    olAuthorKey: result?.olAuthorKey || null,
    createdAt: Date.now()
  };
  if (result && !b.coverUrl) b.coverUrl = result.coverUrl || "";

  const dupes = (await allBooks()).filter(o => !existing || o.id !== existing.id);
  const dup = dupes.find(o => isDup(o, { title: b.title, author: b.author }));

  const sheet = openSheet(`
    <h2>${existing ? "Bearbeiten" : "Neues Buch"}</h2>
    <div id="dupwarn" class="warnbox ${dup ? "" : "hidden"}">⚠ „<span id="dupt"></span>" ist schon in deiner Liste (${dup ? esc(platformLabel(dup.platform)) + ", " + statusLabel(dup.status) : ""}). Doppeltes Hören vermeiden!</div>
    <div class="form-row"><label>Titel *</label><input id="f-title" value="${esc(b.title)}"></div>
    <div class="form-row"><label>Autor</label><input id="f-author" value="${esc(b.author)}"></div>
    <div class="form-row"><label>Sprecher</label><input id="f-narrator" value="${esc(b.narrator)}"></div>
    <div class="form-grid">
      <div class="form-row"><label>Serie</label><input id="f-series" value="${esc(b.series)}"></div>
      <div class="form-row"><label>Teil</label><input id="f-seriesinfo" value="${esc(b.seriesInfo)}"></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Plattform</label>
        <select id="f-platform">${PLATFORMS.map(p => `<option value="${p.id}" ${b.platform === p.id ? "selected" : ""}>${p.label}</option>`).join("")}</select>
      </div>
      <div class="form-row"><label>Status</label>
        <select id="f-status">${STATUSES.map(s => `<option value="${s.id}" ${b.status === s.id ? "selected" : ""}>${s.label}</option>`).join("")}</select>
      </div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Beendet am</label><input id="f-finish" type="date" value="${esc(b.finishDate || "")}"></div>
      <div class="form-row"><label>Länge (min)</label><input id="f-length" type="number" inputmode="numeric" min="0" value="${b.lengthMin || ""}"></div>
    </div>
    <div class="form-row"><label>Bewertung</label>
      <select id="f-rating">${[0, 1, 2, 3, 4, 5].map(n => `<option value="${n}" ${b.rating === n ? "selected" : ""}>${n ? "★".repeat(n) : "– keine –"}</option>`).join("")}</select>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>ISBN</label><input id="f-isbn" inputmode="numeric" value="${esc(b.isbn)}"></div>
      <div class="form-row"><label>Verlag</label><input id="f-publisher" value="${esc(b.publisher)}"></div>
    </div>
    <div class="form-row"><label>Notizen</label><textarea id="f-notes" rows="2">${esc(b.notes)}</textarea></div>
    <div class="form-row"><label>Tags (durch Komma getrennt)</label><input id="f-tags" value="${esc(b.tags || "")}" placeholder="z.B. Krimi, Oslo, Empfehlung"></div>
    ${!existing ? `<div id="coverstatus" style="font-size:12.5px;color:var(--muted);margin-bottom:10px">${b.coverUrl ? "Cover wird geladen…" : "Kein Cover online gefunden – du kannst später in der App danach suchen."}</div>` : ""}
    <div class="btnrow">
      ${result && !existing ? `<button class="btn" id="f-reload">🔄 Neu laden</button>` : ""}
      <button class="btn primary block" id="f-save">💾 Speichern</button>
    </div>
  `);

  const titleInput = sheet.querySelector("#f-title");
  const authorInput = sheet.querySelector("#f-author");
  const checkDup = async () => {
    const others = (await allBooks()).filter(o => o.id !== b.id);
    const d = others.find(o => isDup(o, { title: titleInput.value, author: authorInput.value }));
    const box = sheet.querySelector("#dupwarn");
    if (d) {
      sheet.querySelector("#dupt").textContent = d.title;
      box.classList.remove("hidden");
    } else box.classList.add("hidden");
  };
  titleInput.addEventListener("blur", checkDup);
  authorInput.addEventListener("blur", checkDup);

  const reload = sheet.querySelector("#f-reload");
  if (reload) reload.onclick = async () => {
    reload.textContent = "⏳";
    const results = await searchCombined(`${b.title} ${b.author}`.trim());
    if (results.length) { openBookForm(existing, results[0]); toast("Neu geladen"); }
    else { reload.textContent = "🔄 Nichts gefunden"; }
  };

  sheet.querySelector("#f-save").onclick = async () => {
    b.title = titleInput.value.trim() || b.title;
    b.author = authorInput.value.trim();
    b.narrator = sheet.querySelector("#f-narrator").value.trim();
    b.series = sheet.querySelector("#f-series").value.trim();
    b.seriesInfo = sheet.querySelector("#f-seriesinfo").value.trim();
    b.platform = sheet.querySelector("#f-platform").value;
    b.status = sheet.querySelector("#f-status").value;
    b.finishDate = sheet.querySelector("#f-finish").value
      || (b.status === "gehoert" ? (b.finishDate || new Date().toISOString().slice(0, 10)) : "");
    b.lengthMin = parseInt(sheet.querySelector("#f-length").value, 10) || 0;
    b.rating = parseInt(sheet.querySelector("#f-rating").value, 10) || 0;
    b.isbn = sheet.querySelector("#f-isbn").value.trim().replace(/[^0-9Xx]/g, "");
    b.publisher = sheet.querySelector("#f-publisher").value.trim();
    b.notes = sheet.querySelector("#f-notes").value.trim();
    b.tags = sheet.querySelector("#f-tags").value.trim();
    if (!b.addedDate) b.addedDate = new Date().toISOString().slice(0, 10);
    await putBook(b);
    closeSheet();
    toast("Gespeichert ✓");
    render();
    if (result && !existing && !b.hasCover) {
      fetchAndCacheCover(b);
    }
  };

  if (result && !existing) fetchAndCacheCover(b);
  else if (!existing && b.coverUrl) fetchAndCacheCover(b);
}

async function fetchAndCacheCover(book) {
  try {
    const url = book.coverUrl || await resolveCover(book);
    if (!url) return;
    const ok = await storeCover(book.id, url);
    if (ok) {
      book.coverUrl = book.coverUrl || url;
      book.hasCover = true;
      await putBook(book);
      if (state.route === "library") render();
    }
  } catch {}
}

async function guessLastPlatform() {
  const books = await allBooks();
  const recent = books.filter(b => b.status !== "vormerk").sort((a, b) =>
    (b.finishDate || "").localeCompare(a.finishDate || ""))[0];
  return recent?.platform || null;
}

/* ---------- Cover-/Beschreibungs-Korrektur ---------- */

async function openCoverPicker(book) {
  const sheet = openSheet(`
    <h2>Cover korrigieren</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:10px">Gefundene Cover für „${esc(book.title)}" – antippen zum Übernehmen.</p>
    <div id="cp-body">${spinner()}</div>
    <div class="btnrow">
      <a class="btn" href="${esc(googleSearchUrl(book, true))}" target="_blank" rel="noopener noreferrer" style="text-decoration:none">🖼 Bei Google suchen</a>
      <button class="btn" id="cp-url">🔗 Cover per URL</button>
      <button class="btn" id="cp-search">🔍 Nochmal suchen</button>
    </div>
  `);
  const body = sheet.querySelector("#cp-body");

  const paint = (urls, done) => {
    if (!urls.length) {
      if (done) {
        body.innerHTML = `<div class="empty">Keine Cover gefunden.<br>Tipp: ISBN im Bearbeitungsdialog ergänzen, "Nochmal suchen" nutzen oder Cover-URL einfügen.</div>`;
      }
      return;
    }
    body.innerHTML = `<div class="covergrid">` + urls.map((u, i) =>
      `<img class="covercand" data-i="${i}" src="${esc(u)}" loading="lazy" alt="Kandidat ${i + 1}">`).join("") + `</div>`;
    body.querySelectorAll(".covercand").forEach(img => {
      img.onerror = () => img.style.opacity = ".25";
      img.onclick = async () => {
        const url = urls[parseInt(img.dataset.i, 10)];
        img.style.outline = "3px solid var(--accent)";
        const ok = await storeCover(book.id, url);
        if (ok) {
          book.hasCover = true;
          book.coverUrl = url;
          await putBook(book);
          closeSheet();
          toast("Cover übernommen ✓");
          render();
        } else {
          toast("Cover konnte nicht geladen werden");
          img.style.outline = "";
        }
      };
    });
  };

  const found = [];
  const onFound = (urls) => {
    for (const u of urls) if (!found.includes(u)) found.push(u);
    paint(found, false);
  };
  coverCandidates(book, onFound).then(() => paint(found, true));

  sheet.querySelector("#cp-search").onclick = async (e) => {
    e.target.textContent = "⏳";
    found.length = 0;
    await coverCandidates(book, onFound);
    paint(found, true);
    e.target.textContent = "🔍 Nochmal suchen";
  };
  sheet.querySelector("#cp-url").onclick = async () => {
    const url = prompt("Bild-URL (https://… endet auf .jpg/.png) oder Amazon-/BookBeat-Produktlink:");
    if (!url) return;
    if (!url.startsWith("http")) { toast("Bitte mit https:// beginnen"); return; }
    const resolved = await resolveCoverUrl(url);
    if (!resolved) {
      toast(/amazon\./i.test(url)
        ? "Kein Cover für diesen Amazon-Link gefunden"
        : "Das ist keine direkte Bild-URL. Bitte Bildadresse (endet z.B. auf .jpg) oder Amazon-Produktlink eingeben.");
      return;
    }
    const ok = await storeCover(book.id, resolved);
    if (ok) {
      book.hasCover = true;
      book.coverUrl = resolved;
      await putBook(book);
      closeSheet();
      toast("Cover übernommen ✓");
      render();
    } else toast("Cover konnte nicht geladen werden");
  };
}

async function openDescriptionEditor(book) {
  const sheet = openSheet(`
    <h2>Beschreibung</h2>
    <div class="form-row"><textarea id="de-text" rows="8" placeholder="Beschreibung…">${esc(book.description || "")}</textarea></div>
    <div class="btnrow">
      <button class="btn" id="de-load">🔍 Online nachladen</button>
      <button class="btn primary" id="de-save">💾 Speichern</button>
    </div>
    <div id="de-cands"></div>
  `);
  const text = sheet.querySelector("#de-text");
  const cands = sheet.querySelector("#de-cands");

  sheet.querySelector("#de-save").onclick = async () => {
    book.description = text.value.trim();
    await putBook(book);
    closeSheet();
    toast("Beschreibung gespeichert ✓");
    render();
  };
  sheet.querySelector("#de-load").onclick = async (e) => {
    e.target.textContent = "⏳ Lädt…";
    const list = await descriptionCandidates(book);
    e.target.textContent = "🔍 Online nachladen";
    if (!list.length) {
      cands.innerHTML = `<div class="empty" style="padding:20px">Nichts gefunden – ISBN prüfen oder manuell eingeben.</div>`;
      return;
    }
    cands.innerHTML = `<div class="grouphead">Gefundene Texte – übernehmen:</div>` + list.map((c, i) => `
      <div class="resultcard" style="align-items:flex-start">
        <div class="bookinfo">
          <div class="a" style="margin-bottom:4px">Quelle: ${esc(c.src)}</div>
          <div style="font-size:13.5px;line-height:1.45">${esc(c.text.slice(0, 600))}${c.text.length > 600 ? "…" : ""}</div>
        </div>
        <button class="minibtn" data-i="${i}">✓</button>
      </div>`).join("");
    cands.querySelectorAll(".minibtn").forEach(btn => {
      btn.onclick = () => {
        text.value = list[parseInt(btn.dataset.i, 10)].text;
        text.scrollIntoView({ behavior: "smooth", block: "center" });
      };
    });
  };
}

/* ---------- Automatisches Anreichern nach Import ---------- */

async function enrichBooks(books, onProgress = null, { full = false } = {}) {
  let covers = 0, descs = 0, narrs = 0;
  const queue = books.filter(b =>
    !b.hasCover || (full && b.isbn && (!b.description || !b.narrator)));
  const total = queue.length;
  let done = 0;
  const report = () => { if (onProgress) onProgress({ done, total, covers, descs, narrs }); };
  report();
  const worker = async () => {
    while (queue.length) {
      const b = queue.shift();
      try {
        let meta = null;
        if (full && b.isbn) {
          try { meta = await fetchIsbnMetadata(b.isbn); } catch {}
        }
        if (!b.hasCover) {
          const urls = meta?.coverCandidates?.length
            ? meta.coverCandidates
            : await coverCandidates(b);
          for (const u of urls) {
            if (await storeCover(b.id, u)) {
              b.hasCover = true;
              b.coverUrl = u;
              covers++;
              break;
            }
          }
        }
        if (meta) {
          if (!b.description && meta.description) { b.description = meta.description.trim(); descs++; }
          if (!b.narrator && meta.narrator) { b.narrator = meta.narrator; narrs++; }
          if (!b.publisher && meta.publisher) b.publisher = meta.publisher;
        }
      } catch {}
      done++;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, total) }, worker));
  if (covers || descs || narrs) {
    await bulkPut(books);
    toast([covers ? `${covers} Cover` : "", descs ? `${descs} Beschreibungen` : "", narrs ? `${narrs} Sprecher` : ""]
      .filter(Boolean).join(", ") + " nachgeladen");
    if (state.route === "library" || state.route === "stats") render();
  }
  return { covers, descs, narrs };
}

async function enrichImported(books) {
  const need = books.filter(b =>
    !b.hasCover || (b.isbn && (!b.description || !b.narrator)));
  if (!need.length) return;
  const update = ({ done, total, covers, descs, narrs }) => {
    const statusEl = document.querySelector("#enrich-status");
    if (!statusEl) return;
    statusEl.hidden = false;
    statusEl.querySelector(".enrich-count").textContent =
      `Import-Anreicherung ${done}/${total} · ${covers} Cover · ${descs} Beschreibungen · ${narrs} Sprecher`;
    const bar = statusEl.querySelector(".enrich-bar");
    if (bar) bar.style.width = `${total ? Math.round(done / total * 100) : 100}%`;
  };
  update({ done: 0, total: need.length, covers: 0, descs: 0, narrs: 0 });
  await enrichBooks(books, update, { full: true });
  const statusEl = document.querySelector("#enrich-status");
  if (statusEl) statusEl.hidden = true;
}

/* ---------- Einstellungen ---------- */

async function renderSettings(view) {
  const books = await allBooks();
  view.innerHTML = `
    <h2 style="font-size:16px;margin:6px 0 2px">Import / Export</h2>
    <div class="setrow">
      <div><div class="l">CSV importieren (Openreads / Bookmori)</div><div class="s">CSV-Datei auswählen – Format wird automatisch erkannt; fehlende Cover/Beschreibungen/Sprecher werden direkt mitgeladen</div></div>
      <button class="btn" id="s-import">📥</button>
    </div>
    <div class="setrow">
      <div><div class="l">Als Openreads CSV exportieren</div><div class="s">${books.length} Bücher – inkl. Plattform &amp; Länge</div></div>
      <button class="btn" id="s-export-csv">📤</button>
    </div>
    <div class="setrow">
      <div><div class="l">Backup (JSON) exportieren</div><div class="s">Komplette Sicherung inkl. aller Daten</div></div>
      <button class="btn" id="s-export-json">📤</button>
    </div>
    <div class="setrow">
      <div><div class="l">Backup (JSON) importieren</div><div class="s">Daten aus einer AudioCron-Sicherung wiederherstellen</div></div>
      <button class="btn" id="s-import-json">📥</button>
    </div>

    <h2 style="font-size:16px;margin:22px 0 2px">Covers &amp; Beschreibungen</h2>
    <div class="setrow">
      <div><div class="l">Fehlende Covers nachladen</div><div class="s">Nur für Bücher ohne Bild – parallel per ISBN/OLID/Titel</div></div>
      <button class="btn" id="s-covers">🖼</button>
    </div>
    <div class="enrich-status" id="enrich-status" hidden>
      <div class="enrich-count">Nachgeladen 0/0 …</div>
      <div class="enrich-track"><div class="enrich-bar" id="enrich-bar"></div></div>
    </div>

    <h2 style="font-size:16px;margin:22px 0 2px">Kontingent</h2>
    <div class="setrow">
      <div><div class="l">Stichtag: wieder Kontingent</div><div class="s" id="st-sub">${getStichtag() ? `⏳ Ab ${fmtDate(getStichtag())} · ${stichtagCountdown(getStichtag())} – wird oben in der Bibliothek angezeigt` : "Noch nicht gesetzt – festlegen, ab wann es in der anderen Plattform wieder Kontingent gibt"}</div></div>
      <input type="date" id="s-stichtag" class="date-inline" value="${esc(getStichtag())}">
    </div>

    <h2 style="font-size:16px;margin:22px 0 2px">Suchquellen</h2>
    <p style="color:var(--muted);font-size:12.5px;margin:0 0 8px">Reihenfolge = Priorität in der Ergebnissliste. Covers werden immer automatisch über die ISBN (OpenLibrary, Google Books, Amazon) nachgeladen.</p>
    <div id="src-list">
      ${getSourceConfig().map((c, i, arr) => `
        <div class="setrow">
          <div><div class="l">${esc(sourceLabel(c.id))}</div><div class="s">${c.on ? "aktiv" : "deaktiviert"}</div></div>
          <div style="display:flex;gap:6px">
            <button class="btn" data-src-up="${c.id}" ${i === 0 ? "disabled" : ""}>↑</button>
            <button class="btn" data-src-down="${c.id}" ${i === arr.length - 1 ? "disabled" : ""}>↓</button>
            <button class="btn ${c.on ? "" : "danger"}" data-src-tog="${c.id}">${c.on ? "✓" : "✕"}</button>
          </div>
        </div>`).join("")}
    </div>

    <h2 style="font-size:16px;margin:22px 0 2px">Daten</h2>
    <div class="setrow">
      <div><div class="l">Alle Daten löschen</div><div class="s">Unwiderruflich – erst Export nutzen!</div></div>
      <button class="btn danger" id="s-clear">🗑</button>
    </div>
    <div style="color:var(--muted);font-size:12px;margin-top:24px;text-align:center">
      AudioCron v${APP_VERSION} · Offline-PWA · Daten bleiben nur auf diesem Gerät<br>
      <span id="install-info"></span>
    </div>
    <input type="file" id="file-csv" accept=".csv,text/csv" class="hidden">
    <input type="file" id="file-json" accept=".json,application/json" class="hidden">
  `;

  const fileCsv = view.querySelector("#file-csv");
  const fileJson = view.querySelector("#file-json");

  view.querySelector("#s-import").onclick = () => fileCsv.click();
  fileCsv.onchange = async () => {
    const file = fileCsv.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const result = importOpenreadsCsv(text);
      const imported = result.books;
      if (!imported.length) { toast("Keine Bücher in der CSV gefunden"); return; }
      const existing = await allBooks();
      let skippedDup = 0;
      const fresh = imported.filter(nb => {
        const d = existing.find(o => isDup(o, nb));
        if (d) { skippedDup++; return false; }
        return true;
      });
      await bulkPut(fresh);
      toast(`${fresh.length} importiert${skippedDup ? `, ${skippedDup} Duplikate übersprungen` : ""}${result.skipped ? `, ${result.skipped} gelöscht-Flags übersprungen` : ""}`);
      render();
      enrichImported(fresh);
    } catch (e) {
      toast("Import fehlgeschlagen: " + e.message);
    }
    fileCsv.value = "";
  };

  view.querySelector("#s-export-csv").onclick = async () => {
    const all = await allBooks();
    if (!all.length) { toast("Keine Daten"); return; }
    download(`AudioCron-openreads-${new Date().toISOString().slice(0, 10)}.csv`,
      exportOpenreadsCsv(all), "text/csv;charset=utf-8");
  };

  view.querySelector("#s-export-json").onclick = async () => {
    const all = await allBooks();
    download(`AudioCron-backup-${new Date().toISOString().slice(0, 10)}.json`,
      exportJson(all), "application/json");
  };

  view.querySelector("#s-import-json").onclick = () => fileJson.click();
  fileJson.onchange = async () => {
    const file = fileJson.files[0];
    if (!file) return;
    try {
      const list = importJson(await file.text());
      await bulkPut(list);
      toast(`${list.length} Bücher wiederhergestellt`);
      render();
    } catch (e) {
      toast("Import fehlgeschlagen: " + e.message);
    }
    fileJson.value = "";
  };

  const moveSource = (id, dir) => {
    const cfg = getSourceConfig();
    const i = cfg.findIndex(x => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cfg.length) return;
    [cfg[i], cfg[j]] = [cfg[j], cfg[i]];
    setSourceConfig(cfg);
    renderSettings(view);
  };
  view.querySelectorAll("[data-src-up]").forEach(btn => btn.onclick = () => moveSource(btn.dataset.srcUp, -1));
  view.querySelectorAll("[data-src-down]").forEach(btn => btn.onclick = () => moveSource(btn.dataset.srcDown, 1));
  view.querySelectorAll("[data-src-tog]").forEach(btn => btn.onclick = () => {
    const cfg = getSourceConfig();
    const c = cfg.find(x => x.id === btn.dataset.srcTog);
    if (!c) return;
    c.on = !c.on;
    setSourceConfig(cfg);
    renderSettings(view);
  });

  view.querySelector("#s-covers").onclick = async (e) => {
    const btn = e.target;
    const all = await allBooks();
    const missing = all.filter(b => !b.hasCover);
    if (!missing.length) { toast("Alle Bücher haben ein Cover"); return; }
    const statusEl = view.querySelector("#enrich-status");
    const barEl = view.querySelector("#enrich-bar");
    btn.disabled = true;
    btn.textContent = "⏳";
    statusEl.hidden = false;
    const update = ({ done, total, covers }) => {
      const count = `Nachgeladen ${done}/${total} · ${covers} Cover`;
      statusEl.querySelector(".enrich-count").textContent = count;
      barEl.style.width = `${total ? Math.round(done / total * 100) : 100}%`;
    };
    update({ done: 0, total: missing.length, covers: 0 });
    const { covers } = await enrichBooks(missing, update);
    btn.disabled = false;
    btn.textContent = "🖼";
    statusEl.hidden = true;
    barEl.style.width = "0";
    if (!covers) toast("Online nichts neues gefunden");
    render();
  };

  view.querySelector("#s-stichtag").onchange = e => {
    const v = e.target.value;
    setStichtag(v);
    const sub = view.querySelector("#st-sub");
    sub.textContent = v
      ? `⏳ Ab ${fmtDate(v)} · ${stichtagCountdown(v)} – wird oben in der Bibliothek angezeigt`
      : "Noch nicht gesetzt – festlegen, ab wann es in der anderen Plattform wieder Kontingent gibt";
    toast(v ? `Stichtag: ${fmtDate(v)} ✓` : "Stichtag entfernt");
  };

  view.querySelector("#s-clear").onclick = async () => {
    if (!confirm("ALLE Bücher und Covers wirklich löschen?")) return;
    if (!confirm("Wirklich? Das kann nicht rückgängig gemacht werden.")) return;
    await clearAll();
    toast("Alle Daten gelöscht");
    render();
  };

  if (deferredPrompt) {
    view.querySelector("#install-info").innerHTML =
      `<span class="linklike" id="do-install">App auf Startbildschirm installieren</span>`;
    document.getElementById("do-install").onclick = installApp;
  }
}

/* ---------- PWA Install + Service Worker ---------- */

let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
});
async function installApp() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
}

if ("serviceWorker" in navigator) {
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
      .then(reg => {
        reg.update();
        setInterval(() => reg.update(), 60 * 60 * 1000);
      })
      .catch(err => console.warn("SW-Registrierung fehlgeschlagen", err));
  });
}

/* ---------- Init ---------- */

document.getElementById("bottomnav").addEventListener("click", e => {
  const btn = e.target.closest(".nav-btn");
  if (btn) navigate(btn.dataset.route);
});
document.getElementById("fab").addEventListener("click", openAddMenu);

render();
