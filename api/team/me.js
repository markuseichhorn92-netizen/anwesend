'use strict';

/**
 * GET /api/team/me   (Bearer Team-Token)
 * Liefert die Identität der aktuellen Sitzung, damit das Frontend nach einem
 * Reload weiß, WER angemeldet ist und WELCHE Rolle gilt (admin | trainer).
 * Danach richtet sich, welche Bereiche/Aktionen sichtbar sind – die eigentliche
 * Durchsetzung passiert serverseitig in den jeweiligen Endpunkten.
 */

const TA = require('../../lib/teamAuth');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: true,
    role: TA.roleOf(sess),
    name: sess.user || 'Team',
    employeeId: sess.employeeId || null,
  }));
};
