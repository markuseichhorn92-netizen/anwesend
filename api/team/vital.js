'use strict';

/**
 * GET /api/team/vital?id=<memberId>   (Team-Session erforderlich)
 * -------------------------------------------------------------------------
 * Read-only Vital-Check-Bereitschaft eines Mitglieds fürs Team-Backend – NUR wenn
 * das Mitglied das ausdrücklich freigegeben hat (Opt-in) UND die Herzdaten-Einwilligung
 * besteht. Trainer:innen sehen bewusst NUR die aggregierte Ampel, das Übertrainings-Signal
 * und die Wochen-Verteilung – KEINE Rohwerte (Puls/HRV). So können sie ein Mitglied gezielt
 * ansprechen (Übertraining, Erholung), ohne dessen Gesundheitsrohdaten zu sehen.
 *
 * Ohne Freigabe/Einwilligung -> { ok:true, shared:false }. Wirft nie.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const MO = require('../../lib/morning');
const { hasStore } = require('../../lib/store');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'nutrition.manage', res)) return;
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
  if (!hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, shared: false })); }

  try {
    const share = await MO.getTeamShare(id);
    const consent = await MO.getConsent(id);
    if (!share || !consent) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, shared: false })); }
    const list = await MO.list(id);
    if (!list.length) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, shared: true, hasData: false })); }
    const base = MO.baseline(list);
    const latest = list[0];
    const rd = MO.readiness(latest, base);
    const ot = MO.overtraining(list);
    const wk = MO.weeklyReport(list);
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true, shared: true, hasData: true,
      date: latest.date || null,
      readiness: rd ? { level: rd.level, score: rd.score, headline: rd.headline } : null,
      overtraining: ot ? { level: ot.level, note: ot.note } : null,
      weekly: wk ? { gruen: wk.gruen, gelb: wk.gelb, rot: wk.rot, avgScore: wk.avgScore } : null,
    }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, shared: false }));
  }
};
