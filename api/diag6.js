'use strict';

/** TEMPORÄR. GET /api/diag6?k=fitinn-probe-2026
 * Prüft, ob die Open API einen Self-Check-in (Schreiben) erlaubt.
 * NUR mit ungültiger id (0) + leerem Body -> es wird nichts Echtes verändert.
 * Liefert nur Status + kurze Fehlermeldung je Endpoint-Variante. */

const M = require('../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('k') !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end('{}'); }

  const today = new Date().toISOString();
  const candidates = [
    ['POST', '/customers/0/activities/checkins', {}],
    ['POST', '/customers/0/checkins', {}],
    ['POST', '/customers/0/checkin', {}],
    ['POST', '/customers/0/activities/checkins', { checkInDateTime: today, studioId: 1210005460 }],
    ['POST', '/checkins', { customerId: 0 }],
    ['POST', '/checkin', { customerId: 0 }],
    ['POST', '/access/checkin', { customerId: 0 }],
    ['POST', '/customers/0/access', {}],
    ['POST', '/studios/1210005460/checkins', { customerId: 0 }],
    // GET um zu sehen welche Methoden der bekannte READ-Pfad kennt
    ['GET', '/customers/0/activities/checkins', undefined],
  ];

  const out = [];
  for (const [method, path, body] of candidates) {
    try {
      const r = await M.ml(method, path, body);
      let msg = '';
      if (r.json && r.json.errorMessage) msg = String(r.json.errorMessage).slice(0, 80) + ' [' + (r.json.errorCode || '') + ']';
      else if (!r.json) msg = String(r.text || '').slice(0, 80);
      out.push({ method, path, status: r.status, msg });
    } catch (e) {
      out.push({ method, path, status: 'ERR', msg: e.message });
    }
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({ results: out }, null, 2));
};
