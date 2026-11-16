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

export async function searchBooks(query, { isbn = false } = {}) {
  const fields = "key,title,subtitle,author_name,author_key,cover_i,first_publish_year,isbn,publisher,series,number_of_pages_median,language";
  const url = isbn
    ? `${OL}/search.json?q=isbn:${encodeURIComponent(query)}&limit=10&fields=${fields}`
    : `${OL}/search.json?q=${encodeURIComponent(query)}&limit=15&fields=${fields}`;
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

export async function searchCombined(query) {
  const [ol, gb] = await Promise.all([searchBooks(query), searchGermanAudiobooks(query)]);
  const seen = new Set();
  const merged = [];
  for (const r of [...gb, ...ol]) {
    const k = norm(r.title) + "|" + norm(r.author);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(r);
  }
  return merged.sort((a, b) => (isGermanResult(a) ? 0 : 1) - (isGermanResult(b) ? 0 : 1));
}

export async function isbnLookup(isbn) {
  const ol = await searchBooks(isbn, { isbn: true });
  if (ol.length) return ol;
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
  if (result.title && result.author) {
    candidates.push(`https://covers.openlibrary.org/b/query/${encodeURIComponent(result.title)}_${encodeURIComponent(result.author)}-M.jpg`);
  }
  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type.startsWith("image") && blob.size > 1200) return url;
      }
    } catch {}
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
  for (const u of [ol?.coverUrl, ...(gb?.coverUrls || [])]) {
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

export async function coverCandidates(book) {
  const urls = [];
  const seen = new Set();
  const add = (u) => {
    if (u && !seen.has(u)) { seen.add(u); urls.push(u); }
  };
  add(olCoverUrlFor(book));
  if (book.isbn) {
    add(`https://covers.openlibrary.org/b/isbn/${book.isbn}-M.jpg`);
    const byIsbn = await searchBooks(book.isbn, { isbn: true });
    for (const r of byIsbn) add(r.coverUrl);
  }
  const q = [book.title, book.author].filter(Boolean).join(" ");
  if (q) {
    const results = await searchBooks(q);
    const want = norm(book.title);
    const sorted = [...results].sort((a, b) => {
      const am = a.isbn13 === book.isbn ? 0 : (norm(a.title) === want ? 1 : 2);
      const bm = b.isbn13 === book.isbn ? 0 : (norm(b.title) === want ? 1 : 2);
      return am - bm;
    });
    for (const r of sorted.slice(0, 10)) {
      add(r.coverUrl);
      if (r.isbn13) add(`https://covers.openlibrary.org/b/isbn/${r.isbn13}-M.jpg`);
    }
    const gb = await searchGermanAudiobooks(q);
    for (const r of gb.slice(0, 10)) add(r.coverUrl);
  }
  const meta = book.isbn ? await fetchIsbnMetadata(book.isbn) : null;
  meta?.coverCandidates.forEach(add);
  return urls;
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
