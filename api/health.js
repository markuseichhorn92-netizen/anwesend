'use strict';

/**
 * Vercel Serverless Function · GET /api/health
 *
 * Sagt zusaetzlich, WELCHER Stand gerade laeuft. Ohne das ist nach jeder
 * Aenderung die erste Frage unbeantwortbar: "ist das ueberhaupt schon
 * ausgerollt?" - und man sucht den Fehler im Code, obwohl noch der alte Stand
 * antwortet. Der Commit-Kurzname ist kein Geheimnis; Vercel gibt die
 * Deployment-ID ohnehin in jedem Antwort-Header mit.
 */

const SHA = String(process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null;
const REGION = process.env.VERCEL_REGION || null;

module.exports = function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: true, version: SHA, region: REGION }));
};
