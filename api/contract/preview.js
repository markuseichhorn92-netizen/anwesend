'use strict';

/**
 * POST /api/contract/preview   (unverbindliche Preisvorschau)
 * Body: { rateBundleTermId, startDate, paymentChoice, voucherCode, ...kundendaten }
 * Reicht an POST /connect/v2/preview durch – erzeugt KEINEN Vertrag.
 */

const C = require('../../lib/connect');

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  const b = await readBody(req);
  if (!b.rateBundleTermId) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_rateBundleTermId' })); }

  // Vorschau braucht minimale, aber plausible Kundendaten – Platzhalter falls leer
  const d = Object.assign({
    firstname: b.firstname || 'Vorschau', lastname: b.lastname || 'Vorschau',
    email: b.email || 'vorschau@example.de', dateOfBirth: b.dateOfBirth || '1990-01-01',
    street: b.street || 'Str', houseNumber: b.houseNumber || '1',
    zipCode: b.zipCode || '54290', city: b.city || 'Trier',
    paymentChoice: b.paymentChoice || 'DIRECT_DEBIT',
    accountHolder: b.accountHolder || 'Vorschau', iban: b.iban || 'DE89370400440532013000',
  }, b);

  try {
    const r = await C.previewContract(d);
    if (r.status !== 200 || !r.json) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: false, message: 'Vorschau nicht möglich.', detail: String(r.text || '').slice(0, 200) }));
    }
    const j = r.json;
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true,
      basePrice: j.basePrice,
      discountedBasePrice: j.discountedBasePrice,
      preUseCharge: j.preUseCharge,
      flatFees: (j.flatFeePreviews || []).map((f) => ({ name: f.name, price: f.price, discountedPrice: f.discountedPrice })),
      contractVolume: j.contractVolumeInformation || null,
      voucherType: j.voucherType,
      voucherSuccessMessage: j.voucherSuccessMessage,
      voucherErrorMessage: j.voucherErrorMessage,
      voucherErrorCode: j.voucherErrorCode,
    }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, message: 'Fehler bei der Vorschau.' }));
  }
};
