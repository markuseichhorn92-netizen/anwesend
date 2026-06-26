'use strict';

/**
 * Vercel Serverless Function · GET /api/hours
 * -------------------------------------------
 * Liest die in Magicline hinterlegten Öffnungszeiten über
 * GET /v1/studios/information (benötigt die STUDIO_READ-Berechtigung am Key).
 *
 * Gibt die wöchentlichen Öffnungszeiten + closingDate/openingDate zurück, damit
 * das Widget den Status (Geöffnet/Pause/Geschlossen) aus den echten Zeiten
 * berechnen kann statt aus fest hinterlegten Werten.
 *
 * ?debug=1  -> liefert zusätzlich die komplette Roh-Antwort von Magicline
 *              (zum Prüfen, welche Felder es gibt – z.B. Feiertage).
 */

const TENANT = process.env.ML_TENANT || 'fit-inn-trier';
const API_KEY =
  process.env.ML_API_KEY ||
  process.env.MLAPIKEY ||
  process.env.mlapikey ||
  process.env.ML_APIKEY ||
  process.env.MAGICLINE_API_KEY;
const URL = `https://${TENANT}.open-api.magicline.com/v1/studios/information`;
const TTL_MS = 3600000; // 1 Stunde – Öffnungszeiten ändern sich selten

let cache = { data: null, ts: 0 };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (!API_KEY) { res.statusCode = 500; return res.end(JSON.stringify({ available: false, error: 'missing_api_key' })); }

  const url = new URL_(req.url);
  const debug = url.get('debug') === '1';

  try {
    const now = Date.now();
    if (!debug && cache.data && now - cache.ts < TTL_MS) {
      res.setHeader('Cache-Control', 'public, s-maxage=3600');
      res.statusCode = 200;
      return res.end(JSON.stringify({ ...cache.data, cached: true }));
    }

    const r = await fetch(URL, { headers: { 'x-api-key': API_KEY, Accept: 'application/json' } });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      res.statusCode = 200; // sanft scheitern
      return res.end(JSON.stringify({
        available: false,
        status: r.status,
        hint: (r.status === 401 || r.status === 403)
          ? 'Der API-Key hat vermutlich keine STUDIO_READ-Berechtigung. Im Magicline Developer Portal aktivieren.'
          : 'Magicline-Fehler beim Abruf der Studio-Informationen.',
        body: body.slice(0, 400),
      }));
    }

    const data = await r.json();
    const out = {
      available: true,
      studioName: data.name || data.studioName || null,
      openingHours: data.openingHours || data.openingHourRanges || data.businessHours || null,
      closingDate: (data.closingDate !== undefined) ? data.closingDate : null,
      openingDate: (data.openingDate !== undefined) ? data.openingDate : null,
    };
    if (debug) out.raw = data;

    if (!debug) { cache = { data: out, ts: now }; res.setHeader('Cache-Control', 'public, s-maxage=3600'); }
    res.statusCode = 200;
    return res.end(JSON.stringify(out));
  } catch (err) {
    console.error('[hours]', err.message);
    res.statusCode = 200;
    return res.end(JSON.stringify({ available: false, error: err.message }));
  }
};

// kleiner Helfer, um Query-Parameter ohne Host zu lesen
function URL_(reqUrl) {
  var q = {};
  var i = String(reqUrl || '').indexOf('?');
  if (i >= 0) {
    String(reqUrl).slice(i + 1).split('&').forEach(function (kv) {
      var p = kv.split('='); q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
    });
  }
  return { get: function (k) { return q[k]; } };
}
