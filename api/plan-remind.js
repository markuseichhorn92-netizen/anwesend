'use strict';

/**
 * Vercel Serverless Function · /api/plan-remind
 * ---------------------------------------------
 * Vom GitHub-Actions-Cron aufgerufen (Backup-Trigger). Verschickt die fälligen
 * Vormerk-Erinnerungen über den gemeinsamen Dispatcher (lib/remind.js).
 * Der zuverlässige Haupt-Trigger ist der gedrosselte Piggyback auf /api/plan.
 *
 * Schutz wie /api/record: ist RECORD_SECRET gesetzt, muss es als Bearer-Token
 * oder ?secret=... mitkommen.
 */

const { dispatch } = require('../lib/remind');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const secret = process.env.RECORD_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    const url = new URL(req.url, 'http://localhost');
    const provided = auth.replace(/^Bearer\s+/i, '') || url.searchParams.get('secret') || '';
    if (provided !== secret) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  }

  try {
    const r = await dispatch({ force: true });
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, due: r.due, sent: r.sent }));
  } catch (e) {
    console.error('[plan-remind]', e.message);
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: 'remind_failed' }));
  }
};
