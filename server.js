'use strict';

/**
 * Fit-Inn Trier · Live-Auslastung Proxy
 * --------------------------------------
 * Holt die aktuelle Personenzahl aus der Magicline Open API
 * (GET /v1/studios/utilization), cached sie und liefert eine
 * anonyme, aggregierte JSON-Antwort an das Frontend.
 *
 * Der API-Key bleibt ausschliesslich hier auf dem Server (in der .env)
 * und taucht NIE im Browser auf.
 *
 * Endpunkte:
 *   GET /api/auslastung  ->  { count, max, percent, status, ... }
 *   GET /health          ->  { ok: true }
 */

const http = require('node:http');

// ─── Konfiguration (aus .env / Umgebungsvariablen) ───────────────────────────
const PORT           = parseInt(process.env.PORT || '8080', 10);
const TENANT         = process.env.ML_TENANT || 'fit-inn-trier';
const API_KEY        = process.env.ML_API_KEY;                  // PFLICHT
const MAX_CAPACITY   = parseInt(process.env.MAX_CAPACITY || '80', 10);
const CACHE_TTL_MS   = parseInt(process.env.CACHE_TTL_MS || '45000', 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// Ampel-Schwellen in Prozent
const YELLOW_AT = parseInt(process.env.YELLOW_AT || '50', 10);
const RED_AT    = parseInt(process.env.RED_AT || '80', 10);

const ML_URL = `https://${TENANT}.open-api.magicline.com/v1/studios/utilization`;

if (!API_KEY) {
  console.error('FATAL: ML_API_KEY ist nicht gesetzt. Bitte in der .env hinterlegen.');
  process.exit(1);
}

// ─── Cache ───────────────────────────────────────────────────────────────────
let cache = { payload: null, ts: 0 };

async function fetchUtilization() {
  const now = Date.now();
  if (cache.payload && now - cache.ts < CACHE_TTL_MS) {
    return { ...cache.payload, cached: true };
  }

  const res = await fetch(ML_URL, {
    headers: { 'x-api-key': API_KEY, Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Magicline API antwortete mit ${res.status}`);
  }

  const data = await res.json();                 // { capacity, count }
  const count = Number.isFinite(data.count) ? data.count : 0;
  const max = MAX_CAPACITY;
  const percent = max > 0 ? Math.min(100, Math.round((count / max) * 100)) : 0;

  let status = 'low';
  if (percent >= RED_AT) status = 'high';
  else if (percent >= YELLOW_AT) status = 'medium';

  const payload = {
    count,
    max,
    percent,
    status,
    rawCapacity: data.capacity ?? null,           // was Magicline selbst meldet (aktuell null)
    updatedAt: new Date().toISOString(),
  };

  cache = { payload, ts: now };
  return { ...payload, cached: false };
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
      return res.end(JSON.stringify(payload));
    } catch (err) {
      console.error('[auslastung]', err.message);
      // Bei kurzem Magicline-Aussetzer: letzten bekannten Wert ausliefern statt hart zu failen
      if (cache.payload) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ...cache.payload, cached: true, stale: true }));
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
  console.log(`  → Quelle:  ${ML_URL}`);
  console.log(`  → Max:     ${MAX_CAPACITY} Personen`);
  console.log(`  → Cache:   ${CACHE_TTL_MS} ms`);
  console.log(`  → Ampel:   grün < ${YELLOW_AT}%  ·  gelb ${YELLOW_AT}–${RED_AT - 1}%  ·  rot ≥ ${RED_AT}%`);
});
