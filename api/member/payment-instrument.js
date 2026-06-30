'use strict';

/**
 * POST /api/member/payment-instrument   (Authorization: Bearer <token>)
 *   { paymentRequestToken: "<von Finion Pay erhaltenes Token>" }
 * Ordnet das in der gehosteten Komponente erfasste Zahlungsmittel
 * (Kreditkarte / SEPA) dem eingeloggten Mitglied zu.
 */

const M = require('../../lib/members');
const Pay = require('../../lib/payments');
const Inbox = require('../../lib/inbox');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  let body = {}; try { body = await M.readBody(req); } catch (e) {}
  const tok = String(body.paymentRequestToken || '').trim();
  if (!tok) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'token_missing' })); }

  let r;
  try { r = await Pay.assignInstrument(sess.id, tok); }
  catch (e) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'assign_failed' })); }

  const ok = !!(r && r.status >= 200 && r.status < 300);
  if (ok) {
    try { await Inbox.addVorgang(sess.id, { type: 'iban', subject: 'Zahlungsmittel aktualisiert', systemText: 'Dein Zahlungsmittel wurde aktualisiert.' }); } catch (e) {}
  }
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok, mlStatus: (r && r.status) || 0,
    message: ok ? 'Dein Zahlungsmittel wurde hinterlegt.' : 'Zahlungsmittel konnte nicht gespeichert werden. Bitte später erneut.',
  }));
};
