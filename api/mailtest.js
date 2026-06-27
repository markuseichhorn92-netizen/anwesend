'use strict';
/** TEMPORÄR: prüft den Resend-Versand. Aufruf: /api/mailtest?run=1 . Wird danach entfernt. */
const { sendMail, hasMail, TO } = require('../lib/mail');
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (new URL(req.url, 'http://localhost').searchParams.get('run') !== '1') { res.statusCode = 400; return res.end(JSON.stringify({ hint: '?run=1' })); }
  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'RESEND_API_KEY fehlt (in Vercel setzen + redeploy)' })); }
  const r = await sendMail('Testmail · Fit-Inn Mitgliederbereich', 'Test ✅ — wenn diese Mail ankommt, funktioniert der Versand über Resend.');
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: r.ok, status: r.status, to: TO, response: r.body, error: r.error }, null, 2));
};
