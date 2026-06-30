'use strict';

/**
 * GET /api/bank-info?blz=XXXXXXXX
 * Liefert BIC + Bankname zur deutschen Bankleitzahl (aus lib/blz.json).
 *
 * Bewusst nur die Bankleitzahl (öffentliche Bank-Kennung), NICHT die volle
 * IBAN — damit keine Kontodaten in URLs/Logs landen. Die IBAN-Prüfung selbst
 * passiert clientseitig (Mod-97) und nochmals beim eigentlichen Speichern.
 */

const B = require('../lib/bank');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  let blz = '';
  try { blz = new URL(req.url, 'http://x').searchParams.get('blz') || ''; } catch (e) {}
  blz = String(blz).replace(/\D/g, '').slice(0, 8);
  if (!/^\d{8}$/.test(blz)) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'blz' })); }

  const bank = B.bankByBlz(blz);
  // kurz cachen (Tabelle ändert sich nur vierteljährlich)
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.statusCode = 200;
  return res.end(JSON.stringify(bank ? { ok: true, bic: bank.bic, bankName: bank.bankName } : { ok: false }));
};
