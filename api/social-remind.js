'use strict';

/**
 * Vercel Serverless Function · /api/social-remind
 * -----------------------------------------------
 * Vom GitHub-Actions-Cron (record.yml, alle 15 Min) aufgerufen. Verschickt
 * Trainingspartner-Erinnerungen (~100 Min vor der verabredeten Zeit), schreibt
 * nach gelaufenen gemeinsamen Sessions Vitalpunkte gut und pusht sonntagabends
 * das Wochen-Challenge-Ergebnis.
 *
 * Schutz wie /api/record & /api/plan-remind: ist RECORD_SECRET gesetzt, muss es
 * als Bearer-Token oder ?secret=... mitkommen. Degradiert sauber, wirft nie.
 */

const Social = require('../lib/social');

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
    const r = await Social.dispatchReminders({});
    res.statusCode = 200;
    return res.end(JSON.stringify(r));
  } catch (e) {
    console.error('[social-remind]', e && e.message);
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: 'remind_failed' }));
  }
};
