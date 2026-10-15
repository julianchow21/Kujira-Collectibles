// Regenerates Assets/species-ja.json, the English to Japanese (katakana) Pokemon species name map that the
// Japanese card art lookup reads (app.js _kjrJaSpeciesName). Data only, no runtime dependency.
//   node scripts/species-ja.mjs                  fetch the PokeAPI CSV and write Assets/species-ja.json
//   node scripts/species-ja.mjs <csv> [out]      read a CSV downloaded earlier, optionally write to [out]
// Source: https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon_species_names.csv
// Columns: pokemon_species_id,local_language_id,name,genus. Language 1 is ja-Hrkt (katakana), 9 is English.
// Output is {"Charizard":"リザードン",...} in species id order. Full-width letters and digits in a Japanese
// name become ASCII ("ポリゴンＺ" is "ポリゴンZ") because TCGdex spells card names that way, any other
// punctuation (the colon in "タイプ：ヌル", the dot in "カプ・コケコ") is left as it is.
import fs from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SOURCE_URL = "https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon_species_names.csv";
export const DEFAULT_OUT = fileURLToPath(new URL("../Assets/species-ja.json", import.meta.url));
export const MIN_ENTRIES = 1000; // a smaller result means the source changed shape, refuse to write it

// RFC 4180 enough for this file: quoted cells, doubled quotes, CRLF or LF.
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function fullWidthToAscii(text) {
  return text.replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

export function buildSpeciesMap(csvText) {
  const ja = new Map(), en = new Map();
  for (const [id, lang, name] of parseCsv(csvText).slice(1)) {
    const n = Number(id), label = String(name || "").trim();
    if (!Number.isInteger(n) || !label) continue;
    if (lang === "1") ja.set(n, label);
    else if (lang === "9") en.set(n, label);
  }
  const out = {};
  for (const id of [...en.keys()].sort((a, b) => a - b)) {
    if (!ja.has(id)) continue;
    out[en.get(id).replace(/\u2019/g, "'")] = fullWidthToAscii(ja.get(id));
  }
  return out;
}

async function main() {
  const [, , source, outPath] = process.argv;
  const csv = source && !/^https?:\/\//i.test(source)
    ? await fs.readFile(source, "utf8")
    : await (async () => {
        const res = await fetch(source || SOURCE_URL);
        if (!res.ok) throw new Error("download failed: HTTP " + res.status);
        return res.text();
      })();
  const map = buildSpeciesMap(csv);
  const count = Object.keys(map).length;
  if (count < MIN_ENTRIES) throw new Error("only " + count + " species found, expected at least " + MIN_ENTRIES + ", file not written");
  await fs.writeFile(outPath || DEFAULT_OUT, JSON.stringify(map) + "\n");
  console.log("wrote " + count + " species to " + (outPath || DEFAULT_OUT));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
