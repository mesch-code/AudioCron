import { norm } from "./db.js";

const OL = "https://openlibrary.org";

function olHeaders() {
  return { "Accept": "application/json" };
}

function mapOlResult(d) {
  const coverUrl = d.cover_i
    ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`
    : null;
  const first = (arr) => Array.isArray(arr) && arr.length ? arr[0] : null;
  return {
    source: "openlibrary",
    key: d.key,
    title: d.title || "",
    subtitle: d.subtitle || "",
    author: first(d.author_name) || "",
    authors: d.author_name || [],
    narrator: "",
    series: first(d.series) || "",
    publisher: first(d.publisher) || "",
    year: d.first_publish_year || null,
    isbn13: first(d.isbn) || "",
    coverUrl,
    rating: null,
    pages: d.number_of_pages_median || null,
    olAuthorKey: first(d.author_key) || null,
    languages: d.language || []
  };
}

function isGermanResult(r) {
  if (r.source === "googlebooks") return true;
  const langs = r.languages || [];
  return langs.includes("ger") || langs.includes("de");
}

export async function searchBooks(query, { isbn = false, lang = null } = {}) {
  const fields = "key,title,subtitle,author_name,author_key,cover_i,first_publish_year,isbn,publisher,series,number_of_pages_median,language";
  const langParam = lang ? `&language=${encodeURIComponent(lang)}` : "";
  const url = isbn
    ? `${OL}/search.json?q=isbn:${encodeURIComponent(query)}&limit=10&fields=${fields}`
    : `${OL}/search.json?q=${encodeURIComponent(query)}${langParam}&limit=15&fields=${fields}`;
  try {
    const res = await fetch(url, { headers: olHeaders() });
    if (!res.ok) throw new Error("OL " + res.status);
    const data = await res.json();
    return (data.docs || []).map(mapOlResult);
  } catch (e) {
    console.warn("OpenLibrary-Suche fehlgeschlagen", e);
    return [];
  }
}

function gbCover(v) {
  if (!v.imageLinks) return null;
  const u = v.imageLinks.large || v.imageLinks.medium || v.imageLinks.thumbnail ||
    v.imageLinks.small || v.imageLinks.smallThumbnail;
  return u ? u.replace("http:", "https:").replace("&zoom=1", "&zoom=3") : null;
}

function gbAllCovers(it) {
  const v = it.volumeInfo || {};
  const out = [];
  const links = v.imageLinks || {};
  for (const key of ["large", "medium", "thumbnail", "small", "smallThumbnail"]) {
    const u = links[key];
    if (u) out.push(u.replace("http:", "https:"));
  }
  if (v.canonicalVolumeLink && links.thumbnail) {
    out.push(`https://books.google.com/books/content?id=${encodeURIComponent(it.id)}&zoom=2&img=1`);
  }
  return out;
}

async function gbSearch(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("GB " + res.status);
    const data = await res.json();
    return (data.items || []).map(it => {
      const v = it.volumeInfo || {};
      const id = (v.industryIdentifiers || []).find(i => i.type === "ISBN_13")?.identifier
        || (v.industryIdentifiers || [])[0]?.identifier || "";
      return {
        source: "googlebooks",
        key: it.id,
        title: v.title || "",
        subtitle: v.subtitle || "",
        author: (v.authors || [])[0] || "",
        authors: v.authors || [],
        narrator: "",
        series: "",
        publisher: v.publisher || "",
        year: v.publishedDate ? parseInt(v.publishedDate.slice(0, 4), 10) || null : null,
        isbn13: id,
        coverUrl: gbCover(v),
        rating: v.averageRating || null,
        pages: v.pageCount || null,
        olAuthorKey: null
      };
    });
  } catch (e) {
    console.warn("Google-Books-Suche fehlgeschlagen", e);
    return [];
  }
}

