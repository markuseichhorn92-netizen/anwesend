'use strict';

/**
 * POST /api/trial/book
 *   { firstname,lastname,email,phone,gender,dateOfBirth,
 *     street,houseNumber,zip,city, startDateTime, referralCode, marketing }
 * Bucht ein Probetraining + legt den Lead in Magicline an (Connect API).
 * Bei vorhandenem referralCode wird der Lead dem werbenden Mitglied zugeordnet.
 */

const C = require('../../lib/connect');

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const REQUIRED = ['firstname', 'lastname', 'email', 'phone', 'gender', 'dateOfBirth', 'street', 'houseNumber', 'zip', 'city', 'startDateTime'];

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
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: 'invalid_email', message: 'Bitte eine gültige E-Mail-Adresse angeben.' }));
  }

  try {
    const r = await C.bookTrial(b);
    if (r.ok) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, message: 'Dein Probetraining ist gebucht! Du bekommst eine Bestätigung per E-Mail.' }));
    }
    // Häufigster Fall: Slot zwischenzeitlich vergeben / ungültig
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: false,
      message: 'Buchung hat nicht geklappt – bitte einen anderen Termin wählen oder es später erneut versuchen.',
      detail: String(r.text || '').slice(0, 300),
    }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, message: 'Es ist ein Fehler aufgetreten. Bitte später erneut.' }));
  }
};
