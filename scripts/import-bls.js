'use strict';
/**
 * Konverter: amtlicher Bundeslebensmittelschlüssel (BLS 4.0) -> lib/data/bls-foods.json
 * -------------------------------------------------------------------------
 * Liest die offizielle BLS-Datendatei (BLS_4_0_Daten_2025_DE.xlsx, seit Dez. 2025
 * unter CC BY 4.0 frei, Herausgeber Max Rubner-Institut) und erzeugt daraus die
 * Grundnahrungsmittel-Basis, die lib/baseFoods.js in die Lebensmittelsuche einspeist.
 *
 * Aufruf:
 *   node scripts/import-bls.js <pfad-zur-datei.xlsx|.csv>
 *
 * - XLSX wird ohne externe Abhängigkeit gelesen (ZIP + sharedStrings + Sheet-XML);
 *   CSV (mit ; oder , oder Tab, deutscher Dezimalkomma) wird ebenfalls verstanden.
 * - Spalten werden über die BLS-Codes im Kopf gefunden (ENERCC=kcal, PROT625=Eiweiß,
 *   CHO=Kohlenhydrate, FAT=Fett, FIBT=Ballaststoffe, SUGAR=Zucker, FASAT=ges. Fett,
 *   NA=Natrium). Die Wert-Spalte trägt „[…/100g]" und NICHT „Datenherkunft"/„Referenz".
 * - Jeder Eintrag wird per Atwater geprüft (kcal ~ 4·Eiweiß + 4·KH + 9·Fett, mit
 *   Ballaststoff- und Alkohol-Korrektur); grobe Ausreißer werden mit Bericht verworfen,
 *   nicht still übernommen.
 *
 * Kein Netz, keine Secrets. Wird NICHT im Web-Bundle geladen (reines Server-/Build-Skript).
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ── XLSX ohne Abhängigkeit lesen: ZIP-Zentralverzeichnis -> benötigte XML-Teile ──
function readZipEntries(buf) {
  // End of Central Directory suchen (Signatur PK\x05\x06), von hinten.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Keine ZIP-Struktur (End of Central Directory fehlt) – ist die Datei wirklich .xlsx?');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // Lokalen Header lesen, um den Datenanfang zu finden (Name/Extra dort können abweichen).
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries[name] = (method === 0) ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function xmlDecode(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
}

// sharedStrings.xml -> Array der Zeichenketten (in Index-Reihenfolge).
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) {
    // Ein <si> kann mehrere <t> (Runs) enthalten -> zusammensetzen.
    let s = ''; const tre = /<t[^>]*>([\s\S]*?)<\/t>/g; let tm;
    while ((tm = tre.exec(m[1]))) s += tm[1];
    out.push(xmlDecode(s));
  }
  return out;
}

function colToIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref); if (!m) return -1;
  let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// sheet1.xml -> Array von Zeilen; jede Zeile ist ein Array von Zellwerten (String/Zahl).
function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g; let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    // Zellen: sowohl "<c ...>…</c>" als auch selbstschließend "<c .../>" (leere Zelle).
    // Wichtig: attrs non-greedy ohne ">", sonst frisst eine leere Zelle den Inhalt der
    // nächsten und verschiebt alle Folgespalten (leere Nährwerte im BLS!).
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1] || '';
      const refM = / r="([A-Z]+\d+)"/.exec(attrs); const idx = refM ? colToIndex(refM[1]) : cells.length;
      const t = (/ t="([^"]+)"/.exec(attrs) || [])[1];
      let val = '';
      const body = cm[2] || '';
      if (t === 'inlineStr') { const im = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body); val = im ? xmlDecode(im[1]) : ''; }
      else { const vm = /<v>([\s\S]*?)<\/v>/.exec(body); const raw = vm ? vm[1] : '';
        if (t === 's') val = shared[parseInt(raw, 10)] != null ? shared[parseInt(raw, 10)] : '';
        else val = raw; }
      cells[idx] = val;
    }
    rows.push(cells);
  }
  return rows;
}

function readXlsx(buf) {
  const e = readZipEntries(buf);
  const sheetName = Object.keys(e).find((k) => /^xl\/worksheets\/sheet1\.xml$/i.test(k))
    || Object.keys(e).find((k) => /^xl\/worksheets\/.*\.xml$/i.test(k));
  if (!sheetName) throw new Error('Kein Arbeitsblatt (xl/worksheets/…) in der Datei gefunden.');
  const shared = parseSharedStrings((e['xl/sharedStrings.xml'] || Buffer.from('')).toString('utf8'));
  return parseSheet(e[sheetName].toString('utf8'), shared);
}

// ── CSV lesen (Trenner automatisch: ; , oder Tab; Anführungszeichen berücksichtigt) ──
function readCsv(text) {
  const firstLine = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length);
  const delim = (firstLine.split(';').length >= firstLine.split(',').length)
    ? (firstLine.split(';').length >= firstLine.split('\t').length ? ';' : '\t')
    : (firstLine.split(',').length >= firstLine.split('\t').length ? ',' : '\t');
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') { q = true; continue; }
    if (c === delim) { row.push(cell); cell = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Deutsche/englische Zahl robust lesen ("1.234,56" / "12,3" / "12.3" / "").
function num(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s || /^(k\.?\s?a\.?|n\.?a\.?|-|—)$/i.test(s)) return null;
  if (s.indexOf(',') >= 0 && s.indexOf('.') >= 0) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,5
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Wert-Spalte je BLS-Code finden: Kopf beginnt mit "CODE " und trägt "[…/100g]",
// aber NICHT "Datenherkunft"/"Referenz".
function findCol(header, code) {
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i] || '');
    if (h.indexOf(code + ' ') !== 0 && h !== code) continue;
    if (/Datenherkunft|Referenz/i.test(h)) continue;
    return i;
  }
  return -1;
}

// Gelesene Tabellenzeilen (rows[0] = Kopf) in geprüfte Lebensmittel-Datensätze überführen.
// Reine Funktion – von main() und vom Test genutzt.
function rowsToFoods(rows) {
  const header = rows[0] || [];
  // Spalte B (Index 1) ist laut Doku die deutsche Lebensmittelbezeichnung; zur Sicherheit
  // per Kopftext gegenprüfen und sonst suchen.
  let nameCol = 1;
  if (!/Lebensmittelbezeichnung|Bezeichnung/i.test(String(header[nameCol] || ''))) {
    const alt = header.findIndex((h) => /Lebensmittelbezeichnung/i.test(String(h || '')));
    if (alt >= 0) nameCol = alt;
  }
  const cols = {
    kcal: findCol(header, 'ENERCC'), p: findCol(header, 'PROT625'), c: findCol(header, 'CHO'),
    f: findCol(header, 'FAT'), fiber: findCol(header, 'FIBT'), sugar: findCol(header, 'SUGAR'),
    satfat: findCol(header, 'FASAT'), na: findCol(header, 'NA'),
  };
  const need = ['kcal', 'p', 'c', 'f'];
  const missing = need.filter((k) => cols[k] < 0);
  if (missing.length) {
    const err = new Error('Pflicht-Spalten nicht gefunden: ' + missing.join(', '));
    err.header = header; err.missing = missing;
    throw err;
  }

  const foods = []; const stats = { read: rows.length - 1, skippedNoName: 0, skippedNoKcal: 0, outliers: [] };
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = String(row[nameCol] || '').replace(/\s+/g, ' ').trim();
    if (!name) { stats.skippedNoName++; continue; }
    const kcal = num(row[cols.kcal]);
    if (kcal == null) { stats.skippedNoKcal++; continue; }
    const p = num(row[cols.p]) || 0, c = num(row[cols.c]) || 0, f = num(row[cols.f]) || 0;
    const fiber = cols.fiber >= 0 ? (num(row[cols.fiber]) || 0) : 0;
    const sugar = cols.sugar >= 0 ? (num(row[cols.sugar]) || 0) : 0;
    const satfat = cols.satfat >= 0 ? num(row[cols.satfat]) : null;
    const naMg = cols.na >= 0 ? num(row[cols.na]) : null;
    const salt = naMg != null ? Math.round((naMg / 1000) * 2.5 * 100) / 100 : null;   // Salz = Natrium × 2,5

    // Atwater-Plausibilität mit Ballaststoff-(2 kcal/g)-Korrektur. Der BLS führt Alkohol als
    // eigene Spalte; ohne sie erlauben wir eine großzügige obere Schranke, damit sehr
    // fett-/alkoholreiche Einträge nicht fälschlich als Ausreißer fallen.
    const atwHigh = 4 * p + 4 * c + 9 * f;
    const atwLow = 4 * p + 4 * Math.max(0, c - fiber) + 2 * fiber + 9 * f;
    const lo = Math.min(atwLow, atwHigh) * 0.6 - 15;
    const hi = Math.max(atwLow, atwHigh) * 1.3 + 60;
    const round = (x, d) => (x == null ? null : Math.round(x * Math.pow(10, d)) / Math.pow(10, d));
    const rec = { name: name.slice(0, 80), kcal: round(kcal, 0), p: round(p, 1), c: round(c, 1), f: round(f, 1),
      fiber: round(fiber, 1), sugar: round(sugar, 1) };
    if (satfat != null) rec.satfat = round(satfat, 1);
    if (salt != null) rec.salt = salt;
    if (kcal < lo || kcal > hi) { stats.outliers.push(name + ' (kcal=' + rec.kcal + ', erwartet ' + Math.round(lo) + '–' + Math.round(hi) + ')'); continue; }
    foods.push(rec);
  }
  return { foods: foods, stats: stats };
}

function main() {
  const file = process.argv[2];
  if (!file) { console.error('Aufruf: node scripts/import-bls.js <BLS-datei.xlsx|.csv>'); process.exit(2); }
  const buf = fs.readFileSync(file);
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const rows = isZip ? readXlsx(buf) : readCsv(buf.toString('utf8'));
  if (!rows.length) { console.error('Datei enthält keine Zeilen.'); process.exit(1); }

  let res;
  try { res = rowsToFoods(rows); }
  catch (e) {
    console.error(e.message + '. Gefundene Kopfzeile (Auszug):');
    console.error('  ' + (e.header || []).slice(0, 12).map((h) => String(h || '').slice(0, 24)).join(' | '));
    process.exit(1);
  }
  const foods = res.foods; const st = res.stats;

  const outDir = path.resolve(__dirname, '..', 'lib', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'bls-foods.json');
  fs.writeFileSync(outFile, JSON.stringify({
    source: 'Bundeslebensmittelschlüssel (BLS), Version 4.0 – Max Rubner-Institut, CC BY 4.0',
    generatedFrom: path.basename(file),
    count: foods.length,
    foods: foods,
  }));

  console.log('BLS-Import fertig.');
  console.log('  Datenzeilen gelesen:      ' + st.read);
  console.log('  übernommen:               ' + foods.length);
  console.log('  ohne Namen übersprungen:  ' + st.skippedNoName);
  console.log('  ohne kcal übersprungen:   ' + st.skippedNoKcal);
  console.log('  als Ausreißer verworfen:  ' + st.outliers.length + (st.outliers.length ? (' (z. B. ' + st.outliers.slice(0, 3).join('; ') + ')') : ''));
  console.log('  geschrieben:              ' + path.relative(path.resolve(__dirname, '..'), outFile) + ' (' + Math.round(fs.statSync(outFile).size / 1024) + ' KB)');
}

if (require.main === module) main();
module.exports = { readXlsx, readCsv, num, findCol, rowsToFoods };
