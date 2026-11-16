import { uid, norm } from "./db.js";

export const OPENREADS_COLUMNS = [
  "Book-Title", "Author", "Narrator", "Series", "Series info", "Pages",
  "Format", "Publisher", "Publication date", "Edition language", "ASIN",
  "ISBN13", "Cover", "Goodreads Rating", "My Rating", "State",
  "Date started", "Date finished", "Date added", "Pages Current", "Percent",
  "Country", "Tags", "Notes", "Description", "Length (min)", "AudioCron-Plattform"
];

const STATE_TO_OPENREADS = { gehoert: "Finished", hoere: "Reading", vormerk: "Unread" };
const STATE_FROM_OPENREADS = {
  finished: "gehoert", reading: "hoere", abandoned: "gehoert",
  unread: "vormerk", "to-read": "vormerk"
};

function parseCsv(text) {
  text = text.replace(/^\uFEFF/, "");
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

function findCol(headers, ...candidates) {
  const low = headers.map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  for (const c of candidates) {
    const needle = c.toLowerCase().replace(/[^a-z0-9]/g, "");
    const idx = low.findIndex(h => h === needle);
    if (idx !== -1) return idx;
  }
  for (const c of candidates) {
    const needle = c.toLowerCase().replace(/[^a-z0-9]/g, "");
    const idx = low.findIndex(h => h.includes(needle));
    if (idx !== -1) return idx;
  }
  return -1;
}

export function parseDate(s) {
  if (!s) return null;
  s = s.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

function parseNum(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function importOpenreadsCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { books: [], added: 0, skipped: 0 };
  const h = rows[0];
  const low = h.map(x => x.toLowerCase());
  if (low.includes("readings") || low.includes("book_format") || low.includes("olid")) {
    return importBookmoriCsv(rows);
  }
  return importOpenreadsFormat(rows);
}

function detectPlatform(...vals) {
  const s = vals.filter(Boolean).join(" ").toLowerCase();
  if (s.includes("bookbeat")) return "bookbeat";
  if (s.includes("borrow")) return "borrowbox";
  return null;
}

function importBookmoriCsv(rows) {
  const h = rows[0];
  const col = {
    title: h.findIndex(x => x.toLowerCase() === "title"),
    subtitle: h.findIndex(x => x.toLowerCase() === "subtitle"),
    author: h.findIndex(x => x.toLowerCase() === "author"),
    description: h.findIndex(x => x.toLowerCase() === "description"),
    status: h.findIndex(x => x.toLowerCase() === "status"),
    favourite: h.findIndex(x => x.toLowerCase() === "favourite"),
    deleted: h.findIndex(x => x.toLowerCase() === "deleted"),
    rating: h.findIndex(x => x.toLowerCase() === "rating"),
    pages: h.findIndex(x => x.toLowerCase() === "pages"),
    pubYear: h.findIndex(x => x.toLowerCase() === "publication_year"),
    isbn: h.findIndex(x => x.toLowerCase() === "isbn"),
    olid: h.findIndex(x => x.toLowerCase() === "olid"),
    tags: h.findIndex(x => x.toLowerCase() === "tags"),
    myReview: h.findIndex(x => x.toLowerCase() === "my_review"),
    notes: h.findIndex(x => x.toLowerCase() === "notes"),
    format: h.findIndex(x => x.toLowerCase() === "book_format"),
    readings: h.findIndex(x => x.toLowerCase() === "readings"),
    dateAdded: h.findIndex(x => x.toLowerCase() === "date_added"),
    dateModified: h.findIndex(x => x.toLowerCase() === "date_modified")
  };
  const get = (row, i) => (i >= 0 && row[i] != null) ? row[i].trim() : "";
  const now = new Date().toISOString().slice(0, 10);
  const books = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const title = get(row, col.title);
    if (!title) continue;
    if (get(row, col.deleted).toLowerCase() === "true") { skipped++; continue; }
    const tags = get(row, col.tags);
    const platform = detectPlatform(get(row, col.tags), get(row, col.notes)) || "andere";
    const stateRaw = get(row, col.status).toLowerCase();
    let status = STATE_FROM_OPENREADS[stateRaw] || (stateRaw === "reading" ? "hoere" : "vormerk");
    let startDate = "", finishDate = "";
    const readings = get(row, col.readings);
    if (readings) {
      const parts = readings.split("|").filter(Boolean);
      const starts = [], finishes = [];
      for (let i = 0; i < parts.length; i += 2) {
        const s = parseDate(parts[i]);
        const f = parseDate(parts[i + 1]);
        if (s) starts.push(s);
        if (f) finishes.push(f);
      }
      startDate = starts[0] || "";
      finishDate = finishes.sort().pop() || "";
    }
    if (!finishDate && status === "gehoert") finishDate = parseDate(get(row, col.dateAdded)) || "";
    const notes = get(row, col.notes) || get(row, col.myReview);
    books.push({
      id: uid(),
      title,
      subtitle: get(row, col.subtitle),
      author: get(row, col.author),
      narrator: "",
      series: "",
      seriesInfo: "",
      platform,
      status,
      finishDate,
      startDate,
      addedDate: parseDate(get(row, col.dateAdded)) || now,
      lengthMin: 0,
      pages: Math.round(parseNum(get(row, col.pages)) || 0),
      percent: null,
      rating: Math.round(parseNum(get(row, col.rating)) || 0),
      publisher: "",
      pubYear: get(row, col.pubYear),
      isbn: get(row, col.isbn).replace(/[^0-9Xx]/g, ""),
      olid: get(row, col.olid),
      coverUrl: "",
      hasCover: false,
      description: get(row, col.description),
      notes,
      tags,
      favourite: get(row, col.favourite).toLowerCase() === "true",
      bookFormat: get(row, col.format),
      importSource: "bookmori",
      createdAt: Date.now()
    });
  }
  return { books, added: books.length, skipped, format: "bookmori" };
}

function importOpenreadsFormat(rows) {
  const h = rows[0];
  const col = {
    title: findCol(h, "booktitle", "title"),
    author: findCol(h, "author"),
    narrator: findCol(h, "narrator", "readby"),
    series: findCol(h, "series"),
    seriesInfo: findCol(h, "seriesinfo"),
    pages: findCol(h, "pages"),
    format: findCol(h, "format"),
    publisher: findCol(h, "publisher"),
    pubDate: findCol(h, "publicationdate"),
    isbn13: findCol(h, "isbn13", "isbn"),
    cover: findCol(h, "cover"),
    myRating: findCol(h, "myrating"),
    state: findCol(h, "state"),
    dateStarted: findCol(h, "datestarted"),
    dateFinished: findCol(h, "datefinished"),
    dateAdded: findCol(h, "dateadded"),
    percent: findCol(h, "percent"),
    tags: findCol(h, "tags"),
    notes: findCol(h, "notes"),
    length: findCol(h, "lengthmin", "length", "duration", "runtime"),
    platform: findCol(h, "AudioCronplattform", "plattform", "platform")
  };
  const get = (row, i) => (i >= 0 && row[i] != null) ? row[i].trim() : "";
  const now = new Date().toISOString().slice(0, 10);
  const books = [];
  for (const row of rows.slice(1)) {
    const title = get(row, col.title);
    if (!title) continue;
    const tags = get(row, col.tags);
    const tagsLower = tags.toLowerCase();
    let platform = get(row, col.platform).toLowerCase();
    if (platform.includes("bookbeat")) platform = "bookbeat";
    else if (platform.includes("borrow")) platform = "borrowbox";
    else if (tagsLower.includes("bookbeat")) platform = "bookbeat";
    else if (tagsLower.includes("borrow")) platform = "borrowbox";
    else platform = "andere";
    const stateRaw = get(row, col.state).toLowerCase();
    let status = STATE_FROM_OPENREADS[stateRaw] || "vormerk";
    const percent = parseNum(get(row, col.percent));
    if (status === "vormerk" && percent && percent >= 100) status = "gehoert";
    const isbn = get(row, col.isbn13) || get(row, col.isbn13);
    books.push({
      id: uid(),
      title,
      author: get(row, col.author),
      narrator: get(row, col.narrator),
      series: get(row, col.series),
      seriesInfo: get(row, col.seriesInfo),
      platform,
      status,
      finishDate: parseDate(get(row, col.dateFinished)),
      startDate: parseDate(get(row, col.dateStarted)),
      addedDate: parseDate(get(row, col.dateAdded)) || now,
      lengthMin: Math.round(parseNum(get(row, col.length)) || 0),
      pages: Math.round(parseNum(get(row, col.pages)) || 0),
      percent: percent ?? null,
      rating: Math.round(parseNum(get(row, col.myRating)) || 0),
      publisher: get(row, col.publisher),
      pubYear: parseDate(get(row, col.pubDate))?.slice(0, 4) || "",
      isbn: isbn.replace(/[^0-9Xx]/g, ""),
      coverUrl: get(row, col.cover),
      hasCover: false,
      notes: get(row, col.notes),
      tags,
      importSource: "openreads",
      createdAt: Date.now()
    });
  }
  return { books, added: books.length, skipped: 0 };
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportOpenreadsCsv(books) {
  const lines = [OPENREADS_COLUMNS.join(",")];
  for (const b of books) {
    const row = [
      b.title || "",
      b.author || "",
      b.narrator || "",
      b.series || "",
      b.seriesInfo || "",
      b.pages || "",
      "Audiobook",
      b.publisher || "",
      b.pubYear || "",
      "de",
      "",
      b.isbn || "",
      b.coverUrl || "",
      "",
      b.rating || "",
      STATE_TO_OPENREADS[b.status] || "Unread",
      b.startDate || "",
      b.finishDate || "",
      b.addedDate || "",
      "",
      b.status === "gehoert" ? "100" : (b.percent ?? ""),
      "Germany",
      b.tags || "",
      b.notes || "",
      b.description || "",
      b.lengthMin || "",
      b.platform || ""
    ];
    lines.push(row.map(csvEscape).join(","));
  }
  return "\uFEFF" + lines.join("\r\n");
}

export function exportJson(books) {
  return JSON.stringify({ app: "AudioCron", version: 1, exportedAt: new Date().toISOString(), books }, null, 2);
}

export function importJson(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.books;
  if (!Array.isArray(list)) throw new Error("Ungültiges JSON");
  for (const b of list) if (!b.id) b.id = uid();
  return list;
}
