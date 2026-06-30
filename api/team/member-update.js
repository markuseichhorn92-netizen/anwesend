'use strict';

/**
 * POST /api/team/member-update   (Bearer Team-Token)
 *   { id, street, houseNumber, zipCode, city }
 *
 * Team-Bearbeitung der Mitglieder-Adresse über die Magicline Open API
 * (CUSTOMER_SELF_SERVICE_WRITE, CHANGES_WITHOUT_VERIFICATION). E-Mail/Telefon
 * sind hier bewusst NICHT enthalten – ob die Open API das schreiben kann, ist noch
 * offen; sobald geklärt, lässt sich das hier ergänzen.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await M.readBody(req);
  const id = body.id;
  if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }

  const d = {
    street: String(body.street || '').trim(),
    houseNumber: String(body.houseNumber || '').trim(),
    zipCode: String(body.zipCode || '').trim(),
    city: String(body.city || '').trim(),
    countryCode: 'DE',
  };
  if (!d.street || !d.zipCode || !d.city) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte Straße, PLZ und Ort ausfüllen.' }));
  }

  let r; try { r = await M.writeAddress(id, d); } catch (e) { r = { status: 0 }; }
  if (r.status >= 200 && r.status < 300) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, message: 'Adresse aktualisiert · Magicline' }));
  }
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: false, status: r.status || 0, message: 'Magicline hat die Änderung abgelehnt (Status ' + (r.status || 0) + ').' }));
};
