'use strict';

/**
 * POST /api/team/client-error  (Authorization: Bearer <team-token>)
 *
 * Gegenstück zu /api/member/client-error für das Team-Backend. Schreibt
 * JavaScript-Fehler aus der Team-Oberfläche in die Vercel-Laufzeitlogs, damit sie
 * nicht unbemerkt bleiben. Speichert nichts.
 *
 * Bewusst ohne Capability-Prüfung: jede angemeldete Team-Sitzung darf melden, dass
 * ihre Oberfläche kaputt ist – ein Rechte-Gate würde hier nur Fehler verschlucken.
 * Der Inhalt wird von lib/clientErrors.js unkenntlich gemacht (keine Mitgliedsdaten
 * in Logs), die Mitarbeiter-Kennung wird nicht mitgeschrieben.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');   // readBody, rateLimit
const CE = require('../../lib/clientErrors');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  if (!(await M.rateLimit('teamerr:' + (sess.id || sess.user || 'team'), 20, 3600))) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited' }));
  }

  const body = await M.readBody(req);
  const rec = CE.aufbereiten(body);
  if (!rec) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, ignoriert: true })); }

  console.error('[team] ' + CE.alsLogZeile(rec));

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true }));
};
