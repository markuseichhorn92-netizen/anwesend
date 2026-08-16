'use strict';

/**
 * Vercel Serverless Function · GET /api/hours
 * -------------------------------------------
 * Liest die in Magicline hinterlegten Öffnungszeiten über
 * GET /v1/studios/information (benötigt die STUDIO_READ-Berechtigung am Key).
 *
 * Die eigentliche Abfrage liegt in lib/studioHours – dieselbe Logik nutzt der
 * Telefonassistent direkt, ohne den Umweg über einen HTTP-Aufruf hierher.
 *
 * ?debug=1  -> liefert zusätzlich die komplette Roh-Antwort von Magicline
 *              (zum Prüfen, welche Felder es gibt – z.B. Feiertage).
 */

const { fetchHours, TTL_MS } = require('../lib/studioHours');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const url = URL_(req.url);
  const debug = url.get('debug') === '1';

  const out = await fetchHours({ raw: debug });
  if (out.available && !debug) {
    res.setHeader('Cache-Control', 'public, s-maxage=' + Math.floor(TTL_MS / 1000) + ', stale-while-revalidate=120');
  }
  if (!out.available && out.error === 'missing_api_key') {
    res.statusCode = 500;
    return res.end(JSON.stringify({ available: false, error: 'missing_api_key' }));
  }
  // Auch Fehler kommen als 200 mit available:false – das Widget blendet dann aus,
  // statt eine rote Meldung zu zeigen.
  res.statusCode = 200;
  return res.end(JSON.stringify(out));
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
