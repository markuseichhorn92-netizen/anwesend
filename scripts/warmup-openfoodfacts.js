'use strict';

/**
 * Katalog-Warmup: die meistgescannten Deutschland-Produkte vorladen.
 * -------------------------------------------------------------------------
 * Anders als der Voll-Import (scripts/import-openfoodfacts.js, riesiger JSONL-Dump)
 * holt dieses Skript nur die POPULÄRSTEN Produkte (nach unique_scans_n) über die
 * öffentliche OFF-Suche und schreibt sie in den Produktkatalog (Upstash über
 * lib/foodCatalog). Damit trifft nach dem Launch fast jeder reale Scan lokal – ohne
 * dass live viele OFF-Aufrufe nötig sind.
 *
 * Sparsam mit der API: paginiert mit Pause (OFF-Suchlimit = 10/min). 10 Seiten à 100
 * = bis zu 1000 Produkte in ~1–2 Minuten.
 *
 * Aufruf (mit denselben KV_/UPSTASH_-Env wie die App, plus OPENFOODFACTS_CONTACT_EMAIL):
 *   node scripts/warmup-openfoodfacts.js --limit 1000 --country de
 *   node scripts/warmup-openfoodfacts.js --dry-run           # nur anzeigen, nichts schreiben
 *   node scripts/warmup-openfoodfacts.js --delay 7000        # Pause zwischen Seiten (ms)
 *
 * Idempotent: vorhandene Produkte werden per Barcode aktualisiert, nicht doppelt.
 * Doku/Lizenz: docs/OPEN-FOOD-FACTS.md (ODbL).
 */

const path = require('path');
const OFF = require(path.join(__dirname, '..', 'lib', 'openFoodFacts'));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v && !String(v).startsWith('--')) ? v : true;
}

const LIMIT = Math.max(1, Math.min(5000, parseInt(arg('limit', '1000'), 10) || 1000));
const DRY = !!arg('dry-run', false);
const COUNTRY = String(arg('country', 'de')).toLowerCase();
const DELAY = Math.max(0, parseInt(arg('delay', '7000'), 10) || 7000);   // OFF-Suchlimit schonen
const PAGE_SIZE = 100;

const COUNTRY_TAG = { de: 'germany', at: 'austria', ch: 'switzerland' }[COUNTRY] || COUNTRY;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function fetchPage(page) {
  const url = OFF.BASE + '/cgi/search.pl?action=process&json=1&sort_by=unique_scans_n'
    + '&page_size=' + PAGE_SIZE + '&page=' + page
    + '&tagtype_0=countries&tag_contains_0=contains&tag_0=' + encodeURIComponent(COUNTRY_TAG)
    + '&fields=' + OFF.PRODUCT_FIELDS;
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 15000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': OFF.USER_AGENT, Accept: 'application/json' }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, status: res.status };
    const j = await res.json();
    return { ok: true, products: Array.isArray(j.products) ? j.products : [] };
  } catch (e) { clearTimeout(timer); return { ok: false, error: (e && e.name) || 'network' }; }
}

async function main() {
  if (!OFF.hasContact) { console.error('OPENFOODFACTS_CONTACT_EMAIL fehlt – bitte setzen (echte Adresse).'); process.exit(2); }

  let Catalog = null;
  if (!DRY) {
    Catalog = require(path.join(__dirname, '..', 'lib', 'foodCatalog'));
    const store = require(path.join(__dirname, '..', 'lib', 'store'));
    if (!store.hasStore) { console.error('KV/Upstash nicht konfiguriert (KV_*/UPSTASH_* fehlen). Für echten Warmup Env setzen oder --dry-run nutzen.'); process.exit(2); }
  }
  console.log((DRY ? '[DRY-RUN] ' : '') + 'Warmup · Land=' + COUNTRY + ' (' + COUNTRY_TAG + ') · Ziel=' + LIMIT + ' Produkte · Pause=' + DELAY + 'ms');

  const pages = Math.ceil(LIMIT / PAGE_SIZE);
  let seen = 0, kept = 0, skipped = 0, errors = 0;
  const sample = [];

  for (let p = 1; p <= pages; p++) {
    let r = await fetchPage(p);
    if (!r.ok) {   // ein Retry (OFF ist gelegentlich kurz mit 503 belegt)
      console.warn('Seite ' + p + ' fehlgeschlagen (' + (r.status || r.error) + ') – ein erneuter Versuch nach Pause …');
      await sleep(Math.max(DELAY, 4000));
      r = await fetchPage(p);
    }
    if (!r.ok) { errors++; console.warn('Seite ' + p + ' erneut fehlgeschlagen (' + (r.status || r.error) + ') – überspringe.'); await sleep(DELAY); continue; }
    if (!r.products.length) { console.log('Seite ' + p + ': keine weiteren Produkte – fertig.'); break; }
    for (const raw of r.products) {
      if (kept >= LIMIT) break;
      seen++;
      const code = String(raw.code || raw._id || '').replace(/\D/g, '');
      if (code.length < 8 || code.length > 14) { skipped++; continue; }
      const prod = OFF.normalize(code, raw);
      if (!OFF.isUsable(prod)) { skipped++; continue; }      // nur mit Name + kcal/100 g
      kept++;
      if (sample.length < 10) sample.push(prod.name + ' (' + code + ', ' + prod.nutriments.kcal100g + ' kcal)');
      if (!DRY) { try { await Catalog.catalogPut(prod, await Catalog.catalogGet(code)); } catch (e) { errors++; } }
    }
    console.log('Seite ' + p + '/' + pages + ' · ' + seen + ' gesehen, ' + kept + ' übernommen, ' + skipped + ' übersprungen');
    if (kept >= LIMIT) break;
    if (p < pages) await sleep(DELAY);   // OFF-Suchlimit (10/min) respektieren
  }

  console.log('\nBeispiele:'); sample.forEach(function (s) { console.log('  · ' + s); });
  console.log('\n' + (DRY ? '[DRY-RUN] ' : '') + 'Fertig: ' + kept + ' ' + (DRY ? 'würden übernommen' : 'übernommen') + ', ' + skipped + ' übersprungen, ' + errors + ' Fehler.');
}

main().catch(function (e) { console.error('Warmup-Fehler:', e && e.message); process.exit(1); });
