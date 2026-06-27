'use strict';

/**
 * POST /api/contract/create   (VERBINDLICHER Vertragsabschluss)
 * Body: { rateBundleTermId, startDate, paymentChoice, iban, accountHolder,
 *         firstname,lastname,email,phone,gender,dateOfBirth,
 *         street,houseNumber,zipCode,city, confirmedTextBlockIds[], referralCode, marketing }
 * Legt Kunde + Vertrag in Magicline an (POST /connect/v1/rate-bundle).
 * Bei referralCode wird der Werber verknüpft (member-gets-member).
 */

const C = require('../../lib/connect');

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const REQUIRED = ['rateBundleTermId', 'startDate', 'firstname', 'lastname', 'email', 'dateOfBirth', 'street', 'houseNumber', 'zipCode', 'city'];

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  const b = await readBody(req);

  for (const f of REQUIRED) {
    if (!b[f] || !String(b[f]).trim()) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'missing_field', field: f, message: 'Bitte alle Pflichtfelder ausfüllen.' }));
    }
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) {
    res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'invalid_email', message: 'Bitte eine gültige E-Mail angeben.' }));
  }
  const pay = b.paymentChoice || 'DIRECT_DEBIT';
  if (pay === 'DIRECT_DEBIT' && !String(b.iban || '').replace(/\s+/g, '')) {
    res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_iban', message: 'Bitte IBAN angeben.' }));
  }

  try {
    const r = await C.createContract(b);
    if (r.ok) {
      res.statusCode = 200;
      return res.end(JSON.stringify({
        ok: true,
        customerNumber: r.json && r.json.customerNumber || null,
        message: 'Willkommen im Fit-Inn Trier! Dein Vertrag ist abgeschlossen – du erhältst alle Unterlagen per E-Mail.',
      }));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: false,
      message: 'Der Abschluss hat nicht geklappt. Bitte Eingaben prüfen oder später erneut versuchen.',
      detail: String(r.text || '').slice(0, 400),
    }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, message: 'Es ist ein Fehler aufgetreten. Bitte später erneut.' }));
  }
};
