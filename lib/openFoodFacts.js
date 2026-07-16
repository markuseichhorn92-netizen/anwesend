'use strict';

/**
 * Open-Food-Facts-Client (nur serverseitig!).
 * -------------------------------------------------------------------------
 * Gekapselter, defensiver Zugriff auf die öffentliche Open-Food-Facts-API
 * (reine Lesezugriffe, keine Secrets nötig). Wird NIE direkt aus dem Browser
 * aufgerufen – der Zugriff läuft ausschließlich über api/member/food-products.js.
 *
 * - eigenes Timeout via AbortController
 * - höchstens EIN Retry bei temporären Fehlern (429/503/Netzwerk), exponentielles Backoff
 * - KEIN Retry bei 400/404
 * - strikte Validierung, nur benötigte Felder
 * - fehlende Nährwerte bleiben null (nie scheinbar korrekte 0)
 * - eigener User-Agent mit Kontaktadresse aus OPENFOODFACTS_CONTACT_EMAIL
 * - keine Rohantwort an den Browser
 *
 * Keine npm-Abhängigkeit (nur global fetch + AbortController).
 * Doku/Lizenz siehe docs/OPEN-FOOD-FACTS.md.
 */

// Basis-URL (überschreibbar für Tests / Länder-Instanz). Produkt-Reads: v2.
const BASE = (process.env.OPENFOODFACTS_BASE_URL || 'https://world.openfoodfacts.org').replace(/\/+$/, '');
const CONTACT = String(process.env.OPENFOODFACTS_CONTACT_EMAIL || '').trim();
const TIMEOUT_MS = parseInt(process.env.OPENFOODFACTS_TIMEOUT_MS || '', 10) || 4500;
const MAX_BYTES = 700000;   // Antwortgröße defensiv begrenzen

const hasContact = !!CONTACT && /@/.test(CONTACT);
const USER_AGENT = 'FitInnNutrition/1.0' + (hasContact ? (' (' + CONTACT + ')') : '');

// Nur diese Felder anfordern (spart Bandbreite, reduziert Angriffsfläche).
const PRODUCT_FIELDS = [
  'code', 'product_name', 'product_name_de', 'brands', 'quantity', 'serving_size',
  'nutrition_data_per', 'nutriments', 'image_front_small_url', 'image_small_url',
  'countries_tags', 'last_modified_t', 'nutriscore_grade', 'nutrition_grades',
].join(',');

// Erlaubte HTTPS-Bildhosts von Open Food Facts (externe URLs streng validieren).
const IMG_HOSTS = /^(images|static|world|de)\.openfoodfacts\.org$/i;