export async function searchGoogle(query, { audio = false } = {}) {
  const base = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=15&country=DE&hl=de&langRestrict=de`;
  let results = await gbSearch(base + (audio ? "&filter=audiobooks" : ""));
  if (!results.length && audio) results = await gbSearch(base);
  return results;
}

export async function searchGermanAudiobooks(query) {
  const audio = await searchGoogle(query, { audio: true });
  if (audio.length) return audio;
  if (!/hörbuch|hoerbuch/i.test(query)) {
    const withKw = await searchGoogle(`${query} hörbuch`, { audio: false });
    if (withKw.length) return withKw;
  }
  return searchGoogle(query);
}

export async function searchLobid(query, limit = 15) {
  const url = `https://lobid.org/resources/search?q=${encodeURIComponent(query)}&size=${limit}`;
  try {
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error("lobid " + res.status);
    const data = await res.json();
    const one = (v) => Array.isArray(v) ? (v.length ? v[0] : "") : (v || "");
    return (data.member || []).map(m => {
      const isbns = (m.isbn || []).map(s => String(s).replace(/[^0-9Xx]/g, ""));
      const years = (m.publication || [])
        .map(p => parseInt(p.startDate, 10))
        .filter(n => !isNaN(n));
      const contribs = (m.contribution || [])
        .map(c => c.agent && c.agent.label ? c.agent.label : null)
        .filter(Boolean);
      const langs = (m.language || []).map(l => l.id || l.label || "");
      return {
        source: "lobid",
        key: String(m.id || "").replace(/#!$/, ""),
        title: one(m.title),
        subtitle: one(m.otherTitleInformation),
        author: contribs[0] || "",
        authors: contribs,
        narrator: "",
        series: "",
        publisher: "",
        year: years[0] || null,
        isbn13: isbns.find(s => s.length === 13) || isbns[0] || "",
        coverUrl: null,
        rating: null,
        pages: null,
        olAuthorKey: null,
        languages: langs.length ? langs : ["de"]
      };
    }).filter(r => r.title);
  } catch (e) {
    console.warn("lobid-Suche fehlgeschlagen", e);
    return [];
  }
}

function decodeXml(s) {
  return String(s)
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (m, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function splitDnbTitle(full) {
  let series = "";
  let author = "";
  let subtitle = "";
  let main = full.trim();
  const slash = main.indexOf(" / ");
  if (slash !== -1) {
    author = main.slice(slash + 3).trim();
    main = main.slice(0, slash).trim();
  }
  const dash = main.indexOf(" - ");
  if (dash !== -1) {
    series = main.slice(dash + 3).trim();
    main = main.slice(0, dash).trim();
  }
  const colon = main.indexOf(" : ");
  if (colon !== -1) {
    subtitle = main.slice(colon + 3).trim();
    main = main.slice(0, colon).trim();
  }
  return { title: main, subtitle, series, author };
}

function cleanDnbPerson(s) {
  s = String(s).replace(/\s*\[[^\]]*\]/g, "").trim();
  const m = s.match(/^([^,;]{2,}),\s+(\S.*)$/);
  if (m && !/ und | u\. /i.test(s)) return `${m[2]} ${m[1]}`;
  return s;
}

export async function searchDnb(query, limit = 12) {
  const terms = norm(query).split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return [];
  const srq = terms.map(t => `WOE="${t}"`).join(" and ");
  const url = `https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=${encodeURIComponent(srq)}&maximumRecords=${limit}&recordSchema=oai_dc`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("DNB " + res.status);
    const xml = await res.text();
    const blocks = xml.match(/<record>[\s\S]*?<\/record>/g) || [];
    return blocks.map(block => {
      const texts = (tag) => [...(block.match(new RegExp(`<dc:${tag}[^>]*>([\\s\\S]*?)</dc:${tag}>`, "g")) || [])]
        .map(m => decodeXml(m.replace(new RegExp(`</?dc:${tag}[^>]*>`, "g"), "")).trim())
        .filter(Boolean);
      const titleRaw = texts("title")[0] || "";
      const { title, subtitle, series, author: titleAuthor } = splitDnbTitle(titleRaw);
      const creators = texts("creator").map(cleanDnbPerson).filter(Boolean);
      const dateRaw = (texts("date")[0] || "").match(/\d{4}/);
      const isbn13 = (texts("identifier")
        .map(v => v.replace(/[^0-9]/g, ""))
        .find(v => /^(97[89])\d{10}$/.test(v)) || "");
      const idn = (texts("identifier")
        .map(v => v.replace(/[^0-9Xx]/g, ""))
        .find(v => /^\d{8}[\dXx]$/.test(v)) || "");
      return {
        source: "dnb",
        key: idn ? `dnb:${idn}` : title,
        title,
        subtitle,
        author: creators[0] || titleAuthor,
        authors: creators.length ? creators : (titleAuthor ? [titleAuthor] : []),
        narrator: "",
        series,
        publisher: "",
        year: dateRaw ? parseInt(dateRaw[0], 10) : null,
        isbn13,
        coverUrl: null,
        rating: null,
        pages: null,
        olAuthorKey: null,
        languages: ["de"]
      };
    }).filter(r => r.title);
  } catch (e) {
    console.warn("DNB-Suche fehlgeschlagen", e);
    return [];
  }
}

function isbn10From13(isbn) {
  const s = String(isbn || "").replace(/[^0-9]/g, "");
  if (s.length !== 13 || (!s.startsWith("978") && !s.startsWith("979"))) return "";
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (s.charCodeAt(3 + i) - 48) * (10 - i);
  const c = (11 - (sum % 11)) % 11;
  return s.slice(3, 12) + (c === 10 ? "X" : String(c));
}

/* Alt-Bildendpoint von Amazon: CORS-fähig, ohne API-Key, über ISBN-10 */
function amazonPUrls(isbn) {
  const s = String(isbn || "").replace(/[^0-9Xx]/g, "");
  let ten = "";
  if (s.length === 13) ten = isbn10From13(s);
  else if (/^\d{9}[\dXx]$/.test(s)) ten = s.toUpperCase();
  if (!ten) return [];
  return [`https://m.media-amazon.com/images/P/${ten}.01._SCRM_SCLZZZZZZZ_V1_.jpg`];
}

/* OL und Amazon liefern auf unbekannte ISBN eine 43-byte-Platzhalter-GIF mit 200 */
async function isLiveImage(url, minBytes = 1500) {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const blob = await res.blob();
    return blob.type.startsWith("image") && blob.size >= minBytes;
  } catch {
    return false;
  }
}

