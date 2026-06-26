'use strict';

/**
 * Fit-Inn Trier · Live-Auslastung — geteilte Logik
 * ------------------------------------------------
 * Holt die aktuelle Personenzahl aus der Magicline Open API
 * (GET /v1/studios/utilization), cached sie und baut die
 * anonyme, aggregierte JSON-Antwort.
 *
 * Wird von beiden Deployment-Varianten genutzt:
 *   - server.js            (Standalone-Node-Server / Docker / VPS)
 *   - api/auslastung.js    (Vercel Serverless Function)
 *
 * Der API-Key bleibt ausschliesslich serverseitig (Umgebungsvariable)
 * und taucht NIE im Browser auf.
 *
 * Wichtig: Hier wird NICHT process.exit() aufgerufen. Ein fehlender
 * Key wird als Fehler geworfen, damit die Serverless-Funktion sauber
 * eine JSON-Antwort liefern kann statt den Runtime zu crashen.
 */

// ─── Konfiguration (aus Umgebungsvariablen) ──────────────────────────────────
const TENANT         = process.env.ML_TENANT || 'fit-inn-trier';
const API_KEY        = process.env.ML_API_KEY;                  // PFLICHT
const MAX_CAPACITY   = parseInt(process.env.MAX_CAPACITY || '80', 10);
const CACHE_TTL_MS   = parseInt(process.env.CACHE_TTL_MS || '45000', 10);

// Ampel-Schwellen in Prozent
const YELLOW_AT = parseInt(process.env.YELLOW_AT || '50', 10);
const RED_AT    = parseInt(process.env.RED_AT || '80', 10);

const ML_URL = `https://${TENANT}.open-api.magicline.com/v1/studios/utilization`;

const config = {
  TENANT,
  MAX_CAPACITY,
  CACHE_TTL_MS,
  YELLOW_AT,
  RED_AT,
  ML_URL,
  hasApiKey: Boolean(API_KEY),
};

// ─── Cache ───────────────────────────────────────────────────────────────────
// In Serverless-Umgebungen lebt der Cache pro warmer Instanz — das reduziert
// die Magicline-Aufrufe trotzdem deutlich (Schutz vor Rate-Limit / 429).
let cache = { payload: null, ts: 0 };

function getCache() {
  return cache;
}

async function fetchUtilization() {
  if (!API_KEY) {
    const err = new Error('ML_API_KEY ist nicht gesetzt');
    err.code = 'missing_api_key';
    throw err;
  }

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

module.exports = { config, fetchUtilization, getCache };