// Nährwert je 100 g: fehlt/ungültig -> null (nie scheinbar korrekte 0), sonst
// auf 0..hi begrenzt und auf 0,1 gerundet.
function num(v, lo, hi) {
  const n = Number(v);
  if (v == null || v === '' || !isFinite(n) || n < 0) return null;
  return Math.round(Math.min(hi, n) * 10) / 10;
}
// kcal je 100 g aus nutriments (energy-kcal_100g bevorzugt, sonst kJ -> kcal).
function kcal100(nutr) {
  if (nutr == null) return null;
  let k = Number(nutr['energy-kcal_100g']);
  if (!isFinite(k) || k <= 0) {
    const kj = Number(nutr['energy_100g']) || Number(nutr['energy-kj_100g']);
    if (isFinite(kj) && kj > 0) k = kj / 4.184;
  }
  if (!isFinite(k) || k < 0) return null;
  return Math.min(1000, Math.round(k));   // realistische Obergrenze je 100 g
}
function validImage(url) {
  const s = String(url || '');
  if (!/^https:\/\//i.test(s)) return null;
  try { const u = new URL(s); return IMG_HOSTS.test(u.hostname) ? s.slice(0, 400) : null; } catch (e) { return null; }
}

// OFF-Rohprodukt -> normalisiertes Modell. Fehlende Werte = null (NICHT 0).
function normalize(code, p) {
  p = p || {};
  const nutr = p.nutriments || {};
  const name = String(p.product_name_de || p.product_name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const nutriments = {
    kcal100g: kcal100(nutr),
    protein100g: num(nutr.proteins_100g, 0, 100),
    carbs100g: num(nutr.carbohydrates_100g, 0, 100),
    fat100g: num(nutr.fat_100g, 0, 100),
    satfat100g: num(nutr['saturated-fat_100g'], 0, 100),
    fiber100g: num(nutr.fiber_100g, 0, 100),
    sugars100g: num(nutr.sugars_100g, 0, 100),
    salt100g: num(nutr.salt_100g, 0, 100),
  };
  // Offizielle Nutri-Score-Note von Open Food Facts (a–e), sofern vorhanden.
  const nsRaw = String(p.nutriscore_grade || p.nutrition_grades || '').trim().toLowerCase();
  const nutriScore = /^[abcde]$/.test(nsRaw) ? nsRaw.toUpperCase() : null;
  const countries = (Array.isArray(p.countries_tags) ? p.countries_tags : [])
    .slice(0, 8).map(function (c) { return String(c).replace(/^en:/, '').slice(0, 30); });
  return {
    barcode: String(code),
    name: name || null,
    brand: String(p.brands || '').split(',')[0].trim().slice(0, 80) || null,
    quantity: String(p.quantity || '').trim().slice(0, 40) || null,
    servingSize: String(p.serving_size || '').trim().slice(0, 40) || null,
    nutritionBasis: '100g',
    nutriments: nutriments,
    nutriScore: nutriScore,
    imageUrl: validImage(p.image_front_small_url) || validImage(p.image_small_url),
    countries: countries,
    source: 'openfoodfacts',
    sourceUrl: BASE + '/product/' + encodeURIComponent(String(code)),
    sourceModifiedAt: (Number(p.last_modified_t) ? Number(p.last_modified_t) * 1000 : null),
    schemaVersion: 1,
  };
}

// Ein Datensatz gilt als brauchbar, wenn Name + kcal/100 g vorhanden sind.
function isUsable(prod) {
  return !!(prod && prod.name && prod.nutriments && prod.nutriments.kcal100g != null);
}

async function doFetch(url, retriesLeft) {
  if (!hasContact) return { ok: false, error: 'not_configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    const timeout = e && e.name === 'AbortError';
    if (retriesLeft > 0) { await sleep(350); return doFetch(url, retriesLeft - 1); }
    return { ok: false, error: timeout ? 'timeout' : 'network' };
  }
  clearTimeout(timer);
  if (res.status === 404 || res.status === 400) return { ok: false, error: 'not_found', status: res.status };
  if (res.status === 429 || res.status === 503) {
    if (retriesLeft > 0) { await sleep(500); return doFetch(url, retriesLeft - 1); }
    return { ok: false, error: 'off_busy', status: res.status };
  }
  if (!res.ok) return { ok: false, error: 'off_error', status: res.status };
  // Antwortgröße begrenzen.
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > MAX_BYTES) return { ok: false, error: 'too_large' };
  let text = '';
  try { text = await res.text(); } catch (e) { return { ok: false, error: 'read_failed' }; }
  if (text.length > MAX_BYTES) return { ok: false, error: 'too_large' };
  let json = null;
  try { json = JSON.parse(text); } catch (e) { return { ok: false, error: 'bad_json' }; }
  return { ok: true, json: json };
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Produkt per Barcode. -> { ok, found, product? } | { ok:false, error }
async function fetchProduct(barcode) {
  const code = String(barcode || '').replace(/\D/g, '');
  if (code.length < 6) return { ok: false, error: 'bad_barcode' };
  const url = BASE + '/api/v2/product/' + encodeURIComponent(code) + '.json?fields=' + PRODUCT_FIELDS + '&lc=de';
  const r = await doFetch(url, 1);
  if (!r.ok) {
    if (r.error === 'not_found') return { ok: true, found: false };
    return { ok: false, error: r.error };
  }
  const j = r.json || {};
  if (Number(j.status) !== 1 || !j.product) return { ok: true, found: false };
  return { ok: true, found: true, product: normalize(code, j.product) };
}

// Textsuche (klassischer, stabiler cgi-Endpunkt). -> { ok, products:[…] } | { ok:false, error }
async function searchProducts(query, limit) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (q.length < 2) return { ok: false, error: 'query_too_short' };
  const lim = Math.max(1, Math.min(20, parseInt(limit, 10) || 10));
  const url = BASE + '/cgi/search.pl?search_terms=' + encodeURIComponent(q)
    + '&search_simple=1&action=process&json=1&page_size=' + lim
    + '&fields=' + PRODUCT_FIELDS;
  const r = await doFetch(url, 1);
  if (!r.ok) return { ok: false, error: r.error };
  const arr = (r.json && Array.isArray(r.json.products)) ? r.json.products : [];
  const products = arr.slice(0, lim)
    .map(function (p) { return normalize(String(p.code || p._id || ''), p); })
    .filter(function (p) { return p.barcode && p.name; });
  return { ok: true, products: products };
}

module.exports = {
  hasContact, USER_AGENT, BASE, PRODUCT_FIELDS,
  normalize, isUsable, validImage, kcal100,
  fetchProduct, searchProducts,
};
