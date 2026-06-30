'use strict';

/**
 * POST /api/member/checkin   (Authorization: Bearer <token>)
 * In-App-Check-in: trägt einen Studio-Besuch des angemeldeten Mitglieds in
 * Magicline ein (Scope CHECKIN_WRITE → POST /v1/customers/{id}/checkin).
 * Leichter Spam-Schutz: wenige Versuche pro 30 Minuten.
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  // Doppel-/Spam-Schutz: max. 3 Versuche je 30 Min (erlaubt Wiederholung bei Fehler).
  if (!(await M.rateLimit('checkin:' + sess.id, 3, 1800))) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Du hast dich gerade erst eingecheckt.' }));
  }

  const at = new Date().toISOString();
  let r;
  try { r = await M.checkinCustomer(sess.id, at); } catch (e) { r = { status: 0 }; }

  if (r && r.status >= 200 && r.status < 300) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, at: at, message: 'Eingecheckt – viel Spaß beim Training! 💪' }));
  }
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: false, message: 'Check-in gerade nicht möglich. Bitte an der Theke einchecken.' }));
};
