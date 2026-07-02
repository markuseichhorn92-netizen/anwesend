'use strict';

/**
 * POST /api/team/member-update   (Bearer Team-Token)
 *   { id, street, houseNumber, zipCode, city }   -> Adresse ändern
 *   { id, action:'anonymise' }                   -> DSGVO: Kunde anonymisieren
 *
 * Team-Bearbeitung der Mitglieder-Adresse über die Magicline Open API
 * (CUSTOMER_SELF_SERVICE_WRITE, CHANGES_WITHOUT_VERIFICATION). E-Mail/Telefon
 * sind hier bewusst NICHT enthalten – ob die Open API das schreiben kann, ist noch
 * offen; sobald geklärt, lässt sich das hier ergänzen.
 *
 * Anonymisieren (Scope CUSTOMER_PRIVACY_WRITE): unwiderruflich, Magicline
 * anonymisiert alle personenbezogenen Daten des (archivierten) Kunden.
 * Fehlt der Scope (403) -> { ok:false, error:'forbidden' }, kein harter Fehler.
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

  // ── DSGVO: Kunde anonymisieren ──
  if (body.action === 'anonymise') {
    let r; try { r = await M.ml('PUT', '/customers/' + encodeURIComponent(id) + '/anonymise'); } catch (e) { r = { status: 0 }; }
    res.statusCode = 200;
    if (r.status >= 200 && r.status < 300) {
      return res.end(JSON.stringify({ ok: true, message: 'Mitglied wurde anonymisiert.' }));
    }
    if (r.status === 403) {
      return res.end(JSON.stringify({ ok: false, error: 'forbidden', message: 'Nicht freigeschaltet.' }));
    }
    return res.end(JSON.stringify({ ok: false, status: r.status || 0, message: 'Magicline hat die Anonymisierung abgelehnt (Status ' + (r.status || 0) + '). Hinweis: Anonymisiert werden können nur archivierte Kunden.' }));
  }

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
