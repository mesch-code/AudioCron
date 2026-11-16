import { allBooks, getCoverUrl } from "./db.js";
import { fetchWorksByAuthor } from "./api.js";
import { esc, fmtHours, openSheet, closeSheet, toast, platformLabel, statusLabel, spinner } from "./ui.js";

const PL_COLORS = { bookbeat: "pl-bookbeat", borrowbox: "pl-borrowbox", andere: "" };

export async function renderStats(view) {
  const books = await allBooks();
  const listened = books.filter(b => b.status === "gehoert");
  const totalMin = listened.reduce((s, b) => s + (b.lengthMin || 0), 0);
  const authors = new Set(listened.map(b => b.author).filter(Boolean));
  const narrators = new Set(listened.map(b => b.narrator).filter(Boolean));

  view.innerHTML = `
    <div class="statgrid">
      <div class="statcard"><div class="n">${listened.length}</div><div class="l">gehörte Bücher</div></div>
      <div class="statcard"><div class="n">${fmtHours(totalMin)}</div><div class="l">Hörzeit gesamt</div></div>
      <div class="statcard"><div class="n">${authors.size}</div><div class="l">Autoren</div></div>
      <div class="statcard"><div class="n">${books.filter(b => b.status === "hoere").length}</div><div class="l">aktuell am Hören</div></div>
    </div>
    <div class="chiprow" id="stat-tabs">
      <button class="chip active" data-tab="autoren">Autoren</button>
      <button class="chip" data-tab="sprecher">Sprecher</button>
      <button class="chip" data-tab="monate">Monate</button>
    </div>
    <div id="stat-content"></div>`;

  const tabs = view.querySelector("#stat-tabs");
  tabs.addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    tabs.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    renderTab(chip.dataset.tab, listened);
  });
  renderTab("autoren", listened);
}

function renderTab(tab, listened) {
  const el = document.getElementById("stat-content");
  let groups;
  if (tab === "autoren") {
    groups = groupCount(listened, b => b.author);
  } else if (tab === "sprecher") {
    groups = groupCount(listened, b => b.narrator);
  } else {
    groups = groupCount(listened, b => (b.finishDate || "").slice(0, 7));
  }
  if (!groups.length) {
    el.innerHTML = `<div class="empty"><div class="big">📊</div>Noch keine gehörten Bücher.</div>`;
    return;
  }
  const max = groups[0].count;
  el.innerHTML = `<div class="barlist">` + groups.map(g => {
    const label = tab === "monate" ? fmtMonth(g.key) : g.key;
    const hours = g.books.reduce((s, b) => s + (b.lengthMin || 0), 0);
    const clickable = tab !== "monate";
    return `<div class="barrow" ${clickable ? `data-key="${esc(g.key)}"` : ""}>
      <div class="lbl">${esc(label)}</div>
      <div class="track"><div class="fill" style="width:${Math.max(8, Math.round(g.count / max * 100))}%">${g.count}</div></div>
    </div>`;
  }).join("") + `</div>`;
  if (tab !== "monate") {
    el.querySelectorAll(".barrow").forEach(row => {
      row.addEventListener("click", () => openGroupSheet(tab, row.dataset.key));
    });
  }
}

function groupCount(books, keyFn) {
  const map = new Map();
  for (const b of books) {
    const k = (keyFn(b) || "").trim();
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(b);
  }
  return [...map.entries()]
    .map(([key, bs]) => ({ key, count: bs.length, books: bs }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, "de"));
}

function fmtMonth(ym) {
  if (!ym) return "ohne Datum";
  const [y, m] = ym.split("-");
  const names = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
  return `${names[parseInt(m, 10) - 1]} ${y}`;
}

