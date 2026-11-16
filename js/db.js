const DB_NAME = "AudioCron";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("books")) {
        const s = db.createObjectStore("books", { keyPath: "id" });
        s.createIndex("byTitle", "titleLower");
        s.createIndex("byAuthor", "authorLower");
      }
      if (!db.objectStoreNames.contains("covers")) {
        db.createObjectStore("covers");
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function prom(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function uid() {
  return "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function allBooks() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction("books").objectStore("books").getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function getBook(id) {
  const db = await openDb();
  return prom(db.transaction("books").objectStore("books").get(id));
}

export async function putBook(book) {
  book.updatedAt = Date.now();
  book.titleLower = norm(book.title);
  book.authorLower = norm(book.author);
  await tx("books", "readwrite", s => s.put(book));
  return book;
}

export async function deleteBook(id) {
  await tx("books", "readwrite", s => s.delete(id));
  await deleteCover(id);
}

export async function bulkPut(books) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction("books", "readwrite");
    const s = t.objectStore("books");
    for (const b of books) {
      b.titleLower = norm(b.title);
      b.authorLower = norm(b.author);
      s.put(b);
    }
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

export async function clearAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["books", "covers", "meta"], "readwrite");
    t.objectStore("books").clear();
    t.objectStore("covers").clear();
    t.objectStore("meta").clear();
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

export function norm(s) {
  return (s || "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
}

export function isDup(a, b) {
  if (!a || !b) return false;
  const ta = norm(a.title), tb = norm(b.title);
  if (!ta || !tb) return false;
  if (ta !== tb) return false;
  const aa = norm(a.author), ab = norm(b.author);
  if (!aa || !ab) return true;
  return aa === ab || aa.includes(ab) || ab.includes(aa);
}

/* Cover-Cache: blobs lokal in IndexedDB */
const urlCache = new Map();

export async function getCoverUrl(bookId) {
  if (urlCache.has(bookId)) return urlCache.get(bookId);
  const db = await openDb();
  const blob = await prom(db.transaction("covers").objectStore("covers").get(bookId));
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(bookId, url);
  return url;
}

export async function storeCover(bookId, url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const blob = await res.blob();
    if (!blob.type.startsWith("image")) return false;
    if (blob.size < 500) return false;
    await tx("covers", "readwrite", s => s.put(blob, bookId));
    const old = urlCache.get(bookId);
    if (old) URL.revokeObjectURL(old);
    urlCache.delete(bookId);
    return true;
  } catch {
    return false;
  }
}

export async function deleteCover(bookId) {
  const url = urlCache.get(bookId);
  if (url) URL.revokeObjectURL(url);
  urlCache.delete(bookId);
  try { await tx("covers", "readwrite", s => s.delete(bookId)); } catch {}
}

export async function setMeta(key, value) {
  await tx("meta", "readwrite", s => s.put(value, key));
}

export async function getMeta(key) {
  const db = await openDb();
  return prom(db.transaction("meta").objectStore("meta").get(key));
}
