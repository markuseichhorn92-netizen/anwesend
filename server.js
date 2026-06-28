'use strict';

/**
 * Fit-Inn Trier · Live-Auslastung Proxy (Standalone / Docker / VPS)
 * ----------------------------------------------------------------
 * Langlaufender Node-HTTP-Server für die VPS-/Docker-Variante.
 * Die eigentliche Logik liegt in lib/utilization.js und wird mit der
 * Vercel-Variante (api/auslastung.js) geteilt.
 *
 * Endpunkte:
 *   GET /api/auslastung  ->  { count, max, percent, status, ... }
 *   GET /health          ->  { ok: true }
 *
 * Hinweis: Für ein Vercel-Deployment wird DIESE Datei nicht gebraucht —
 * dort übernehmen die Functions unter /api. Siehe README.
 */

const http = require('node:http');
const { config, fetchUtilization, getCache, presentScaled } = require('./lib/utilization');

const PORT           = parseInt(process.env.PORT || '8080', 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!config.hasApiKey) {
  console.error('FATAL: ML_API_KEY ist nicht gesetzt. Bitte in der .env hinterlegen.');
  process.exit(1);
}

// ─── HTTP-Server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/api/auslastung' && req.method === 'GET') {
    try {
      const payload = await fetchUtilization();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(presentScaled(payload)));
    } catch (err) {
      console.error('[auslastung]', err.message);
      // Bei kurzem Magicline-Aussetzer: letzten bekannten Wert ausliefern statt hart zu failen
      const cache = getCache();
      if (cache.payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(presentScaled({ ...cache.payload, cached: true, stale: true })));
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'upstream_unavailable' }));
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(PORT, () => {
  console.log(`✓ Auslastungs-Proxy läuft auf :${PORT}`);
  console.log(`  → Quelle:  ${config.ML_URL}`);
  console.log(`  → Max:     ${config.MAX_CAPACITY} Personen`);
  console.log(`  → Cache:   ${config.CACHE_TTL_MS} ms`);
  console.log(`  → Ampel:   grün < ${config.YELLOW_AT}%  ·  gelb ${config.YELLOW_AT}–${config.RED_AT - 1}%  ·  rot ≥ ${config.RED_AT}%`);
});
