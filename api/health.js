'use strict';

/**
 * Vercel Serverless Function · GET /api/health
 *
 * Sagt zusaetzlich, WELCHER Stand gerade laeuft. Ohne das ist nach jeder
 * Aenderung die erste Frage unbeantwortbar: "ist das ueberhaupt schon
 * ausgerollt?" - und man sucht den Fehler im Code, obwohl noch der alte Stand
 * antwortet. Der Commit-Kurzname ist kein Geheimnis; Vercel gibt die
 * Deployment-ID ohnehin in jedem Antwort-Header mit.
 *
 * `version` allein reicht dafuer aber NICHT: Vercel uebernimmt geaenderte
 * Umgebungsvariablen nur in ein NEUES Deployment. Wer nur die Variable setzt
 * und dann denselben Commit neu ausrollt, sieht weiterhin dieselbe `version` -
 * und haelt den Ausrollvorgang faelschlich fuer ausgeblieben. Deshalb zusaetzlich
 * `deployment`: die aendert sich bei jedem Ausrollen, auch beim selben Commit.
 */

const SHA = String(process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null;
const REGION = process.env.VERCEL_REGION || null;
// VERCEL_DEPLOYMENT_ID gibt es nicht ueberall; VERCEL_URL enthaelt dieselbe
// Kennung im Hostnamen (…-abc123-team.vercel.app) und ist zuverlaessig gesetzt.
const DEPLOY = (function () {
  const d = String(process.env.VERCEL_DEPLOYMENT_ID || '').trim();
  if (d) return d.slice(-12);
  const u = String(process.env.VERCEL_URL || '').split('.')[0];
  return u ? u.slice(-12) : null;
})();

module.exports = function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: true, version: SHA, deployment: DEPLOY, region: REGION }));
};
