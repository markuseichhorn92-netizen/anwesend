'use strict';

/**
 * Team-Backend: Moderation der Trainingspartner-Community.
 *   GET   -> { ok, enabled, reports:[{by,against,reason,at}], banned:[{id,name,initials}] }
 *   POST { action:'toggle', on }        (Admin) -> Notaus: Feature global an/aus
 *   POST { action:'ban', memberId, on } (Admin) -> Mitglied sperren/entsperren
 *   POST { action:'clear-reports' }             -> Meldungsliste leeren
 *
 * Auth: Team-Session. Notaus + Sperre nur für Admins. Degradiert sauber, wirft nie.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');   // readBody
const Social = require('../../lib/social');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  const j = (o) => { res.statusCode = 200; return res.end(JSON.stringify(o)); };

  async function snap() {
    const [enabled, reports, banned] = await Promise.all([
      Social.socialEnabled().catch(() => true),
      Social.listReports(50).catch(() => []),
      Social.listBanned().catch(() => []),
    ]);
    return { ok: true, enabled: enabled, reports: reports, banned: banned };
  }

  if (req.method === 'GET') return j(await snap());
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  let body = {}; try { body = await M.readBody(req); } catch (e) { body = {}; }
  const action = String(body.action || '');
  const admin = TA.isAdmin(sess);

  try {
    if (action === 'toggle') { if (!admin) return j({ ok: false, error: 'forbidden', message: 'Nur Admins können das Feature schalten.' }); await Social.setSocialEnabled(!!body.on); return j(await snap()); }
    if (action === 'ban') { if (!admin) return j({ ok: false, error: 'forbidden', message: 'Nur Admins können sperren.' }); await Social.setBan(String(body.memberId || ''), !!body.on); return j(await snap()); }
    if (action === 'clear-reports') { await Social.clearReports(); return j(await snap()); }
    return j({ ok: false, error: 'unknown_action' });
  } catch (e) { return j({ ok: false, error: 'server_error' }); }
};
