'use strict';

/**
 * GET /api/team/checkins?id=<memberId>   (Team-Session erforderlich)
 * Vollständiger Check-in-Verlauf eines Mitglieds für das Team-Backend
 * (Ansicht + Grundlage der Anwesenheitsbestätigung). Nutzt M.checkinHistory,
 * das die VOLLE Historie holt: Magicline liefert ohne Datumsangabe nur einen
 * Monat, daher läuft der Helfer in <=365-Tage-Fenstern rückwärts. Fehlt der
 * Scope (CHECKIN_READ), kommt eine leere Liste – die Karte zeigt „0 Besuche".
 * Wirft nie.  ->  { ok:true, checkins:[{ in, out, studio }] }
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'checkin.manage', res)) return;
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }

  try {
    // Volle Historie: läuft in <=365-Tage-Fenstern rückwärts. Sortiert neueste-zuerst.
    const checkins = await M.checkinHistory(id, {});
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, checkins: checkins }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, checkins: [] }));
  }
};
