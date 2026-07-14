'use strict';

/**
 * Produktkatalog + Cache/Locks/Limits für Open Food Facts (Upstash-Backend).
 * -------------------------------------------------------------------------
 * Klar gekapselte Speicherschicht, damit später ohne API-Änderung auf Postgres
 * (Neon/Supabase) gewechselt werden kann: NUR die Funktionen catalogGet/catalogPut/
 * searchCatalog müssten dann gegen Postgres reimplementiert werden – Cache, Locks
 * und globale Limits bleiben auf Upstash.
 *
 * Ablauf (siehe docs/OPEN-FOOD-FACTS.md):
 *   Barcode -> Negativ-Cache -> Katalog/Cache -> (nur wenn nötig) Open Food Facts
 * Mit Cache-Stampede-Schutz (Redis-Lock, Request-Coalescing) und ATOMAREM globalem
 * Rate Limit (INCR+EXPIRE), das für die GESAMTE App gilt.
 *
 * Produktdaten sind GEMEINSCHAFTLICH (keine Mitgliedskennung!). Persönliche
 * Favoriten/Mahlzeiten liegen getrennt in api/member/nutrition.js.
 */

const crypto = require('node:crypto');
const { redisPipeline, hasStore } = require('./store');

const CFG = {
  freshDays: parseInt(process.env.OPENFOODFACTS_FRESH_DAYS || '', 10) || 7,
  maxStaleDays: parseInt(process.env.OPENFOODFACTS_MAX_STALE_DAYS || '', 10) || 30,
  productLimitPerMin: parseInt(process.env.OPENFOODFACTS_PRODUCT_LIMIT_PER_MINUTE || '', 10) || 12,
  searchLimitPerMin: parseInt(process.env.OPENFOODFACTS_SEARCH_LIMIT_PER_MINUTE || '', 10) || 8,
  negTtlSec: 16 * 3600,     // nicht gefundene Barcodes 16 h negativ cachen
  searchTtlSec: 3 * 3600,   // Suchergebnisse 3 h cachen
  lockTtlSec: 8,            // kurzer Lock gegen parallele identische Abfragen
  hotTtlSec: 30 * 86400,    // „heiß"-Markierung für optionalen Cron
};

const K = {
  product: (b) => 'off:product:' + b,
  search: (h) => 'off:search:' + h,
  missing: (b) => 'off:missing:' + b,
  lock: (b) => 'off:lock:' + b,
  limit: (kind, min) => 'off:limit:' + kind + ':' + min,
  hot: (b) => 'off:hot:' + b,
};

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ── Barcode-Validierung (GTIN-8/12/13/14 mit Prüfziffer) ──
function normalizeBarcode(raw) {
  const code = String(raw || '').replace(/\D/g, '');
  if ([8, 12, 13, 14].indexOf(code.length) < 0) return null;
  const d = code.split('').map(Number);
  const check = d.pop();
  let sum = 0;
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = (w === 3 ? 1 : 3)) sum += d[i] * w;
  return ((10 - (sum % 10)) % 10) === check ? code : null;
}
// Für Freitext-/Locks toleranter (8–14 Ziffern), aber Prüfziffer bevorzugt.
function looseBarcode(raw) {
  const strict = normalizeBarcode(raw);
  if (strict) return strict;
  const code = String(raw || '').replace(/\D/g, '');
  return (code.length >= 8 && code.length <= 14) ? code : null;
}

