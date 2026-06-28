'use strict';

/**
 * Vercel Serverless Function · GET /api/plan
 * ------------------------------------------
 * Öffentliche, anonyme Vorschau der für HEUTE geplanten Auslastung.
 * Liefert NUR aggregierte Zahlen (Stunde -> Anzahl), keinerlei Identitäten.
 *   { available, date, hours:{ "18":7, ... }, total }
 */

const P = require('../lib/plans');
const { dispatch } = require('../lib/remind');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  // Zuverlässiger Erinnerungs-Trigger: Live-Anzeigen pollen diesen Endpunkt während der
  // Öffnungszeiten regelmäßig. Gedrosselt per Redis-Lock -> nur ~alle 5 Min wird gesendet.
  // Best-effort: ein Fehler darf die Auslastungs-Antwort nie beeinflussen.
  try { await dispatch({ force: false }); } catch (e) {}

  try {
    const agg = await P.getAggregate();
    // CDN-cachebar: viele Viewer -> wenige Abrufe
    res.setHeader('Cache-Control', 'public, s-maxage=60, max-age=30, stale-while-revalidate=120');
    res.statusCode = 200;
    return res.end(JSON.stringify(agg));
  } catch (e) {
    console.error('[plan]', e.message);
    res.statusCode = 200; // sanft scheitern: Anzeige blendet das Overlay dann aus
    return res.end(JSON.stringify({ available: false }));
  }
};
