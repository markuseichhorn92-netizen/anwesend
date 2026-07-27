'use strict';
// End-to-End der Produktsuche (api/member/food-products.js, action:'search'):
// Grundnahrungsmittel stehen vor den OFF-Markenprodukten, und die Suche liefert
// auch dann Treffer, wenn Open Food Facts ausgelastet/aus ist – solange ein
// Grundnahrungsmittel passt. Nur lib/members und lib/foodCatalog werden gemockt;
// lib/baseFoods, lib/openFoodFacts (isUsable) und lib/nutriscore laufen echt.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

function res0() {
  return { statusCode: 200, body: '', setHeader() {}, end(b) { this.body = b || ''; } };
}
function call(handler, body) {
  const req = { method: 'POST', url: '/x', headers: {}, on(ev, cb) { if (ev === 'end') cb(); } };
  const rr = res0();
  return handler(req, rr).then(() => { try { return JSON.parse(rr.body || '{}'); } catch (e) { return { _raw: rr.body }; } });
}

async function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  inject('lib/store.js', { hasStore: true, redisPipeline: async () => [] });
  inject('lib/members.js', { bearer: () => 't', getSession: async () => ({ id: 'm1' }), readBody: async () => body, rateLimit: async () => true });

  // Steuerbarer Katalog-Mock: simuliert die drei OFF-Zustände.
  let catState = { ok: true, products: [], source: 'openfoodfacts' };
  inject('lib/foodCatalog.js', { searchProducts: async () => catState });

  // Handler NACH den Injects laden (frischer require-Baum).
  const p = path.resolve(ROOT, 'api/member/food-products.js');
  delete require.cache[p];
  const handler = require(p);

  let body;

  // ── 1) OFF liefert Markenprodukte – Grundnahrung steht davor ──
  body = { action: 'search', query: 'Kartoffeln', limit: 8 };
  catState = { ok: true, source: 'openfoodfacts', products: [
    { barcode: '40001', name: 'Kartoffel-Knäckebrot', nutriments: { kcal100g: 373, protein100g: 10, carbs100g: 65, fat100g: 3 } },
  ] };
  let d = await call(handler, body);
  ok('1. Suche erfolgreich', d.ok === true, JSON.stringify(d).slice(0, 120));
  ok('2. Erstes Ergebnis ist das Grundnahrungsmittel Kartoffeln', d.products[0] && /Kartoffeln/.test(d.products[0].name), d.products[0] && d.products[0].name);
  ok('3. …mit korrekten ~87 kcal statt 373', d.products[0] && d.products[0].nutriments.kcal100g < 150, d.products[0] && String(d.products[0].nutriments.kcal100g));
  ok('4. Das OFF-Knäckebrot ist weiter unten noch dabei', d.products.some((x) => /Knäckebrot/.test(x.name)));
  ok('5. Quelle weist auf beide Schichten hin', /grundnahrung/.test(d.source || ''), d.source);
  ok('6. Grundnahrung bekommt einen berechneten Nutri-Score', d.products[0].nutriScore && /^[A-E]$/.test(d.products[0].nutriScore.grade), JSON.stringify(d.products[0].nutriScore));

  // ── 2) OFF ist ausgelastet – Grundnahrung rettet die Suche ──
  body = { action: 'search', query: 'Haferflocken', limit: 8 };
  catState = { ok: false, error: 'rate_limited' };
  d = await call(handler, body);
  ok('7. Trotz OFF-Auslastung erfolgreich (Grundnahrung matcht)', d.ok === true, JSON.stringify(d).slice(0, 120));
  ok('8. Liefert Haferflocken', d.products && d.products[0] && /Haferflocken/.test(d.products[0].name), d.products && d.products[0] && d.products[0].name);
  ok('9. Quelle = grundnahrung', d.source === 'grundnahrung', d.source);

  // ── 3) OFF aus UND kein Grundnahrungsmittel passt -> ehrlicher Fehler ──
  body = { action: 'search', query: 'Marken-Spezialriegel-XY', limit: 8 };
  catState = { ok: false, error: 'rate_limited' };
  d = await call(handler, body);
  ok('10. Ohne Grundnahrungs-Treffer bleibt es beim OFF-Fehler', d.ok === false && d.error === 'rate_limited', JSON.stringify(d).slice(0, 120));
  ok('11. …mit verständlicher Meldung', typeof d.message === 'string' && d.message.length > 0);

  // ── 4) Reines OFF-Ergebnis, wenn Grundnahrung nichts hat ──
  body = { action: 'search', query: 'Proteinriegel', limit: 8 };
  catState = { ok: true, source: 'openfoodfacts', products: [
    { barcode: '50001', name: 'Proteinriegel Schoko', nutriments: { kcal100g: 350, protein100g: 33, carbs100g: 30, fat100g: 10 } },
  ] };
  d = await call(handler, body);
  ok('12. Reiner OFF-Treffer kommt durch', d.ok === true && d.products.some((x) => /Proteinriegel/.test(x.name)));
  ok('13. Quelle = openfoodfacts (keine Grundnahrung untergemischt)', d.source === 'openfoodfacts', d.source);

  console.log(pass ? 'FOOD-PRODUCTS-SEARCH PASS' : 'FOOD-PRODUCTS-SEARCH FAIL');
  process.exit(pass ? 0 : 1);
}
run();