async function filterLive(urls, minBytes = 1500) {
  const flags = await Promise.all(urls.map(u => isLiveImage(u, minBytes)));
  return urls.filter((_, i) => flags[i]);
}

async function wikipediaCoverUrl(book) {
  const q = [book.title, book.author].filter(Boolean).join(" ").trim();
  if (!q) return null;
  try {
    const res = await fetch(
      `https://de.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search` +
      `&gsrsearch=${encodeURIComponent(q)}&gsrlimit=5&prop=pageimages&piprop=thumbnail&pithumbsize=600`);
    if (!res.ok) return null;
    const data = await res.json();
    const pages = Object.values(data?.query?.pages || {})
      .sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
    const wantTokens = norm(book.title).split(" ").filter(t => t.length >= 3);
    if (!wantTokens.length) return null;
    for (const p of pages) {
      const pt = norm(p.title);
      if (wantTokens.every(t => pt.includes(t)) && p.thumbnail?.source) {
        return p.thumbnail.source;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function gbVolumesUrl(query) {
  return `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10&country=DE&hl=de`;
}

function coverQueryVariants(book) {
  const full = norm([book.title, book.author].filter(Boolean).join(" "));
  const out = [];
  const push = (v) => { if (v && v !== full && !out.includes(v)) out.push(v); };
  push(stripFillers(full));
  push(norm(book.title));
  const tw = norm(book.title).split(" ");
  if (tw.length >= 4) push(tw.slice(0, 3).join(" "));
  return out.slice(0, 3);
}

const SOURCE_DEFS = {
  dnb: "Deutsche Nationalbibliothek",
  lobid: "lobid / SWB-Verbundkatalog",
  openlibrary: "OpenLibrary",
  google: "Google Books"
};
const DEFAULT_SOURCE_ORDER = ["dnb", "lobid", "openlibrary", "google"];

export function getSourceConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem("audiocron_sources") || "null");
    if (Array.isArray(raw)) {
      const out = raw
        .filter(x => x && SOURCE_DEFS[x.id])
        .map(x => ({ id: x.id, on: x.on !== false }));
      for (const id of DEFAULT_SOURCE_ORDER) {
        if (!out.some(x => x.id === id)) out.push({ id, on: true });
      }
      return out;
    }
  } catch {}
  return DEFAULT_SOURCE_ORDER.map(id => ({ id, on: true }));
}

export function setSourceConfig(cfg) {
  localStorage.setItem("audiocron_sources", JSON.stringify(cfg));
}

export function sourceLabel(id) {
  return SOURCE_DEFS[id] || id;
}

function runSource(id, query) {
  if (id === "dnb") return searchDnb(query);
  if (id === "lobid") return searchLobid(query);
  if (id === "openlibrary") return searchBooks(query, { lang: "german" });
  if (id === "google") return searchGermanAudiobooks(query);
  return Promise.resolve([]);
}

export async function searchCombined(query) {
  const active = getSourceConfig().filter(c => c.on);
  const lists = await Promise.all(active.map(c => runSource(c.id, query)));
  let merged = mergeResults(...lists);
  const hasOl = active.some(c => c.id === "openlibrary");
  if (merged.length < 3 && hasOl) {
    merged = mergeResults(merged, await searchBooks(query));
  }
  if (merged.length < 3) {
    for (const q2 of fallbackQueries(query)) {
      const more = await Promise.all(active.map(c => runSource(c.id, q2)));
      merged = mergeResults(merged, ...more);
      if (merged.length >= 3) break;
      if (hasOl) {
        merged = mergeResults(merged, await searchBooks(q2));
        if (merged.length >= 3) break;
      }
    }
  }
  return merged;
}

async function olCoverByQuery(q) {
  try {
    const res = await fetch(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=5&fields=key,cover_i,title`,
      { headers: olHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    const withCover = (data.docs || []).find(d => d.cover_i);
    return withCover ? `https://covers.openlibrary.org/b/id/${withCover.cover_i}-M.jpg` : null;
  } catch {
    return null;
  }
}

export async function coverForIsbn(isbn, title, author) {
  const clean = String(isbn || "").replace(/[^0-9Xx]/g, "");
  if (clean.length >= 10) {
    try {
      const res = await fetch(
        `https://openlibrary.org/search.json?q=isbn:${encodeURIComponent(clean)}&limit=3&fields=cover_i`,
        { headers: olHeaders() });
      if (res.ok) {
        const data = await res.json();
        const withCover = (data.docs || []).find(d => d.cover_i);
        if (withCover) return `https://covers.openlibrary.org/b/id/${withCover.cover_i}-M.jpg`;
      }
    } catch {}
    const gb = await gbSearch(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(clean)}&maxResults=1&country=DE&hl=de`);
    if (gb[0]?.coverUrl) return gb[0].coverUrl;
    for (const u of amazonPUrls(clean)) {
      if (await isLiveImage(u)) return u;
    }
  }
  const t = (title || "").trim();
  const a = (author || "").trim();
  if (t) {
    const tried = new Set();
    for (const q of [a ? `${t} ${a}` : t, stripFillers(a ? `${t} ${a}` : ""), t]) {
      if (!q || tried.has(q)) continue;
      tried.add(q);
      const byTitle = await olCoverByQuery(q);
      if (byTitle) return byTitle;
    }
  }
  return null;
}

function fallbackQueries(query) {
  const out = [];
  const stripped = stripFillers(query);
  if (stripped && stripped !== norm(query)) out.push(stripped);
  const words = norm(stripped || query).split(" ").filter(Boolean);
  if (words.length >= 3) {
    for (let i = 0; i < words.length && out.length < 5; i++) {
      out.push(words.filter((_, j) => j !== i).join(" "));
    }
  }
  if (words.length >= 2) {
    for (const w of [...words].sort((a, b) => b.length - a.length)) {
      if (w.length >= 4 && out.length < 7) out.push(w);
    }
  }
  return out;
}

function mergeResults(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const r of list) {
      const authorKey = norm(r.author).split(" ").filter(Boolean).sort().join(" ");
      const k = norm(r.title) + "|" + authorKey;
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(r);
    }
  }
  return merged.sort((a, b) => (isGermanResult(a) ? 0 : 1) - (isGermanResult(b) ? 0 : 1));
}

function stripFillers(q) {
  const stop = new Set(["und", "der", "die", "das", "ein", "eine", "im", "am", "mit", "von", "the", "of"]);
  const parts = norm(q).split(" ").filter(w => w && !stop.has(w));
  return parts.length >= 2 && parts.join(" ") !== norm(q) ? parts.join(" ") : "";
}

export async function isbnLookup(isbn) {
  const [ol, dnb, lob] = await Promise.all([
    searchBooks(isbn, { isbn: true }),
    searchDnb(isbn),
    searchLobid(isbn)
  ]);
  const merged = mergeResults(ol, dnb, lob);
  if (merged.length) return merged;
  return searchGoogle(isbn);
}

export async function fetchWorksByAuthor(authorName, olKey) {
  if (olKey) {
    try {
      const res = await fetch(`${OL}${olKey}/works.json?limit=100`, { headers: olHeaders() });
      if (res.ok) {
        const data = await res.json();
        const entries = (data.entries || []).slice(0, 100);
        const detailed = await Promise.all(entries.slice(0, 30).map(async w => {
          try {
            const r = await fetch(`${OL}${w.key}.json`, { headers: olHeaders() });
            if (!r.ok) return null;
            const j = await r.json();
            const firstCover = (j.covers || [])[0];
            return {
              source: "openlibrary",
              key: w.key,
              title: j.title || "",
              subtitle: j.subtitle || "",
              author: authorName,
              authors: [authorName],
              narrator: "",
              series: "",
              publisher: "",
              year: j.first_publish_date ? parseInt(j.first_publish_date, 10) || null : null,
              isbn13: "",
              coverUrl: firstCover ? `https://covers.openlibrary.org/b/id/${firstCover}-M.jpg` : null,
              rating: null,
              pages: null,
              olAuthorKey: olKey
            };
          } catch { return null; }
        }));
        return detailed.filter(Boolean);
      }
    } catch (e) { console.warn("OL-Werke fehlgeschlagen", e); }
  }
  return searchBooks(`author:"${authorName}"`);
}

