'use strict';

/**
 * Vercel Serverless Function · GET /api/auslastung
 * ------------------------------------------------
 * Liefert die anonyme, aggregierte Auslastungs-Zahl.
 * Der Magicline-API-Key wird aus den Vercel Environment Variables gelesen
 * (Project → Settings → Environment Variables → ML_API_KEY).
 */

const { fetchUtilization, getCache, presentScaled } = require('../lib/utilization');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }

  try {
    const payload = await fetchUtilization();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify(presentScaled(payload)));
  } catch (err) {
    // Fehlender Key: saubere JSON-Antwort statt Runtime-Crash (FUNCTION_INVOCATION_FAILED)
    if (err.code === 'missing_api_key') {
      console.error('[auslastung] ML_API_KEY fehlt — in den Vercel Environment Variables setzen.');
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        error: 'missing_api_key',
        hint: 'ML_API_KEY in den Vercel-Projekteinstellungen (Environment Variables) setzen und neu deployen.',
      }));
    }

    console.error('[auslastung]', err.message);
    // Bei kurzem Magicline-Aussetzer: letzten bekannten Wert ausliefern statt hart zu failen
    const cache = getCache();
    if (cache.payload) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(JSON.stringify(presentScaled({ ...cache.payload, cached: true, stale: true })));
    }

    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'upstream_unavailable' }));
  }
};
