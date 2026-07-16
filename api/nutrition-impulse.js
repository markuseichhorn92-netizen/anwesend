'use strict';

/**
 * Vercel Serverless Function · /api/nutrition-impulse
 * ---------------------------------------------------
 * Vom täglichen GitHub-Actions-Cron aufgerufen. Verschickt FINNs Tagesimpuls an
 * eingeschriebene Premium-Mitglieder (Dispatcher lib/coachImpulse.js).
 *
 * Schutz wie /api/nudge: ist RECORD_SECRET gesetzt, muss es als Bearer-Token
 * oder ?secret=... mitkommen.
 */

const { run } = require('../lib/coachImpulse');
const { requireCronAuth } = require('../lib/cronAuth');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (!requireCronAuth(req, res)) return;   // Secret verpflichtend, nur Authorization-Header

  try {
    const r = await run({ force: true });
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, scanned: r.scanned, eligible: r.eligible, sent: r.sent }));
  } catch (e) {
    console.error('[nutrition-impulse]', e.message);
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: 'impulse_failed' }));
  }
};