export function bestCoverUrl(result) {
  if (result.coverUrl) return result.coverUrl;
  if (result.isbn13) return `https://covers.openlibrary.org/b/isbn/${result.isbn13}-M.jpg`;
  if (result.title && result.author) {
    return `https://covers.openlibrary.org/b/query/${encodeURIComponent(result.title)}_${encodeURIComponent(result.author)}-M.jpg`;
  }
  return null;
}

export async function resolveCover(result) {
  const candidates = [];
  if (result.isbn13) candidates.push(`https://covers.openlibrary.org/b/isbn/${result.isbn13}-M.jpg`);
  if (result.coverUrl) candidates.push(result.coverUrl);
  amazonPUrls(result.isbn13).forEach(u => candidates.push(u));
  if (result.title && result.author) {
    candidates.push(`https://covers.openlibrary.org/b/query/${encodeURIComponent(result.title)}_${encodeURIComponent(result.author)}-M.jpg`);
  }
  const wiki = await wikipediaCoverUrl(result);
  if (wiki) candidates.push(wiki);
  for (const url of candidates) {
    if (await isLiveImage(url, 1200)) return url;
  }
  return null;
}

export function olCoverUrlFor(book) {
  if (book.olid) return `https://covers.openlibrary.org/b/olid/${book.olid}-L.jpg`;
  if (book.isbn) return `https://covers.openlibrary.org/b/isbn/${book.isbn}-L.jpg`;
  return null;
}

