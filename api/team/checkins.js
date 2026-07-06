'use strict';

/**
 * GET /api/team/checkins?id=<memberId>   (Team-Session erforderlich)
 * Vollständiger Check-in-Verlauf eines Mitglieds für das Team-Backend
 * (Ansicht + Grundlage der Anwesenheitsbestätigung). Nutzt den bereits
 * vorhandenen, 403-sicheren Server-Helfer M.recentCheckins (paginiert,
 * neueste zuerst). Fehlt der Scope (CHECKIN_READ), kommt eine leere Liste
 * zurück – die Karte zeigt dann einfach „0 Besuche". Wirft nie.
 *   -> { ok:true, checkins:[{ in, out, studio }] }
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }

  try {
    // Bis 200 Seiten à 50 (= 10.000 Check-ins), reicht für jeden Zeitraum. Sortiert neueste-zuerst.
    const checkins = await M.recentCheckins(id, { pages: 200 });
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, checkins: checkins }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, checkins: [] }));
  }
};
