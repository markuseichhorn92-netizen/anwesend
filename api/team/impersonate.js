'use strict';

/**
 * POST /api/team/impersonate   (Team-Session erforderlich, nur Admin)
 *   { id: "<memberId>" }  ->  { ok, url }
 *
 * Erzeugt einen kurzlebigen (5 Min), EINMALIGEN Magic-Login-Token und liefert
 * den Deeplink in den Mitgliederbereich dieses Mitglieds zurück. Das Team kann
 * sich so zu Support-Zwecken direkt als das Mitglied anmelden („Login als …").
 *
 * Sicherheit: bewusst Admin-only (man handelt danach in der Sitzung des
 * Mitglieds), Token einmalig + kurz gültig, Anti-Spam pro Mitglied, und jeder
 * Aufruf wird protokolliert (wer hat sich als wen angemeldet).
 */

const crypto = require('node:crypto');
const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');
const { PUBLIC_BASE } = require('../../lib/magic');

const TTL_SEC = 300;   // 5 Minuten – reicht zum einmaligen Öffnen

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!TA.isAdmin(sess)) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Nur Admins dürfen sich als Mitglied anmelden.' })); }
  if (!M.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Login als Mitglied ist ohne Datenspeicher nicht möglich.' })); }

  const body = await M.readBody(req);
  const id = String((body && (body.id || body.memberId)) || '').trim();
  if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, message: 'Mitglied fehlt.' })); }

  // Anti-Spam pro Mitglied (ein Support-Login sollte selten sein).
  if (!(await M.rateLimit('impersonate:' + id, 10, 3600))) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Anmelde-Links für dieses Mitglied – bitte kurz warten.' }));
  }

  const m = await M.getMember(id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found', message: 'Mitglied nicht gefunden.' })); }

  const token = crypto.randomBytes(24).toString('hex');
  try {
    await M.mlinkSave(token, { id: id, exp: Date.now() + TTL_SEC * 1000, reusable: false }, TTL_SEC);
  } catch (e) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Anmelde-Link konnte nicht erstellt werden.' }));
  }

  // Protokoll (Accountability): wer hat sich als wen angemeldet.
  try {
    const who = (sess && (sess.user || sess.name || sess.id)) || 'team';
    console.log('[impersonate] staff=' + who + ' member=' + id + ' at=' + new Date().toISOString());
  } catch (e) {}

  const url = PUBLIC_BASE + '/?mlt=' + token;
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, url: url }));
};
