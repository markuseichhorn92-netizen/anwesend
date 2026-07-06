'use strict';

/**
 * GET /api/member/checkins   (Authorization: Bearer <token>)
 * Vollständiger Check-in-Verlauf des Mitglieds (CHECKIN_READ), über alle Seiten
 * paginiert – nicht nur die jüngsten/seit-Integration.
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  try {
    // Volle Historie über M.checkinHistory: Magicline liefert ohne fromDate/toDate
    // nur EINEN Monat, deshalb läuft der Helfer in <=365-Tage-Fenstern rückwärts
    // (offset-Paging allein blättert nur innerhalb des Default-Monats).
    const checkins = await M.checkinHistory(sess.id, {});
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, checkins: checkins }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, checkins: [] }));
  }
};
