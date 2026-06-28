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
// Kanonischer Name ist ML_API_KEY. Als Komfort werden gängige Schreibvarianten
// akzeptiert, damit ein in Vercel z.B. als "mlapikey" angelegter Key trotzdem
// greift. Empfohlen ist trotzdem exakt ML_API_KEY.
const API_KEY        = process.env.ML_API_KEY
                    || process.env.MLAPIKEY
                    || process.env.mlapikey
                    || process.env.ML_APIKEY
                    || process.env.MAGICLINE_API_KEY;          // PFLICHT
const MAX_CAPACITY   = parseInt(process.env.MAX_CAPACITY || '40', 10);
const CACHE_TTL_MS   = parseInt(process.env.CACHE_TTL_MS || '45000', 10);

// Ampel-Schwellen in Prozent
const YELLOW_AT = parseInt(process.env.YELLOW_AT || '50', 10);
const RED_AT    = parseInt(process.env.RED_AT || '80', 10);

// Hochrechnungsfaktor: Noch nicht alle Mitglieder checken in Magicline ein
// (nicht alle sind bereits angelegt), daher liegt die gemeldete Zahl unter der
// tatsächlichen Anwesenheit. Der Faktor rechnet hoch. Über die Vercel-Env
// OCCUPANCY_FACTOR anpassbar (z. B. 2.5 oder 3); Standard 3.
// Angewendet wird ausschliesslich bei der Anzeige – die Rohwerte in der
// Historie bleiben unverändert, damit ein späterer Faktor-Wechsel sauber greift.
// Wirkt gleichermassen auf Live-Wert UND auf den typischen Verlauf ("Schema"),
// damit beide Balken zueinander passen.
const OCCUPANCY_FACTOR = (function () {
  const v = parseFloat(process.env.OCCUPANCY_FACTOR || '3');
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

const ML_URL = `https://${TENANT}.open-api.magicline.com/v1/studios/utilization`;

const config = {
  TENANT,
  MAX_CAPACITY,
  CACHE_TTL_MS,
  YELLOW_AT,
  RED_AT,
  OCCUPANCY_FACTOR,
  ML_URL,
  hasApiKey: Boolean(API_KEY),
};

// ─── Hochrechnung / Skalierung (nur Anzeige) ─────────────────────────────────
// Rohwert -> hochgerechnete, auf die Kapazität begrenzte Zahl.
function scaleCount(raw, max) {
  const n = Number.isFinite(raw) ? raw : 0;
  const scaled = Math.round(n * OCCUPANCY_FACTOR);
  return Number.isFinite(max) && max > 0 ? Math.min(max, scaled) : scaled;
}
// Wie scaleCount, lässt aber "keine Daten" (null) unangetastet (für die Historie).
function scaleVal(v, max) {
  return v == null ? null : scaleCount(v, max);
}
// Komplettes Auslastungs-Payload für die Anzeige hochrechnen (count/percent/status),
// Rohwert als rawCount + Faktor zur Transparenz mitgeben.
function presentScaled(payload) {
  if (!payload) return payload;
  const max = Number.isFinite(payload.max) ? payload.max : MAX_CAPACITY;
  const rawCount = Number.isFinite(payload.count) ? payload.count : 0;
  const count = scaleCount(rawCount, max);
  const percent = max > 0 ? Math.min(100, Math.round((count / max) * 100)) : 0;
  let status = 'low';
  if (percent >= RED_AT) status = 'high';
  else if (percent >= YELLOW_AT) status = 'medium';
  return { ...payload, count, rawCount, factor: OCCUPANCY_FACTOR, percent, status };
}

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

module.exports = { config, fetchUtilization, getCache, scaleCount, scaleVal, presentScaled, OCCUPANCY_FACTOR };
