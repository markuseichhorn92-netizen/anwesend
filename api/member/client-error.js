'use strict';

/**
 * POST /api/member/client-error  (Authorization: Bearer <token>)
 *
 * Nimmt JavaScript-Fehler aus der Mitglieder-App entgegen und schreibt sie in die
 * Vercel-Laufzeitlogs – dorthin schaut das Team laut Übergabe bei Problemen zuerst.
 * Vorher gab es dafür gar nichts: ein Fehler auf dem Handy eines Mitglieds blieb
 * unsichtbar, bis jemand von sich aus schrieb.
 *
 * Der Endpunkt speichert nichts. Alles, was nach personenbezogener oder geheimer
 * Angabe aussieht, wird von lib/clientErrors.js unkenntlich gemacht, bevor irgendetwas
 * geloggt wird (Vorgabe aus docs/KI-GOVERNANCE.md: keine Prompts, Antworten oder
 * Gesundheitsdaten in Fehlerlogs).
 *
 * Antwort ist immer 200 – ein fehlgeschlagener Fehlerbericht darf die App nicht
 * zusätzlich stören.
 */

const M = require('../../lib/members');
const CE = require('../../lib/clientErrors');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  // Eng begrenzen: ein Gerät in einer Fehlerschleife soll die Logs nicht fluten.
  if (!(await M.rateLimit('clienterr:' + sess.id, 20, 3600))) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited' }));
  }

  const body = await M.readBody(req);
  const rec = CE.aufbereiten(body);
  if (!rec) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, ignoriert: true })); }

  // Bewusst ohne Mitglieds-ID: für die Fehlersuche zählt WAS und WO, nicht WER.
  console.error(CE.alsLogZeile(rec));

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true }));
};
