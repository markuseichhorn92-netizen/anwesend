'use strict';

/**
 * TEMPORÄR (nach Gebrauch löschen). GET /api/mailtest2?k=fitinn-probe-2026
 * Testet den Resend-Versand MIT Anhang (kleines Test-PDF) an die Studio-Adresse
 * (MAIL_TO) und gibt die rohe Resend-Antwort zurück. Kein PII, fester Empfänger.
 */

const { sendMailRaw, hasMail, TO } = require('../lib/mail');

// Minimal gültiges PDF (Base64) – nur als Anhang-Test
const TINY_PDF_B64 =
  'JVBERi0xLjEKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBv' +
  'Ymo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlw' +
  'ZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMjAwIDIwMF0+PmVuZG9iagp4cmVmCjAg' +
  'NAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTAgMDAwMDAgbiAKMDAwMDAwMDA1NiAwMDAw' +
  'MCBuIAowMDAwMDAwMTExIDAwMDAwIG4gCnRyYWlsZXI8PC9Sb290IDEgMCBSL1NpemUgND4+CnN0' +
  'YXJ0eHJlZgoxNzgKJSVFT0YK';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('k') !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end('{}'); }

  const out = { hasMail: hasMail, toIsSet: Boolean(TO), envKeyPresent: Boolean(process.env.RESEND_API_KEY), fromEnv: Boolean(process.env.MAIL_FROM) };
  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify(out)); }

  const mail = await sendMailRaw({
    subject: 'Anhang-Test (mailtest2)',
    text: 'Test mit PDF-Anhang.',
    attachments: [{ filename: 'test.pdf', content: TINY_PDF_B64 }],
  });
  out.result = mail;   // { ok, status, body }
  res.statusCode = 200;
  return res.end(JSON.stringify(out, null, 2));
};
