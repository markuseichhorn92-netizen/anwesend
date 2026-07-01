'use strict';

/**
 * GET /api/nutrition/food?q=<suchbegriff>   – Lebensmittel-Suche (echte Nährwerte)
 * GET /api/nutrition/food?upc=<barcode>     – Produkt per Barcode/UPC
 * -----------------------------------------------------------------------------
 * Nutzt Spoonacular (lib/spoonacular.js). Namen werden ins Deutsche übersetzt.
 * Ohne SPOONACULAR_API_KEY -> Demo-Liste (source:'demo'), damit die UI weiterläuft.
 *
 * Grundgerüst-Endpoint: keine Mitglieder-Anmeldung nötig (zum Testen),
 * IP-ratenbegrenzt, um das Spoonacular-Kontingent zu schonen.
 */

const SP = require('../../lib/spoonacular');

// In-Memory-Ratenbremse pro warmer Instanz.
const hits = new Map();
function rateOk(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 60;
  const arr = (hits.get(ip) || []).filter(function (t) { return now - t < win; });
  arr.push(now); hits.set(ip, arr);
  return arr.length <= max;
}

const DEMO = [
  { name: 'Hähnchenbrust', per: '100 g', kcal: 165, p: 31, c: 0, f: 4, emoji: '🍗', bg: '#FBEFE8' },
  { name: 'Magerquark', per: '100 g', kcal: 68, p: 12, c: 4, f: 0, emoji: '🧀', bg: '#FBF2E1' },
  { name: 'Haferflocken', per: '100 g', kcal: 372, p: 13, c: 59, f: 7, emoji: '🥣', bg: '#FBF2E1' },
  { name: 'Reis, gekocht', per: '100 g', kcal: 130, p: 3, c: 28, f: 0, emoji: '🍚', bg: '#E9F6EE' },
  { name: 'Banane', per: '100 g', kcal: 89, p: 1, c: 23, f: 0, emoji: '🍌', bg: '#FBF2E1' },
  { name: 'Ei', per: '100 g', kcal: 155, p: 13, c: 1, f: 11, emoji: '🥚', bg: '#FBF2E1' },
  { name: 'Mandeln', per: '100 g', kcal: 579, p: 21, c: 22, f: 49, emoji: '🌰', bg: '#FBEFE8' },
  { name: 'Skyr', per: '100 g', kcal: 63, p: 11, c: 4, f: 0, emoji: '🥛', bg: '#EAF4FB' }
];
function demoFilter(q) {
  q = String(q || '').toLowerCase().trim();
  return q ? DEMO.filter(function (d) { return d.name.toLowerCase().indexOf(q) >= 0; }) : DEMO;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!rateOk(ip)) { res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited' })); }

  let url; try { url = new URL(req.url, 'http://x'); } catch (e) { url = { searchParams: new Map() }; }
  const q = (url.searchParams.get && url.searchParams.get('q')) || '';
  const upc = (url.searchParams.get && url.searchParams.get('upc')) || '';

  try {
    // ── Barcode/UPC ──
    if (upc) {
      const r = await SP.productByUpc(upc);
      if (r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, source: 'spoonacular', product: r.product })); }
      // Fallback-Demo-Produkt
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, source: 'demo', product: { name: 'Skyr Vanille (Arla)', brand: 'Arla', per: '1 Becher (150 g)', kcal: 98, p: 15, c: 8, f: 0, emoji: '🥛', bg: '#EAF4FB' }, note: r.error }));
    }

    // ── Lebensmittel-Suche ──
    if (SP.hasKey) {
      const r = await SP.searchFoods(q, 6);
      if (r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, source: 'spoonacular', foods: r.foods })); }
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, source: 'demo', foods: demoFilter(q), note: r.error }));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, source: 'demo', foods: demoFilter(q) }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, source: 'demo', foods: demoFilter(q), note: 'error' }));
  }
};
