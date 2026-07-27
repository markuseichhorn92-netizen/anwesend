'use strict';

/**
 * /api/member/food-products   (Authorization: Bearer <token>)
 * -------------------------------------------------------------------------
 * Serverseitiger Zugang zu Produktdaten (Open Food Facts) für das Ernährungs-
 * modul. Open Food Facts wird NIE direkt aus dem Browser aufgerufen – nur hier.
 *
 *   POST { action:'barcode', barcode }        -> { ok, found, product?, source, stale }
 *   POST { action:'search',  query, limit? }  -> { ok, products:[…], source }
 *
 * Die Übernahme ins Protokoll läuft NICHT hier, sondern über den bestehenden
 * Bestätigungs-Flow: Der Client berechnet Portionswerte, das Mitglied bestätigt,
 * und api/member/nutrition.js (action:'confirm-log') speichert die geprüften
 * Werte inkl. { source:'openfoodfacts', barcode, estimated:false }.
 *
 * Architektur/Cache/Limits: lib/foodCatalog.js + lib/openFoodFacts.js.
 * Es werden nie Roh-Antworten, interne Schlüssel oder Rohfehler ausgegeben.
 */

const M = require('../../lib/members');
const OFF = require('../../lib/openFoodFacts');
const Catalog = require('../../lib/foodCatalog');
const BaseFoods = require('../../lib/baseFoods');
const NS = require('../../lib/nutriscore');
const { hasStore } = require('../../lib/store');

// Nutri-Score eines Produkts bestimmen: bevorzugt die offizielle OFF-Note; fehlt sie,
// wird sie aus den Werten je 100 g gerechnet (nur wenn genug Angaben da sind). Sonst null.
function productNutriScore(p, n) {
  const off = NS.gradeFromOFF(p.nutriScore);
  if (off) return { grade: off, source: 'off' };
  if (n.kcal100g == null) return null;
  const s = NS.score({
    kcal100: n.kcal100g,
    sugars100: n.sugars100g != null ? n.sugars100g : (n.carbs100g != null ? n.carbs100g * 0.3 : 0),
    satfat100: n.satfat100g != null ? n.satfat100g : (n.fat100g != null ? n.fat100g * 0.4 : 0),
    salt100: n.salt100g != null ? n.salt100g : 0,
    fiber100: n.fiber100g != null ? n.fiber100g : 0,
    protein100: n.protein100g != null ? n.protein100g : 0,
    fruitVegPct: 0,
    isBeverage: false,
  });
  return { grade: s.grade, source: 'calc' };
}

// Nur die für den Client nötigen Produktfelder herausgeben (keine internen Zeitstempel/Zähler).
function publicProduct(p) {
  if (!p) return null;
  const n = p.nutriments || {};
  return {
    barcode: p.barcode,
    name: p.name || null,
    brand: p.brand || null,
    quantity: p.quantity || null,
    servingSize: p.servingSize || null,
    nutritionBasis: p.nutritionBasis || '100g',
    nutriments: {
      kcal100g: n.kcal100g != null ? n.kcal100g : null,
      protein100g: n.protein100g != null ? n.protein100g : null,
      carbs100g: n.carbs100g != null ? n.carbs100g : null,
      fat100g: n.fat100g != null ? n.fat100g : null,
      fiber100g: n.fiber100g != null ? n.fiber100g : null,
      sugars100g: n.sugars100g != null ? n.sugars100g : null,
      salt100g: n.salt100g != null ? n.salt100g : null,
    },
    nutriScore: productNutriScore(p, n),
    imageUrl: p.imageUrl || null,
    source: 'openfoodfacts',
    sourceUrl: p.sourceUrl || null,
    complete: OFF.isUsable(p),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, available: false })); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  const id = sess.id;

  const body = await M.readBody(req);
  const action = String(body.action || '');

  // ── Barcode-Abfrage (gegenüber Freitextsuche priorisiert) ──
  if (action === 'barcode') {
    const barcode = Catalog.normalizeBarcode(body.barcode) || Catalog.looseBarcode(body.barcode);
    if (!barcode) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'bad_barcode', message: 'Ungültiger Barcode.' })); }
    // Eigenes Mitgliedslimit (zusätzlich zum globalen OFF-Limit).
    if (!(await M.rateLimit('off-barcode:' + id, 40, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'member_rate_limited', message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    let r; try { r = await Catalog.getProductByBarcode(barcode, OFF); } catch (e) { r = { ok: false, error: 'internal' }; }
    if (!r.ok) {
      const msg = r.error === 'rate_limited' ? 'Produktdienst ist gerade stark ausgelastet – bitte gleich nochmal oder manuell eingeben.'
        : r.error === 'not_configured' ? 'Der Produktdienst ist noch nicht konfiguriert.'
        : r.error === 'bad_barcode' ? 'Ungültiger Barcode.'
        : 'Produkt konnte gerade nicht geladen werden – bitte manuell eingeben.';
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: r.error, message: msg }));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, found: !!r.found, product: r.found ? publicProduct(r.product) : null, source: r.source, stale: !!r.stale, incomplete: !!r.incomplete }));
  }

  // ── Freitextsuche ──
  if (action === 'search') {
    const query = String(body.query || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (query.length < 2) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'query_too_short', message: 'Bitte mindestens 2 Zeichen eingeben.' })); }
    if (!(await M.rateLimit('off-search:' + id, 20, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'member_rate_limited', message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    const limit = Math.max(1, Math.min(20, parseInt(body.limit, 10) || 10));
    // Grundnahrungsmittel zuerst: offline, ohne Rate-Limit, verlässliche Werte.
    // So findet „Kartoffeln" wieder Kartoffeln statt eines Knäckebrots mit 373 kcal.
    const baseHits = BaseFoods.search(query, limit);
    let r; try { r = await Catalog.searchProducts(query, limit, OFF); } catch (e) { r = { ok: false, error: 'internal' }; }
    if (!r.ok) {
      // OFF ausgelastet/aus? Solange Grundnahrungsmittel passen, ist die Suche trotzdem
      // erfolgreich – der häufigste Fall (Alltags-Lebensmittel) funktioniert immer.
      if (baseHits.length) {
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, products: baseHits.map(publicProduct), source: 'grundnahrung' }));
      }
      const msg = r.error === 'rate_limited' ? 'Produktsuche ist gerade stark ausgelastet – bitte gleich nochmal oder manuell eingeben.'
        : r.error === 'not_configured' ? 'Der Produktdienst ist noch nicht konfiguriert.'
        : 'Suche gerade nicht möglich – bitte manuell eingeben.';
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: r.error, message: msg }));
    }
    const merged = BaseFoods.mergeWithOff(baseHits, r.products || [], limit);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, products: merged.map(publicProduct), source: baseHits.length ? 'grundnahrung+' + r.source : r.source }));
  }

  res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
