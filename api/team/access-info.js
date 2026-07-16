'use strict';

/**
 * POST /api/team/access-info   (Bearer Team-Token)
 *   { id }  -> Schickt dem Mitglied eine E-Mail mit seinen Zugangs-Infos zum
 *   Mitgliederbereich (Mitgliedsnummer, wie man sich anmeldet, Direkt-Link).
 *
 * Manueller Weg (Button im Team-Profil) – ohne Dedup, damit das Team bewusst
 * erneut senden kann. Die automatische Variante läuft über den Magicline-Webhook
 * (api/webhooks/magicline.js) und nutzt denselben Baustein (lib/welcome.js).
 *
 * Wirft nie; -> { ok, sent, email }.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');
const { hasMail } = require('../../lib/mail');
const W = require('../../lib/welcome');

const REASON_MSG = {
  no_mail: 'E-Mail-Versand ist nicht eingerichtet.',
  not_found: 'Mitglied nicht gefunden.',
  no_email: 'Für dieses Mitglied ist keine E-Mail hinterlegt.',
  send_failed: 'E-Mail konnte nicht gesendet werden.',
};

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'member.write', res)) return;
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: REASON_MSG.no_mail })); }

  const b = await M.readBody(req);
  const id = String(b.id || '').trim();
  if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, message: 'Kein Mitglied angegeben.' })); }

  // Anti-Spam: max. 6 Zugangs-Mails je Mitglied pro Stunde.
  if (!(await M.rateLimit('team-accessinfo:' + id, 6, 3600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu oft gesendet – bitte kurz warten.' }));
  }

  const r = await W.sendAccessInfoMail(id);
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: !!r.sent,
    sent: !!r.sent,
    email: r.email || null,
    message: r.sent ? null : (REASON_MSG[r.reason] || 'Konnte nicht gesendet werden.'),
  }));
};
