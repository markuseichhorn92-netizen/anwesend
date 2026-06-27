'use strict';
/** TEMP: prüft, ob Resend den Absender (verifizierte Domain) akzeptiert.
 * Sendet eine Test-Mail an MAIL_TO (Studio). Danach entfernen. */
const { sendMailRaw, hasMail, TO } = require('../lib/mail');
module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  const u = require('url').parse(req.url, true);
  if (u.query.k !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'forbidden' })); }
  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_mail_key' })); }
  const to = u.query.to || TO;
  const r = await sendMailRaw({ to: to, subject: 'Resend-Test · Fit-Inn', text: 'Test: Absender-Domain verifiziert? Wenn diese Mail ankommt, funktioniert der Versand.' });
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: r.ok, status: r.status, to: to, body: r.body || r.error || '' }));
};