async function fetchOlDescription(isbn) {
  try {
    const res = await fetch(`${OL}/isbn/${isbn}.json`, { headers: olHeaders() });
    if (!res.ok) return null;
    const ed = await res.json();
    const coverId = (ed.covers || [])[0];
    let description = null;
    if (typeof ed.description === "string") description = ed.description;
    else if (ed.description?.value) description = ed.description.value;
    if (!description && ed.works?.[0]?.key) {
      const wr = await fetch(`${OL}${ed.works[0].key}.json`, { headers: olHeaders() });
      if (wr.ok) {
        const w = await wr.json();
        if (typeof w.description === "string") description = w.description;
        else if (w.description?.value) description = w.description.value;
      }
    }
    const narrators = (ed.narrators || [])
      .map(n => typeof n === "string" ? n : (n?.value || ""))
      .filter(Boolean)
      .join(", ");
    return {
      description,
      coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : null,
      publisher: (ed.publishers || [])[0] || null,
      pubDate: ed.publish_date || null,
      narrator: narrators || null
    };
  } catch { return null; }
}

async function fetchGoogleIsbn(isbn) {
  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&country=DE&hl=de&maxResults=10`);
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items || [];
    if (!items.length) return null;
    const descriptions = [];
    const coverUrls = [];
    for (const it of items) {
      const d = it.volumeInfo?.description;
      if (d && d.trim()) descriptions.push(d.trim());
      for (const u of gbAllCovers(it)) {
        if (!coverUrls.includes(u)) coverUrls.push(u);
      }
    }
    descriptions.sort((a, b) => b.length - a.length);
    const v = items[0].volumeInfo || {};
    return {
      description: descriptions[0] || null,
      coverUrl: coverUrls[0] || null,
      coverUrls,
      publisher: v.publisher || null,
      narrator: null
    };
  } catch { return null; }
}

export async function fetchIsbnMetadata(isbn) {
  const [ol, gb] = await Promise.all([
    fetchOlDescription(isbn),
    fetchGoogleIsbn(isbn)
  ]);
  const coverCandidates = [];
  const seen = new Set();
  for (const u of [ol?.coverUrl, ...(gb?.coverUrls || []), ...amazonPUrls(isbn)]) {
    if (u && !seen.has(u)) { seen.add(u); coverCandidates.push(u); }
  }
  const olDesc = ol?.description?.trim() || null;
  const gbDesc = gb?.description || null;
  const better = olDesc && gbDesc
    ? (gbDesc.length > olDesc.length * 1.6 ? gbDesc : olDesc)
    : (olDesc || gbDesc);
  return {
    description: better,
    coverCandidates,
    publisher: ol?.publisher || gb?.publisher || null,
    narrator: ol?.narrator || gb?.narrator || null
  };
}

export async function coverCandidates(book, onFound = null) {
  const seen = new Set();
  const raw = [];
  const add = (u) => {
    if (u && !seen.has(u)) { seen.add(u); raw.push(u); }
  };
  const addFromResults = (results) => {
    let n = 0;
    for (const r of results) {
      if (n >= 6) break;
      if (r.coverUrl) { add(r.coverUrl); n++; continue; }
      if (r.isbn13) {
        add(`https://covers.openlibrary.org/b/isbn/${r.isbn13}-M.jpg`);
        amazonPUrls(r.isbn13).forEach(add);
        n++;
      }
    }
  };

  add(olCoverUrlFor(book));
  if (book.isbn) {
    add(`https://covers.openlibrary.org/b/isbn/${book.isbn}-M.jpg`);
    amazonPUrls(book.isbn).forEach(add);
  }

  const t = String(book.title || "").replace(/"/g, "").trim();
  const a = String(book.author || "").replace(/"/g, "").trim();
  const q = [t, a].filter(Boolean).join(" ");
  const want = norm(t);

  const gbOps = [];
  if (t && a) gbOps.push(`intitle:"${t}" inauthor:"${a}"`);
  if (t) gbOps.push(`intitle:"${t}"`);

  const [olRes, gbRes, gbOpLists, wikiUrl, meta] = await Promise.all([
    q ? searchBooks(q) : Promise.resolve([]),
    q ? searchGermanAudiobooks(q) : Promise.resolve([]),
    Promise.all(gbOps.map(gq => gbSearch(gbVolumesUrl(gq)))),
    wikipediaCoverUrl(book),
    book.isbn ? fetchIsbnMetadata(book.isbn).catch(() => null) : Promise.resolve(null)
  ]);

  const sorted = [...olRes].sort((x, y) => {
    const sx = x.isbn13 === book.isbn ? 0 : (norm(x.title) === want ? 1 : 2);
    const sy = y.isbn13 === book.isbn ? 0 : (norm(y.title) === want ? 1 : 2);
    return sx - sy;
  });
  addFromResults(sorted);
  for (const r of [...gbRes, ...gbOpLists.flat()].slice(0, 12)) add(r.coverUrl);
  add(wikiUrl);
  meta?.coverCandidates?.forEach(add);

  let out = await filterLive(raw);
  if (onFound && out.length) onFound(out);

  const surname = norm(book.author).split(" ").pop() || "";
  const relevant = (r) => {
    const pt = norm(r.title);
    const titleOk = pt === want || (want.length >= 4 && (pt.includes(want) || want.includes(pt)));
    if (!titleOk) return false;
    if (!surname) return true;
    const ra = norm(r.author);
    if (!ra) return true;
    const otherSurname = ra.split(" ").pop();
    return ra.includes(surname) || surname.includes(otherSurname);
  };

  for (const vq of coverQueryVariants(book)) {
    if (out.length >= 3) break;
    const start = raw.length;
    const [res, gbr] = await Promise.all([searchBooks(vq), gbSearch(gbVolumesUrl(vq))]);
    addFromResults(res.filter(relevant));
    for (const r of gbr.filter(relevant).slice(0, 8)) add(r.coverUrl);
    const fresh = raw.slice(start);
    if (fresh.length) {
      const more = await filterLive(fresh);
      out = out.concat(more);
      if (onFound && more.length) onFound(more);
    }
  }
  return out.slice(0, 12);
}

export async function descriptionCandidates(book) {
  const out = [];
  const seen = new Set();
  const add = (d, src) => {
    if (d && d.trim() && !seen.has(d.trim())) { seen.add(d.trim()); out.push({ text: d.trim(), src }); }
  };
  if (book.isbn) {
    const meta = await fetchIsbnMetadata(book.isbn);
    add(meta?.description, "ISBN");
  }
  const q = [book.title, book.author].filter(Boolean).join(" ");
  if (q) {
    try {
      const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&country=DE`);
      if (res.ok) {
        const data = await res.json();
        for (const it of (data.items || []).slice(0, 5)) {
          add(it.volumeInfo?.description, it.volumeInfo?.title || "Google Books");
        }
      }
    } catch {}
  }
  return out;
}

/* Deckt Amazon-Produktlinks per ASIN über den Media-Server ab; normale Bild-URLs direkt. */
export async function resolveCoverUrl(input) {
  const url = (input || "").trim();
  if (!url.startsWith("http")) return null;
  const m = url.match(/amazon\.[a-z.]{2,}\/(?:[^/?#]+\/)?(?:dp|gp\/product|product-reviewed)\/([A-Z0-9]{10})/i);
  if (m) {
    const asin = m[1];
    const candidates = [
      `https://m.media-amazon.com/images/I/${asin}L._SCRM_.jpg`,
      `https://images-na.ssl-images-amazon.com/images/P/${asin}.01._SCRM_SCLZZZZZZZ_V1_.jpg`,
      `https://m.media-amazon.com/images/P/${asin}.01._SCRM_SCLZZZZZZZ_V1_.jpg`
    ];
    for (const img of candidates) {
      try {
        const res = await fetch(img);
        if (res.ok) {
          const blob = await res.blob();
          if (blob.type.startsWith("image") && blob.size > 1200) return img;
        }
      } catch {}
    }
    return null;
  }
  if (/\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(url)) return url;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const blob = await res.blob();
      if (blob.type.startsWith("image")) return url;
    }
  } catch {}
  return null;
}

/* Barcode / QR via native BarcodeDetector, sonst manuelle Eingabe */
export function barcodeSupported() {
  return "BarcodeDetector" in window &&
    "MediaDevices" in navigator && navigator.mediaDevices?.getUserMedia;
}

export async function startBarcodeScan(videoEl, onResult) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" } }
  });
  videoEl.srcObject = stream;
  await videoEl.play();
  const detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "qr_code"] });
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const codes = await detector.detect(videoEl);
      if (codes.length) {
        stop();
        onResult(codes[0].rawValue);
        return;
      }
    } catch {}
    setTimeout(tick, 350);
  };
  const stop = () => {
    stopped = true;
    stream.getTracks().forEach(t => t.stop());
  };
  setTimeout(tick, 400);
  return stop;
}