// ── Katalog (gemeinschaftliche Produkte) ──
async function catalogGet(barcode) {
  if (!hasStore) return null;
  try { const [v] = await redisPipeline([['GET', K.product(barcode)]]); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
async function catalogPut(prod, prev) {
  if (!hasStore || !prod || !prod.barcode) return prod;
  const now = Date.now();
  const rec = Object.assign({}, prod, {
    cachedAt: (prev && prev.cachedAt) || prod.cachedAt || now,
    lastCheckedAt: now,
    lastUsedAt: (prev && prev.lastUsedAt) || prod.lastUsedAt || 0,
    usageCount: (prev && prev.usageCount) || prod.usageCount || 0,
    schemaVersion: prod.schemaVersion || 1,
  });
  try { await redisPipeline([['SET', K.product(prod.barcode), JSON.stringify(rec)]]); } catch (e) {}
  return rec;
}
async function bumpUsage(barcode) {
  if (!hasStore) return;
  const rec = await catalogGet(barcode);
  if (!rec) return;
  rec.usageCount = (rec.usageCount || 0) + 1;
  rec.lastUsedAt = Date.now();
  try { await redisPipeline([['SET', K.product(barcode), JSON.stringify(rec)], ['SET', K.hot(barcode), '1', 'EX', String(CFG.hotTtlSec)]]); } catch (e) {}
}

// ── Negativ-Cache ──
async function negGet(barcode) { if (!hasStore) return false; try { const [v] = await redisPipeline([['GET', K.missing(barcode)]]); return !!v; } catch (e) { return false; } }
async function negPut(barcode) { if (!hasStore) return; try { await redisPipeline([['SET', K.missing(barcode), '1', 'EX', String(CFG.negTtlSec)]]); } catch (e) {} }

// ── Such-Cache ──
function searchHash(q, lim) { return crypto.createHash('sha1').update(q.toLowerCase() + '|' + lim).digest('hex').slice(0, 20); }
async function searchCacheGet(q, lim) { if (!hasStore) return null; try { const [v] = await redisPipeline([['GET', K.search(searchHash(q, lim))]]); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
async function searchCachePut(q, lim, products) { if (!hasStore) return; try { await redisPipeline([['SET', K.search(searchHash(q, lim)), JSON.stringify(products), 'EX', String(CFG.searchTtlSec)]]); } catch (e) {} }

// ── Locks (Coalescing) ──
async function acquireLock(barcode) { if (!hasStore) return true; try { const [r] = await redisPipeline([['SET', K.lock(barcode), '1', 'NX', 'EX', String(CFG.lockTtlSec)]]); return r === 'OK'; } catch (e) { return false; } }
async function releaseLock(barcode) { if (!hasStore) return; try { await redisPipeline([['DEL', K.lock(barcode)]]); } catch (e) {} }

// ── Globales, atomares Rate Limit (gilt app-weit, nicht pro Mitglied) ──
async function underGlobalLimit(kind) {
  if (!hasStore) return false;
  const minute = Math.floor(Date.now() / 60000);
  const key = K.limit(kind, minute);
  const max = kind === 'search' ? CFG.searchLimitPerMin : CFG.productLimitPerMin;
  try {
    const [n] = await redisPipeline([['INCR', key]]);
    if (Number(n) === 1) { try { await redisPipeline([['EXPIRE', key, '70']]); } catch (e) {} }
    return Number(n) <= max;
  } catch (e) { return false; }   // Store-Fehler -> keinen externen Call wagen
}

// ── Orchestrierung Barcode: Cache -> Katalog -> (nur bei Bedarf) OFF ──
// off = lib/openFoodFacts (injizierbar für Tests). Liefert immer ein kontrolliertes
// Ergebnis; nie eine Rohantwort. source ∈ cache|catalog|openfoodfacts.
async function getProductByBarcode(rawBarcode, off) {
  const barcode = normalizeBarcode(rawBarcode) || looseBarcode(rawBarcode);
  if (!barcode) return { ok: false, error: 'bad_barcode' };

  if (await negGet(barcode)) return { ok: true, found: false, source: 'cache' };

  const rec = await catalogGet(barcode);
  const now = Date.now();
  const ageDays = rec ? (now - (rec.lastCheckedAt || rec.cachedAt || 0)) / 86400000 : Infinity;

  // Frisch genug -> direkt aus Katalog.
  if (rec && ageDays < CFG.freshDays) { bumpUsage(barcode); return { ok: true, found: true, product: rec, source: 'catalog', stale: false }; }

  // Refresh nötig -> Coalescing per Lock.
  const locked = await acquireLock(barcode);
  if (!locked) {
    if (rec) { bumpUsage(barcode); return { ok: true, found: true, product: rec, source: 'catalog', stale: true }; }
    await sleep(200);
    const rec2 = await catalogGet(barcode);
    if (rec2) { bumpUsage(barcode); return { ok: true, found: true, product: rec2, source: 'cache', stale: false }; }
    if (await negGet(barcode)) return { ok: true, found: false, source: 'cache' };
    return { ok: true, found: false, source: 'busy', busy: true };
  }
  try {
    if (!(await underGlobalLimit('product'))) {
      if (rec) { bumpUsage(barcode); return { ok: true, found: true, product: rec, source: 'catalog', stale: true, rateLimited: true }; }
      return { ok: false, error: 'rate_limited' };
    }
    const r = await off.fetchProduct(barcode);
    if (r.ok && r.found) {
      const stored = await catalogPut(r.product, rec);
      await bumpUsage(barcode);
      return { ok: true, found: true, product: stored, source: 'openfoodfacts', stale: false, incomplete: !off.isUsable(stored) };
    }
    if (r.ok && !r.found) { await negPut(barcode); return { ok: true, found: false, source: 'openfoodfacts' }; }
    // OFF-Fehler/Timeout: alten Katalog weiterverwenden (stale), sonst kontrollierter Fehler.
    if (rec) { bumpUsage(barcode); return { ok: true, found: true, product: rec, source: 'catalog', stale: true, offError: r.error }; }
    if (r.error === 'not_configured') return { ok: false, error: 'not_configured' };
    return { ok: false, error: 'off_unavailable', detail: r.error };
  } finally { await releaseLock(barcode); }
}

// ── Suche: Cache -> (lokaler Katalog: nur mit Postgres-Fulltext) -> OFF (gecacht) ──
async function searchProducts(query, limit, off) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (q.length < 2) return { ok: false, error: 'query_too_short' };
  const lim = Math.max(1, Math.min(20, parseInt(limit, 10) || 10));

  const cached = await searchCacheGet(q, lim);
  if (cached) return { ok: true, products: cached, source: 'cache' };

  if (!(await underGlobalLimit('search'))) return { ok: false, error: 'rate_limited' };
  const r = await off.searchProducts(q, lim);
  if (!r.ok) return { ok: false, error: r.error };
  const products = r.products || [];
  // Brauchbare Treffer in den gemeinschaftlichen Katalog übernehmen.
  try { for (const p of products.slice(0, lim)) { if (off.isUsable(p)) await catalogPut(p, await catalogGet(p.barcode)); } } catch (e) {}
  await searchCachePut(q, lim, products);
  return { ok: true, products: products, source: 'openfoodfacts' };
}

module.exports = {
  CFG, K, normalizeBarcode, looseBarcode,
  catalogGet, catalogPut, bumpUsage, negGet, negPut,
  searchCacheGet, searchCachePut, acquireLock, releaseLock, underGlobalLimit,
  getProductByBarcode, searchProducts,
};
