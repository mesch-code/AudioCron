import { importOpenreadsCsv } from "../js/csv.js";
import { coverCandidates, fetchIsbnMetadata } from "../js/api.js";
import { readFile } from "node:fs/promises";

const text = await readFile("C:/Users/mse_k/Downloads/Borrow Box für Bookmori (Openreads).csv", "utf8");
const { books } = importOpenreadsCsv(text);
console.log("Bücher:", books.length, "| alle gehört:", books.every(b => b.status === "gehoert"), "| alle borrowbox:", books.every(b => b.platform === "borrowbox"));

async function tryStore(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const blob = await res.blob();
    return blob.type.startsWith("image") && blob.size >= 500;
  } catch { return false; }
}

let found = 0;
for (const b of books.slice(0, 8)) {
  const urls = await coverCandidates(b);
  let ok = false;
  for (const u of urls) {
    if (await tryStore(u)) { ok = true; break; }
  }
  console.log((ok ? "COVER " : "  -   "), b.title.slice(0, 35).padEnd(35), "Kandidaten:", urls.length);
  if (ok) found++;
  await new Promise(r => setTimeout(r, 300));
}
console.log(`Cover gefunden: ${found}/8`);
