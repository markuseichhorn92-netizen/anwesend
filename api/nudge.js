'use strict';

/**
 * Vercel Serverless Function · /api/nudge
 * ---------------------------------------
 * Vom täglichen GitHub-Actions-Cron aufgerufen. Verschickt die Reaktivierungs-
 * Push-Nudges („Wir vermissen dich") über den Dispatcher (lib/nudge.js).
 *
 * Schutz wie /api/record: ist RECORD_SECRET gesetzt, muss es als Bearer-Token
 * oder ?secret=... mitkommen.
 */

const { run } = require('../lib/nudge');
const { requireCronAuth } = require('../lib/cronAuth');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (!requireCronAuth(req, res)) return;   // Secret verpflichtend, nur Authorization-Header

  try {
    const r = await run({ force: true });
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, scanned: r.scanned, eligible: r.eligible, sent: r.sent }));
  } catch (e) {
    console.error('[nudge]', e.message);
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: 'nudge_failed' }));
  }
};