async function openGroupSheet(kind, key) {
  const books = await allBooks();
  const mine = books.filter(b => b.status === "gehoert" &&
    ((kind === "autoren" && b.author === key) || (kind === "sprecher" && b.narrator === key)));
  const title = kind === "autoren" ? key : `Sprecher: ${key}`;
  const sheet = openSheet(`
    <h2>${esc(title)}</h2>
    <p style="color:var(--muted);font-size:13.5px;margin-bottom:12px">${mine.length} gehörte${kind === "autoren" ? " Bücher von diesem Autor" : " Bücher"} · ${fmtHours(mine.reduce((s, b) => s + (b.lengthMin || 0), 0))}</p>
    <div class="booklist">${mine.map(b => `
      <div class="bookcard" data-book="${b.id}">
        ${coverImg(b)}
        <div class="bookinfo">
          <div class="t">${esc(b.title)}</div>
          <div class="a">${esc(b.narrator || b.series || "")}</div>
          <div class="bookmeta"><span class="badge ${b.platform}">${esc(platformLabel(b.platform))}</span>${b.finishDate ? `<span style="color:var(--muted);font-size:11.5px">${b.finishDate}</span>` : ""}</div>
        </div>
      </div>`).join("")}
    </div>
    ${kind === "autoren" ? `<div class="btnrow" style="margin-top:14px">
      <button class="btn block" id="discover-author">🔍 Weitere Werke von ${esc(key)} suchen</button>
    </div>` : ""}
  `);
  sheet.querySelectorAll(".bookcard").forEach(c => {
    c.addEventListener("click", async () => {
      closeSheet();
      const { openDetail } = await import("./app.js");
      openDetail(c.dataset.book);
    });
  });
  const disc = sheet.querySelector("#discover-author");
  if (disc) disc.addEventListener("click", () => openDiscover(key, mine));
}

function coverImg(b) {
  return b.hasCover
    ? `<img class="cover" data-coverid="${b.id}" src="" alt="">`
    : `<div class="cover placeholder">🎧</div>`;
}

async function hydrateCovers(root) {
  for (const img of root.querySelectorAll("img.cover[data-coverid]")) {
    const url = await getCoverUrl(img.dataset.coverid);
    if (url) img.src = url;
  }
}

async function openDiscover(authorName, mine) {
  const sheet = openSheet(`<h2>${esc(authorName)} – alle Werke</h2>${spinner()}`);
  const olKey = mine.find(b => b.olAuthorKey)?.olAuthorKey || null;
  let works = [];
  try { works = await fetchWorksByAuthor(authorName, olKey); } catch {}
  if (!works.length) {
    sheet.innerHTML = `<div class="sheet-grip"></div><h2>${esc(authorName)} – alle Werke</h2>
      <div class="empty">Keine Werke online gefunden.<br>Prüfe die Internetverbindung.</div>`;
    return;
  }
  const mineKeys = new Set(mine.map(b => norm(b.title)));
  const rows = works.slice(0, 60).map((w, i) => {
    const owned = mineKeys.has(w.title);
    const year = w.year ? ` (${w.year})` : "";
    return `<div class="resultcard">
      <div class="bookinfo"><div class="t">${esc(w.title)}${esc(year)}</div>
      <div class="a">${esc(w.subtitle || "")}</div></div>
      <button class="minibtn ${owned ? "done" : ""}" data-i="${i}" ${owned ? "disabled" : ""}>${owned ? "✓ gehört" : "+ fehlt"}</button>
    </div>`;
  }).join("");
  sheet.innerHTML = `<div class="sheet-grip"></div><h2>${esc(authorName)} – alle Werke</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:10px">✓ = schon gehört. Mit „+ fehlt" schnell als vorgemerkt oder gehört anlegen.</p>
    <div class="results">${rows}</div>`;
  sheet.querySelectorAll(".minibtn:not([disabled])").forEach(btn => {
    btn.addEventListener("click", async () => {
      const w = works[parseInt(btn.dataset.i, 10)];
      const { openQuickAdd } = await import("./app.js");
      openQuickAdd(w);
    });
  });
}

function norm(s) {
  return (s || "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
}

export { hydrateCovers, coverImg };
