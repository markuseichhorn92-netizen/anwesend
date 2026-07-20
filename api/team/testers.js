'use strict';

/**
 * Team-Backend: App-Tester (geschlossener Google-Play-Test) verwalten.
 *   GET                                  -> { ok, testers:[{email,name,status,joinedAt,approvedAt}], pending }
 *   POST { action:'approve', email }     -> eine Adresse freischalten + „Du bist dabei"-Mail
 *   POST { action:'approveAll' }         -> alle noch offenen freischalten
 *
 * „Freischalten" schickt dem Tester die zweite E-Mail MIT Beitritts-Link. Voraussetzung:
 * das Studio hat die Adresse zuvor in der Play Console als Tester eingetragen (das kann
 * Google nicht automatisiert werden). Nur für Admins (Studio-Leitung).
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');   // readBody
const Testers = require('../../lib/testers');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'admin.manage', res)) return;

  async function fresh() { try { return await Testers.listTesters(); } catch (e) { return { testers: [], pending: 0 }; } }

  if (req.method === 'GET') {
    const l = await fresh();
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, testers: l.testers, pending: l.pending }));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  if (!Testers.hasStore) {
    const l = await fresh();
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, disabled: true, message: 'Tester-Speicher nicht verfügbar.', testers: l.testers, pending: l.pending }));
  }

  let body = {};
  try { body = await M.readBody(req); } catch (e) { body = {}; }
  const action = body && body.action;

  let result = { approved: [], failed: [] };
  if (action === 'approve') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!email) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'email_required' })); }
    result = await Testers.approve([email]);
  } else if (action === 'approveAll') {
    result = await Testers.approve(null);
  } else {
    res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
  }

  const l = await fresh();
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: true,
    approved: result.approved,
    approvedCount: result.approved.length,
    failed: result.failed,
    testers: l.testers,
    pending: l.pending,
  }));
};
