import { readFile } from "node:fs/promises";
import { importOpenreadsCsv, exportOpenreadsCsv, exportJson, importJson } from "../js/csv.js";

const csv = [
  'Book-Title,Author,Narrator,Series,Series info,Pages,Format,Publisher,Publication date,Edition language,ASIN,ISBN13,Cover,Goodreads Rating,My Rating,State,Date started,Date finished,Date added,Pages Current,Percent,Country,Tags,Notes',
  '"Der Marsianer",Andy Weir,"David Nathan",,,475,Audiobook,Der Hörverlag,2014,de,,9780804139021,,0,5,Finished,,15.02.2025,01.02.2025,,100,Deutschland,bookbeat,"Test, mit Komma"',
  '"Project Hail Mary",Andy Weir,"David Nathan",,,0,Audiobook,,,de,,9780593139111,,4,,Reading,,01.06.2025,,,50,,borrowbox,aktuell'
].join("\n");

const r = importOpenreadsCsv(csv);
console.log("imported:", r.added);
for (const b of r.books) {
  console.log(" -", b.title, "|", b.author, "|", b.narrator, "|", b.platform, "|", b.status, "|", b.finishDate, "|", b.rating, "|", b.tags);
}
if (r.added !== 2) throw new Error("Import-Anzahl falsch");
if (r.books[0].status !== "gehoert" || r.books[0].platform !== "bookbeat") throw new Error("Mapping falsch");
if (r.books[0].finishDate !== "2025-02-15") throw new Error("Datum falsch: " + r.books[0].finishDate);

const out = exportOpenreadsCsv(r.books);
const r2 = importOpenreadsCsv(out);
const b2 = r2.books[0];
console.log("roundtrip:", b2.title, b2.platform, b2.status, b2.finishDate, b2.rating, b2.tags, b2.narrator);
if (b2.platform !== "bookbeat" || b2.status !== "gehoert" || b2.finishDate !== "2025-02-15") throw new Error("Roundtrip fehlgeschlagen");

const json = exportJson(r.books);
const list = importJson(json);
if (list.length !== 2) throw new Error("JSON-Roundtrip falsch");

const real = await readFile("C:/Users/mse_k/Downloads/Borrow Box für Bookmori (Openreads).csv", "utf8");
const rr = importOpenreadsCsv(real);
console.log("bookmori imported:", rr.added, "format:", rr.format);
if (rr.format !== "bookmori" || rr.added !== 22) throw new Error("Bookmori-Import falsch: " + rr.added);
const m = rr.books[0];
console.log(" -", m.title, "|", m.author, "|", m.platform, "|", m.status, "|", m.finishDate, "|", m.description.slice(0, 40) + "…");
if (m.platform !== "borrowbox" || m.status !== "gehoert" || m.finishDate !== "2026-11-12" || !m.description) {
  throw new Error("Bookmori-Mapping falsch");
}
if (!rr.books.every(b => b.isbn.length >= 10)) throw new Error("ISBN fehlt");
const out2 = exportOpenreadsCsv(rr.books);
if (!out2.includes("Description")) throw new Error("Description-Spalte fehlt im Export");

console.log("ALLE CSV-TESTS BESTANDEN");
