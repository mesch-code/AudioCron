import { allBooks, getCoverUrl } from "./db.js";
import { fetchWorksByAuthor } from "./api.js";
import { esc, fmtHours, openSheet, closeSheet, toast, platformLabel, statusLabel, spinner } from "./ui.js";

const PL_COLORS = { bookbeat: "pl-bookbeat", borrowbox: "pl-borrowbox", andere: "" };

const STAT_SORT = {
  autoren: [
    ["menge", "Häufigkeit"],
    ["name", "Name A–Z"],
    ["zeit", "Hörzeit"]
  ],
  sprecher: [
    ["menge", "Häufigkeit"],
    ["name", "Name A–Z"],
    ["zeit", "Hörzeit"]
  ],
  monate: [
    ["datum-alt", "Ältester zuerst"],
    ["datum-neu", "Neuester zuerst"],
    ["menge", "Häufigkeit"]
  ]
};

let statTab = "autoren";
let statSort = {};

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
      <button class="chip ${statTab === "autoren" ? "active" : ""}" data-tab="autoren">Autoren</button>
      <button class="chip ${statTab === "sprecher" ? "active" : ""}" data-tab="sprecher">Sprecher</button>
      <button class="chip ${statTab === "monate" ? "active" : ""}" data-tab="monate">Monate</button>
    </div>
    <div class="searchbar"><select id="stat-sort"></select></div>
    <div id="stat-content"></div>`;

  const tabs = view.querySelector("#stat-tabs");
  const sortSel = view.querySelector("#stat-sort");

  const paintSortOptions = () => {
    const opts = STAT_SORT[statTab];
    if (!statSort[statTab]) statSort[statTab] = opts[0][0];
    sortSel.innerHTML = opts.map(([v, l]) =>
      `<option value="${v}" ${statSort[statTab] === v ? "selected" : ""}>Sortierung: ${l}</option>`).join("");
  };

  tabs.addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    tabs.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    statTab = chip.dataset.tab;
    paintSortOptions();
    renderTab(statTab, listened);
  });
  sortSel.addEventListener("change", () => {
    statSort[statTab] = sortSel.value;
    renderTab(statTab, listened);
  });
  paintSortOptions();
  renderTab(statTab, listened);
}

function groupHours(g) {
  return g.books.reduce((s, b) => s + (b.lengthMin || 0), 0);
}

function sortGroups(groups, sort) {
  const byName = (a, b) => a.key.localeCompare(b.key, "de");
  if (sort === "name") return groups.sort(byName);
  if (sort === "zeit") return groups.sort((a, b) => groupHours(b) - groupHours(a) || byName(a, b));
  if (sort === "datum-neu") return groups.sort((a, b) => b.key.localeCompare(a.key));
  if (sort === "datum-alt") return groups.sort((a, b) => a.key.localeCompare(b.key));
  return groups.sort((a, b) => b.count - a.count || byName(a, b));
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
  groups = sortGroups(groups, statSort[tab] || STAT_SORT[tab][0][0]);
  const max = Math.max(...groups.map(g => (statSort[tab] === "zeit" ? groupHours(g) : g.count)), 1);
  el.innerHTML = `<div class="barlist">` + groups.map(g => {
    const label = tab === "monate" ? fmtMonth(g.key) : g.key;
    const value = statSort[tab] === "zeit" ? groupHours(g) : g.count;
    const valueLabel = statSort[tab] === "zeit" ? fmtHours(value) : value;
    const clickable = tab !== "monate";
    return `<div class="barrow" ${clickable ? `data-key="${esc(g.key)}"` : ""}>
      <div class="lbl">${esc(label)}</div>
      <div class="track"><div class="fill" style="width:${Math.max(8, Math.round(value / max * 100))}%">${esc(valueLabel)}</div></div>
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
  return [...map.entries()].map(([key, bs]) => ({ key, count: bs.length, books: bs }));
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
  hydrateCovers(sheet);
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
    sheet.innerHTML = `<h2>${esc(authorName)} – alle Werke</h2>
      <div class="empty">Keine Werke online gefunden.<br>Prüfe die Internetverbindung.</div>`;
    return;
  }
  const mineTitles = mine.map(b => norm(b.title)).filter(Boolean);
  const mineIsbn = new Set(mine.map(b => b.isbn).filter(Boolean));
  const rows = works.slice(0, 60).map((w, i) => {
    const ownedBook = findOwned(w, mine, mineTitles, mineIsbn);
    const year = w.year ? ` (${w.year})` : "";
    const cover = w.coverUrl
      ? `<img class="cover" src="${esc(w.coverUrl)}" loading="lazy" alt="">`
      : ownedBook?.hasCover
        ? `<img class="cover" data-coverid="${ownedBook.id}" src="" alt="">`
        : `<div class="cover placeholder">🎧</div>`;
    return `<div class="resultcard">
      ${cover}
      <div class="bookinfo"><div class="t">${esc(w.title)}${esc(year)}</div>
      <div class="a">${esc(w.subtitle || "")}</div></div>
      <button class="minibtn ${ownedBook ? "done" : ""}" data-i="${i}" ${ownedBook ? "disabled" : ""}>${ownedBook ? "✓ gehört" : "+ fehlt"}</button>
    </div>`;
  }).join("");
  sheet.innerHTML = `<h2>${esc(authorName)} – alle Werke</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:10px">✓ = schon gehört. Mit „+ fehlt" schnell als vorgemerkt oder gehört anlegen.</p>
    <div class="results">${rows}</div>`;
  hydrateCovers(sheet);
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

function isOwned(work, mineTitles, mineIsbn) {
  if (work.isbn13 && mineIsbn.has(work.isbn13)) return true;
  const wt = norm(work.title);
  if (!wt) return false;
  return mineTitles.some(mt =>
    mt === wt ||
    (mt.length >= 8 && (mt.includes(wt) || (wt.length >= 8 && wt.includes(mt)))));
}

function findOwned(work, mine, mineTitles, mineIsbn) {
  return mine.find(b => {
    if (work.isbn13 && b.isbn && work.isbn13 === b.isbn) return true;
    const wt = norm(work.title);
    const bt = norm(b.title);
    if (!wt || !bt) return false;
    return wt === bt ||
      (bt.length >= 8 && (bt.includes(wt) || (wt.length >= 8 && wt.includes(bt))));
  }) || null;
}

export { hydrateCovers, coverImg };
