'use strict';

/**
 * Cold-Start-Importer für den Open-Food-Facts-Export -> Produktkatalog.
 * -------------------------------------------------------------------------
 * Liest den offiziellen JSONL-Export (products.jsonl, entpackt) STREAMING zeilenweise
 * ein, filtert Deutschland-relevante Produkte mit brauchbaren Nährwerten und schreibt
 * sie normalisiert in den Katalog (Upstash über lib/foodCatalog, später Postgres).
 *
 * WICHTIG:
 *  - NIE automatisch im Vercel-Deploy laufen lassen – nur manuell/Job.
 *  - Keine tausenden Einzelabfragen an die öffentliche API (das ist der Bulk-Export!).
 *  - Keine Bilder herunterladen; nur externe Bild-URLs (validiert) übernehmen.
 *  - Idempotent: Duplikate werden per Barcode AKTUALISIERT, nicht vervielfacht.
 *
 * Aufruf:
 *   node scripts/import-openfoodfacts.js --file products.jsonl [--limit 20000]
 *        [--dry-run] [--country de] [--batch 50]
 *
 * Env: dieselben KV_ / UPSTASH_ Variablen wie die App (echter Import; Dry-Run braucht keine).
 * Export & Lizenz: siehe docs/OPEN-FOOD-FACTS.md.
 */

const fs = require('fs');
const readline = require('readline');
const path = require('path');

const OFF = require(path.join(__dirname, '..', 'lib', 'openFoodFacts'));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}

const FILE = arg('file', '');
const LIMIT = parseInt(arg('limit', '20000'), 10) || 20000;
const DRY = !!arg('dry-run', false);
const COUNTRY = String(arg('country', 'de')).toLowerCase();
const BATCH = Math.max(1, Math.min(200, parseInt(arg('batch', '50'), 10) || 50));

function isGermanRelevant(offProduct) {
  const tags = Array.isArray(offProduct.countries_tags) ? offProduct.countries_tags.map(String) : [];
  if (!tags.length) return false;
  const want = COUNTRY === 'de' ? ['en:germany', 'de:deutschland', 'en:austria', 'en:switzerland'] : ['en:' + COUNTRY];
  return tags.some(function (t) { return want.indexOf(t.toLowerCase()) >= 0; });
}

async function main() {
  if (!FILE || DRY === false && !fs.existsSync(FILE)) {
    console.error('Fehlt: --file <products.jsonl>  (entpackter OFF-JSONL-Export)');
    process.exit(2);
  }
  if (!fs.existsSync(FILE)) { console.error('Datei nicht gefunden: ' + FILE); process.exit(2); }

  let Catalog = null;
  if (!DRY) {
    Catalog = require(path.join(__dirname, '..', 'lib', 'foodCatalog'));
    const store = require(path.join(__dirname, '..', 'lib', 'store'));
    if (!store.hasStore) { console.error('KV/Upstash ist nicht konfiguriert (Env fehlt). Für echten Import KV_* setzen oder --dry-run nutzen.'); process.exit(2); }
  }
  console.log((DRY ? '[DRY-RUN] ' : '') + 'Import aus ' + FILE + ' · Land=' + COUNTRY + ' · Limit=' + LIMIT + ' · Batch=' + BATCH);

  const rl = readline.createInterface({ input: fs.createReadStream(FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
  let seen = 0, kept = 0, skipped = 0, errors = 0;
  let batch = [];

  async function flush() {
    if (!batch.length || DRY) { batch = []; return; }
    // Katalog-Schreibvorgänge (idempotent per Barcode). Bei Fehlern: zählen, weiter.
    for (const prod of batch) {
      try { await Catalog.catalogPut(prod, await Catalog.catalogGet(prod.barcode)); }
      catch (e) { errors++; }
    }
    batch = [];
  }

  for await (const line of rl) {
    if (kept >= LIMIT) break;
    const s = line.trim();
    if (!s) continue;
    seen++;
    let raw;
    try { raw = JSON.parse(s); } catch (e) { errors++; continue; }
    const code = String(raw.code || raw._id || '').replace(/\D/g, '');
    if (code.length < 8 || code.length > 14) { skipped++; continue; }
    if (!isGermanRelevant(raw)) { skipped++; continue; }
    const prod = OFF.normalize(code, raw);
    if (!OFF.isUsable(prod)) { skipped++; continue; }   // nur brauchbare Nährwerte
    kept++;
    batch.push(prod);
    if (batch.length >= BATCH) await flush();
    if (seen % 20000 === 0) console.log('… ' + seen + ' gelesen, ' + kept + ' übernommen, ' + skipped + ' übersprungen, ' + errors + ' Fehler');
  }
  await flush();
  console.log((DRY ? '[DRY-RUN] ' : '') + 'Fertig: ' + seen + ' gelesen, ' + kept + ' ' + (DRY ? 'würden übernommen' : 'übernommen') + ', ' + skipped + ' übersprungen, ' + errors + ' Fehler.');
}

main().catch(function (e) { console.error('Importer-Fehler:', e && e.message); process.exit(1); });
