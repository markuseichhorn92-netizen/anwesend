'use strict';

/**
 * GET /api/trial/info?t=<token>
 * Liefert die (minimalen) Eckdaten eines gebuchten Probetrainings für die
 * öffentliche Info-Seite. Nur Vorname + Termin – keine sensiblen Daten.
 * Unbekannter/abgelaufener Token oder kein Store -> 404 (kein Fehler).
 */

const { redisPipeline, hasStore } = require('../../lib/store');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const t = new URL(req.url, 'http://x').searchParams.get('t') || '';
  if (!/^[a-f0-9]{16,64}$/.test(t) || !hasStore) {
    res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  }

  let rec = null;
  try { const [v] = await redisPipeline([['GET', 'trial:' + t]]); if (v) rec = JSON.parse(v); } catch (e) {}
  if (!rec) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }

  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: true,
    trial: { firstname: rec.firstname || '', startDateTime: rec.startDateTime || null },
  }));
};
